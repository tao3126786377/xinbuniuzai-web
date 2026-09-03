/* 一局模式（五轮筹码对决）自动化测试：node test/match_test.js
 *
 * 启动独立测试服务器（PORT=3102，ROUND_TIMEOUT_MS=4000，GRACE_MS=5000，
 * TIMEOUT_STRIKES=3，ROUND_CAP_OVERRIDE=6，TEST_TIMEOUT_ACTION=i，TEST_BULLET_CHOICE=1），覆盖：
 *   结算引擎纯函数（finalBullets 全动作对 / 结算 / 比赛结束判定）
 *   → 建房（mode='match'）与选弹协议（非法值拒绝 / 揭晓） → 向后兼容（缺省 single）
 *   → 脚本化 5 轮完整对局（与本地 Game.step + Match 纸面对照，含 x=0 不结算轮与劣势方双倍）
 *   → 步数封顶平局罚金 → 筹码 ≤0 提前结束 → 选弹超时代选与连击共享/清零
 *   → 三态重进（对决中/选弹中/结束后，myPick 保密） → 再战重置
 *
 * 说明：ROUND_TIMEOUT_MS 取 4000 给重进测试留出余地（选弹与出招共用死线，
 * 重进期间死线照走，超时会被代选/代出）。
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const Game = require('../public/js/game.js');
const Match = require('../public/js/match.js');

const PORT = 3102;
const ROUND_TIMEOUT_MS = 4000;
const GRACE_MS = 5000;
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log('  [通过] ' + msg); }
  else { fail++; console.error('  [失败] ' + msg); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------- 测试客户端（与 pvp_test.js 同款） ---------- */
class C {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.history = [];
    this.cursor = 0;
    this.closed = false;
  }
  connect(opts) {
    const self = this;
    return new Promise((resolve, reject) => {
      self.ws = new WebSocket('ws://127.0.0.1:' + PORT, opts || {});
      self.ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        self.history.push(msg);
      });
      self.ws.on('open', resolve);
      self.ws.on('error', err => {
        if (self.ws.readyState !== WebSocket.OPEN) reject(err);
      });
      self.ws.on('close', () => { self.closed = true; });
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  waitFor(type, timeout) {
    const self = this;
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const poll = () => {
        while (self.cursor < self.history.length) {
          const m = self.history[self.cursor++];
          if (m.type === type) { resolve(m); return; }
        }
        if (Date.now() - t0 > (timeout || 5000)) { reject(new Error(self.name + ' 等待 ' + type + ' 超时')); return; }
        setTimeout(poll, 25);
      };
      poll();
    });
  }
  expectError(code, timeout) {
    const self = this;
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const poll = () => {
        while (self.cursor < self.history.length) {
          const m = self.history[self.cursor++];
          if (m.type === 'error' && m.code === code) { resolve(m); return; }
        }
        if (Date.now() - t0 > (timeout || 5000)) { reject(new Error(self.name + ' 等待错误 ' + code + ' 超时')); return; }
        setTimeout(poll, 25);
      };
      poll();
    });
  }
  countType(type) {
    return this.history.filter(m => m.type === type).length;
  }
}

/* ---------- 主流程 ---------- */
async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      ROUND_TIMEOUT_MS: String(ROUND_TIMEOUT_MS),
      GRACE_MS: String(GRACE_MS),
      TIMEOUT_STRIKES: '3',
      ROUND_CAP_OVERRIDE: '6',
      TEST_TIMEOUT_ACTION: 'i',
      TEST_BULLET_CHOICE: '1'
    }),
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let serverErr = '';
  server.stderr.on('data', d => { serverErr += d; });

  for (let i = 0; i < 100; i++) {
    if (await probe()) break;
    await sleep(100);
  }
  if (!(await probe())) {
    console.error('测试服务器未能启动：' + serverErr);
    server.kill();
    process.exit(1);
  }

  try {
    await testMatchEnginePure();
    await testMatchSetup();
    const scripted = await testScriptedFiveRounds();
    await testRematchResetsMatch(scripted.A, scripted.B);
    await testDrawPenaltyAndCap();
    await testEarlyEndUnderdog();
    await testPickTimeoutSharedStrikes();
    await testRejoinMidMatch();
  } catch (e) {
    console.error('\n[异常中断] ' + e.message + '\n' + (e.stack || ''));
    fail++;
  } finally {
    server.kill();
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail === 0 ? 0 : 1);
}

function probe() {
  return new Promise(resolve => {
    const req = http.get('http://127.0.0.1:' + PORT + '/', res => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

/* 建房限流节流：服务器每 IP 建房限 5/min（突发 5），且同 IP 最多 10 个座位。
 * 前 5 次全速，之后每次建房前等待令牌补充（约 12s 一枚，取 13s 留余量）；
 * 配合 cleanup() 及时删除旧房间释放座位额度。 */
let createCount = 0;
async function createRoomPaced(client, mode) {
  createCount++;
  if (createCount > 5) await sleep(13000);
  client.send(mode === 'match'
    ? { type: 'create_room', mode: 'match' }
    : { type: 'create_room' });
  return client.waitFor('room_created');
}

/* 测试收尾：双方离开房间 → 房间即时删除（释放每 IP 座位额度） */
async function cleanup(A, B) {
  try { A.send({ type: 'leave_room' }); } catch (e) { /* 连接已死则忽略 */ }
  try { B.send({ type: 'leave_room' }); } catch (e) { /* 连接已死则忽略 */ }
  await sleep(150);
}

/* 建房 + 加入 + 等待开局（match 模式），返回 {A, B, code, created, joined, gsA, gsB} */
async function setupMatch(nameA, nameB) {
  const A = new C(nameA), B = new C(nameB);
  await A.connect(); await B.connect();
  const created = await createRoomPaced(A, 'match');
  B.send({ type: 'join_room', code: created.code });
  const joined = await B.waitFor('room_joined');
  const gsA = await A.waitFor('game_started');
  const gsB = await B.waitFor('game_started');
  return { A, B, code: created.code, created, joined, gsA, gsB };
}

/* 提交双方选弹并等待揭晓，返回 {revA, revB} */
async function pickBoth(A, B, pickA, pickB) {
  A.send({ type: 'submit_bullets', bullets: pickA });
  B.send({ type: 'submit_bullets', bullets: pickB });
  const revA = await A.waitFor('bullet_reveal');
  const revB = await B.waitFor('bullet_reveal');
  return { revA, revB };
}

/* 从 (picks) 起按 moves 脚本打完一轮对决（最后一步必须终局）。
 * 返回终局 round_result 与终局动作对信息（供纸面对照）。 */
async function playRound(A, B, picks, moves) {
  const rev = await pickBoth(A, B, picks[0], picks[1]);
  let b1 = picks[0], b2 = picks[1];
  let preB1 = b1, preB2 = b2;
  let a1 = -1, a2 = -1, winner = -1, rr = null;
  for (const [ma, mb] of moves) {
    preB1 = b1; preB2 = b2;
    a1 = Game.charToAction(ma); a2 = Game.charToAction(mb);
    A.send({ type: 'submit_action', action: ma });
    B.send({ type: 'submit_action', action: mb });
    rr = await A.waitFor('round_result', 3000);
    const r = Game.step(b1, b2, a1, a2);
    winner = r.winner;
    b1 = r.b1; b2 = r.b2;
    if (winner !== -1) break;
  }
  return { revA: rev.revA, rr, winner, preB1, preB2, a1, a2, endB1: b1, endB2: b2 };
}

/* 对终局 round_result 做纸面对照（m1/m2 = 轮前筹码，matchRound = 当前轮次），
 * 返回 Match.checkMatchOver 结果（供断言 nextPhase 用）。 */
function verifySettlement(rr, picks, m1, m2, matchRound, tag) {
  const fb = Match.finalBullets(rr.preB1, rr.preB2, rr.a1, rr.a2, rr.winner);
  const s = Match.settleRoundMoney(m1, m2, picks[0], picks[1], rr.winner, fb.b1, fb.b2);
  const t = Match.checkMatchOver(s.money1, s.money2, matchRound);
  check(rr.rr.settled === s.settled, tag + ' settled=' + s.settled);
  check(rr.rr.money[0] === s.money1 && rr.rr.money[1] === s.money2,
    tag + ' 筹码 (' + s.money1 + ',' + s.money2 + ')');
  if (rr.winner !== 0 && s.settled) {
    check(rr.rr.x === s.x && rr.rr.y === s.y && rr.rr.A === s.A &&
      rr.rr.double === s.double && rr.rr.transfer === s.transfer,
      tag + ' x/y/A/double/transfer = ' + s.x + '/' + s.y + '/' + s.A + '/' + s.double + '/' + s.transfer);
  }
  check(rr.rr.matchOver === t.over, tag + ' matchOver=' + t.over);
  return t;
}

/* ---------- 1. 结算引擎纯函数 ---------- */
function testMatchEnginePure() {
  console.log('== 结算引擎纯函数 ==');

  // finalBullets：9 种动作对的末弹规则
  let fb = Match.finalBullets(1, 0, Game.ACT_U, Game.ACT_O, 1);
  check(fb.b1 === 0 && fb.b2 === 0, '瞬间胜负 (u,o)：开枪 -1 执行、被打中装弹不执行 → (0,0)');
  const st = Game.step(1, 0, Game.ACT_U, Game.ACT_O);
  check(st.winner === 1 && st.b1 === 1, '对照：Game.step 瞬间胜负子弹不变（本引擎有意不同）');
  fb = Match.finalBullets(0, 1, Game.ACT_O, Game.ACT_U, 2);
  check(fb.b1 === 0 && fb.b2 === 0, '瞬间胜负 (o,u) 对称 → (0,0)');
  fb = Match.finalBullets(4, 4, Game.ACT_I, Game.ACT_O, 2);
  check(fb.b1 === 4 && fb.b2 === 5, '装弹致胜 (i,o)：胜者 +1 执行');
  fb = Match.finalBullets(4, 4, Game.ACT_O, Game.ACT_I, 1);
  check(fb.b1 === 5 && fb.b2 === 4, '装弹致胜 (o,i) 对称');
  fb = Match.finalBullets(6, 2, Game.ACT_U, Game.ACT_I, 1);
  check(fb.b1 === 5 && fb.b2 === 2, '开枪致胜 (u,i)：败者未装弹');
  fb = Match.finalBullets(6, 4, Game.ACT_U, Game.ACT_U, 1);
  check(fb.b1 === 5 && fb.b2 === 3, '(u,u) 致胜：双方开枪者 -1 都执行');
  fb = Match.finalBullets(4, 3, Game.ACT_O, Game.ACT_O, 1);
  check(fb.b1 === 5 && fb.b2 === 4, '(o,o) 致胜：败者装弹未中枪 → 都执行');
  fb = Match.finalBullets(9, 9, Game.ACT_O, Game.ACT_O, 0);
  check(fb.b1 === 10 && fb.b2 === 10, '(o,o) 双 10 平局：双方装弹都执行');

  // settleRoundMoney
  let s = Match.settleRoundMoney(50, 50, 2, 1, 0, 0, 0);
  check(s.money1 === 40 && s.money2 === 45, '平局罚金：各 -5×自选子弹（2→-10、1→-5）');
  s = Match.settleRoundMoney(50, 50, 1, 0, 1, 0, 0);
  check(s.settled === false && s.money1 === 50 && s.money2 === 50, 'x=0 不结算（钱不变）');
  s = Match.settleRoundMoney(50, 50, 2, 2, 1, 1, 2);
  check(s.x === 1 && s.y === 9 && s.A === 2 && s.double === true && s.transfer === 18 &&
    s.money1 === 68 && s.money2 === 32, '劣势方胜双倍：y=9 → ±18');
  s = Match.settleRoundMoney(50, 50, 2, 0, 1, 5, 0);
  check(s.x === 5 && s.y === 15 && s.double === false && s.money1 === 65 && s.money2 === 35,
    'A 胜常规：y=(3)(1)(5)=15');
  s = Match.settleRoundMoney(50, 50, 0, 2, 2, 0, 3);
  check(s.x === 3 && s.y === 9 && s.money1 === 41 && s.money2 === 59, 'i=0 乘数：y=(1)(3)(3)=9');

  // checkMatchOver
  check(Match.checkMatchOver(0, 0, 3).over === true && Match.checkMatchOver(0, 0, 3).winner === 0,
    '双方同时 ≤0 且相等 → 平局');
  check(Match.checkMatchOver(-5, -10, 3).winner === 1, '双方同时 ≤0 不等 → 钱多者胜');
  check(Match.checkMatchOver(30, -5, 2).winner === 1, '单方 ≤0 提前结束');
  check(Match.checkMatchOver(60, 40, 5).over === true && Match.checkMatchOver(60, 40, 5).winner === 1,
    '5 轮后比钱');
  check(Match.checkMatchOver(50, 50, 5).winner === 0, '5 轮后相等 → 平局');
  check(Match.checkMatchOver(50, 50, 3).over === false, '未满 5 轮且双方 >0 → 继续');
}

/* ---------- 2. 建房与选弹协议 + 向后兼容 ---------- */
async function testMatchSetup() {
  console.log('== 建房（match）/ 选弹校验 / 揭晓 / 向后兼容 ==');
  const { A, B, gsA } = await setupMatch('MA', 'MB');
  check(gsA.mode === 'match' && gsA.phase === 'pick' && gsA.matchRound === 1, '开局进入第 1 轮选弹阶段');
  check(gsA.money[0] === 50 && gsA.money[1] === 50, '开局筹码 50/50');

  A.send({ type: 'submit_bullets', bullets: 3 });
  await A.expectError('invalid_bullets');
  check(true, '选弹 3 被拒绝');
  A.send({ type: 'submit_bullets', bullets: -1 });
  await A.expectError('invalid_bullets');
  check(true, '选弹 -1 被拒绝');
  B.send({ type: 'submit_bullets', bullets: 'x' });
  await B.expectError('invalid_bullets');
  check(true, '选弹非数字被拒绝');
  A.send({ type: 'submit_bullets', bullets: 1 });
  A.send({ type: 'submit_bullets', bullets: 0 });
  await A.expectError('already_submitted');
  check(true, '重复选弹被拒绝');
  B.send({ type: 'submit_bullets', bullets: 0 });
  const revA = await A.waitFor('bullet_reveal');
  const revB = await B.waitFor('bullet_reveal');
  check(revA.picks[0] === 1 && revA.picks[1] === 0, '双方选弹齐 → 揭晓 [1,0]');
  check(revA.b1 === 1 && revA.b2 === 0, '该轮从 (1,0) 开局');
  check(revB.picks[0] === 1 && revB.picks[1] === 0, '双方收到相同揭晓');

  // 向后兼容：缺省 mode → single
  const A2 = new C('MSA'), B2 = new C('MSB');
  await A2.connect(); await B2.connect();
  const created = await createRoomPaced(A2, 'single');
  check(created.mode === 'single', '缺省建房 mode=single');
  B2.send({ type: 'join_room', code: created.code });
  await B2.waitFor('room_joined');
  const gs2 = await A2.waitFor('game_started');
  check(gs2.mode === 'single' && gs2.phase === undefined && gs2.money === undefined,
    '一轮开局无 match 字段（协议不变）');
  await cleanup(A, B);
  await cleanup(A2, B2);
}

/* ---------- 3. 脚本化 5 轮完整对局 ---------- */
async function testScriptedFiveRounds() {
  console.log('== 脚本化 5 轮对局（纸面对照，含 x=0 与双倍） ==');
  const { A, B } = await setupMatch('SA', 'SB');
  let m1 = 50, m2 = 50;

  // 第 1 轮：picks (2,2)，(o,o)(o,o)(o,i) → b1 装弹到 5 胜
  let r1 = await playRound(A, B, [2, 2], [['o', 'o'], ['o', 'o'], ['o', 'i']]);
  let t1 = verifySettlement(r1, [2, 2], m1, m2, 1, '第1轮');
  check(r1.winner === 1, '第 1 轮 b1 装弹致胜');
  check(r1.rr.nextPhase === 'pick' && r1.rr.nextMatchRound === 2 && t1.over === false, '第 1 轮后进入第 2 轮选弹');
  m1 = 59; m2 = 41;

  // 第 2 轮：picks (1,0)，(u,o) → 瞬间胜但 x=0，不结算
  let r2 = await playRound(A, B, [1, 0], [['u', 'o']]);
  check(r2.winner === 1 && r2.rr.settled === false, '第 2 轮 x=0：获胜但不结算');
  check(r2.rr.money[0] === 59 && r2.rr.money[1] === 41, 'x=0 轮筹码不变');
  check(r2.rr.nextPhase === 'pick' && r2.rr.nextMatchRound === 3, 'x=0 轮次照耗，进入第 3 轮');

  // 第 3 轮：picks (0,2)，(o,o)(u,o) → 劣势方 b1 瞬间胜，双倍
  let r3 = await playRound(A, B, [0, 2], [['o', 'o'], ['u', 'o']]);
  let t3 = verifySettlement(r3, [0, 2], 59, 41, 3, '第3轮');
  check(r3.rr.x === 3 && r3.rr.A === 2 && r3.rr.double === true && r3.rr.transfer === 18,
    '第 3 轮劣势方双倍：x=3, y=9, ±18');
  m1 = 77; m2 = 23;

  // 第 4 轮：picks (2,2)，(o,o)(u,o) → 双倍 +18
  let r4 = await playRound(A, B, [2, 2], [['o', 'o'], ['u', 'o']]);
  verifySettlement(r4, [2, 2], m1, m2, 4, '第4轮');
  check(r4.rr.money[0] === 95 && r4.rr.money[1] === 5, '第 4 轮筹码 (95,5)');
  m1 = 95; m2 = 5;

  // 第 5 轮：picks (1,1)，(o,o)×3 + (o,i) → b1 胜，y=4
  let r5 = await playRound(A, B, [1, 1], [['o', 'o'], ['o', 'o'], ['o', 'o'], ['o', 'i']]);
  let t5 = verifySettlement(r5, [1, 1], m1, m2, 5, '第5轮');
  check(r5.rr.x === 1 && r5.rr.y === 4 && r5.rr.double === false && r5.rr.money[0] === 99 && r5.rr.money[1] === 1,
    '第 5 轮常规结算：y=4 → (99,1)');
  check(t5.over === true && r5.rr.matchOver === true, '第 5 轮后比赛结束');
  const goA = await A.waitFor('game_over', 3000);
  const goB = await B.waitFor('game_over', 3000);
  check(goA.reason === 'match_end' && goA.result === 'win', 'A 胜（match_end）');
  check(goB.result === 'lose', 'B 负');
  check(goA.rounds === 5 && goA.money[0] === 99 && goA.money[1] === 1, 'game_over 附带轮数与最终筹码');
  return { A, B };
}

/* ---------- 4. 步数封顶平局罚金 ---------- */
async function testDrawPenaltyAndCap() {
  console.log('== 步数封顶平局（-5×自选子弹） ==');
  const { A, B } = await setupMatch('DA', 'DB');
  await pickBoth(A, B, 2, 2);
  for (let i = 0; i < 5; i++) {
    A.send({ type: 'submit_action', action: 'i' });
    B.send({ type: 'submit_action', action: 'i' });
    const rr = await A.waitFor('round_result', 3000);
    check(rr.outcome === 'continue', '第 ' + (i + 1) + ' 步继续');
  }
  A.send({ type: 'submit_action', action: 'i' });
  B.send({ type: 'submit_action', action: 'i' });
  const rr = await A.waitFor('round_result', 3000);
  check(rr.outcome === 'draw' && rr.capped === true, '第 6 步封顶 → 轮平局');
  check(rr.drawPenalty[0] === 10 && rr.drawPenalty[1] === 10, '罚金各 -5×2=-10');
  check(rr.money[0] === 40 && rr.money[1] === 40, '筹码 40/40');
  check(rr.nextPhase === 'pick' && rr.nextMatchRound === 2, '进入第 2 轮选弹');
  await cleanup(A, B);
}

/* ---------- 5. 筹码 ≤0 提前结束（劣势方双倍集成） ---------- */
async function testEarlyEndUnderdog() {
  console.log('== 劣势方双倍连赢 → 筹码 ≤0 提前结束 ==');
  const { A, B } = await setupMatch('EA', 'EB');
  for (let r = 1; r <= 3; r++) {
    const rr = await playRound(A, B, [2, 2], [['o', 'o'], ['u', 'o']]);
    if (r === 1) check(rr.rr.money[0] === 68 && rr.rr.money[1] === 32, '第 1 轮 (68,32)');
    if (r === 2) check(rr.rr.money[0] === 86 && rr.rr.money[1] === 14, '第 2 轮 (86,14)');
    if (r === 3) {
      check(rr.rr.money[0] === 104 && rr.rr.money[1] === -4, '第 3 轮 (104,-4)');
      check(rr.rr.matchOver === true && rr.rr.matchWinner === 1, '第 3 轮后一方 ≤0 立即结束');
    }
  }
  const goA = await A.waitFor('game_over', 3000);
  const goB = await B.waitFor('game_over', 3000);
  check(goA.result === 'win' && goA.reason === 'match_end' && goA.rounds === 3, '提前结束：A 胜，轮数 3');
  check(goB.money[0] === 104 && goB.money[1] === -4, '最终筹码 (104,-4)');
  await cleanup(A, B);
}

/* ---------- 6. 选弹超时代选 + 连击共享/清零 ---------- */
async function testPickTimeoutSharedStrikes() {
  console.log('== 选弹超时代选 / 连击共享（选弹+出招） / 判负 ==');

  // 房间 1：双方选弹超时 → 代选 → 出招超时继续累积 → 3 连判负
  const { A, B } = await setupMatch('TA', 'TB');
  const n1 = await A.waitFor('timeout_notice', ROUND_TIMEOUT_MS + 3000);
  check(n1.phase === 'pick' && n1.pick === 1 && n1.timeoutStrikes[n1.seat] === 1, '选弹超时代选 1（TEST_BULLET_CHOICE）');
  const rev = await A.waitFor('bullet_reveal', 3000);
  check(rev.picks[0] === 1 && rev.picks[1] === 1, '双方代选揭晓 [1,1]');
  check(rev.timeoutStrikes[0] === 1 && rev.timeoutStrikes[1] === 1, '选弹超时连击 [1,1]');

  // 对决第 1 回合：A 准时（清连击），B 超时 → [0,2]
  A.send({ type: 'submit_action', action: 'i' });
  await A.waitFor('timeout_notice', ROUND_TIMEOUT_MS + 3000);
  const rr1 = await A.waitFor('round_result', 3000);
  check(rr1.timeoutStrikes[0] === 0 && rr1.timeoutStrikes[1] === 2, 'A 准时清零、B 出招超时 → [0,2]（连击共享）');

  // 对决第 2 回合：B 第 3 次超时 → 判负（无 round_result）
  A.send({ type: 'submit_action', action: 'i' });
  await A.waitFor('timeout_notice', ROUND_TIMEOUT_MS + 3000);
  const goA = await A.waitFor('game_over', 3000);
  const goB = await B.waitFor('game_over', 3000);
  check(goA.result === 'win' && goA.reason === 'timeout_loss', 'B 选弹1+出招2 连续超时 → A 胜');
  check(goB.result === 'lose', 'B 判负');
  check(A.countType('round_result') === 1, '判负回合无 round_result（连击先于结算）');

  // 房间 2：反向清零——B 出招超时留下的连击由 B 下一轮准时选弹清零
  // （出招超时 2 次不判负（<3），对决由 A 装弹致胜结束，B 带着连击进入下一轮选弹）
  const { A: A2, B: B2 } = await setupMatch('TA2', 'TB2');
  const rev0 = await pickBoth(A2, B2, 2, 2);
  check(rev0.revA.timeoutStrikes[0] === 0 && rev0.revA.timeoutStrikes[1] === 0, '房间2 双方准时选弹 [0,0]');
  // 对决 (2,2)：A 装弹 3 步致胜，B 后两步出招超时 → 终局时 B 连击 2
  A2.send({ type: 'submit_action', action: 'o' });
  B2.send({ type: 'submit_action', action: 'i' });
  const rr21 = await A2.waitFor('round_result', 3000);
  check(rr21.outcome === 'continue', '房间2 第 1 步继续 (3,2)');
  A2.send({ type: 'submit_action', action: 'o' });
  await A2.waitFor('timeout_notice', ROUND_TIMEOUT_MS + 3000);
  const rr22 = await A2.waitFor('round_result', 3000);
  check(rr22.outcome === 'continue' && rr22.timeoutStrikes[1] === 1, '房间2 第 2 步 B 出招超时 → [0,1]');
  A2.send({ type: 'submit_action', action: 'o' });
  await A2.waitFor('timeout_notice', ROUND_TIMEOUT_MS + 3000);
  const rr23 = await A2.waitFor('round_result', 3000);
  check(rr23.outcome === 'p1_win' && rr23.timeoutStrikes[1] === 2, '房间2 第 3 步 A 装弹致胜，B 连击 2（未达 3 不判负）');
  check(rr23.nextPhase === 'pick' && rr23.money[0] === 77 && rr23.money[1] === 23, '结算 (77,23) 进入下一轮选弹');

  // 下一轮选弹：B 准时提交 → 出招超时连击被选弹清零（计数器共享双向）
  const revB = await pickBoth(A2, B2, 0, 2);
  check(revB.revA.timeoutStrikes[0] === 0 && revB.revA.timeoutStrikes[1] === 0, 'B 准时选弹清零 [0,0]（共享计数器）');
  check(revB.revA.picks[0] === 0 && revB.revA.picks[1] === 2, '第 2 轮揭晓 [0,2]');

  // 快速收尾：B 开枪打中装弹的 A → B 胜（x=1、A=2、y=3，常规赔付）
  A2.send({ type: 'submit_action', action: 'o' });
  B2.send({ type: 'submit_action', action: 'u' });
  const rrX = await A2.waitFor('round_result', 3000);
  check(rrX.outcome === 'p2_win' && rrX.x === 1 && rrX.A === 2 && rrX.y === 3 && rrX.double === false,
    'B 胜常规结算 x=1/y=3');
  check(rrX.money[0] === 74 && rrX.money[1] === 26, '筹码 (74,26)');

  // 第 3 轮选弹：A 超时代选 → A 连击 1（各座位独立累计）
  B2.send({ type: 'submit_bullets', bullets: 1 });
  await A2.waitFor('timeout_notice', ROUND_TIMEOUT_MS + 3000);
  const revA2 = await A2.waitFor('bullet_reveal', 3000);
  check(revA2.picks[0] === 1 && revA2.picks[1] === 1, '第 3 轮揭晓 [1,1]');
  check(revA2.timeoutStrikes[0] === 1 && revA2.timeoutStrikes[1] === 0, 'A 选弹超时连击 1、B 保持 0（座位独立）');
  await cleanup(A, B);
  await cleanup(A2, B2);
}

/* ---------- 7. 三态重进（对决中 / 选弹中 / 结束后） ---------- */
async function testRejoinMidMatch() {
  console.log('== 三态重进与 myPick 保密 ==');
  const { A, B, code, created, joined } = await setupMatch('RA', 'RB');
  await pickBoth(A, B, 2, 2);
  A.send({ type: 'submit_action', action: 'i' });
  B.send({ type: 'submit_action', action: 'i' });
  await A.waitFor('round_result', 3000);   // 对决进行中（第 2 步）

  // 态 1：对决中重进
  B.ws.terminate();
  await A.waitFor('opponent_left', 3000);
  const B2 = new C('RB2'); await B2.connect();
  B2.send({ type: 'rejoin', code, seat: 1, token: joined.token });
  const rs1 = await B2.waitFor('room_state', 3000);
  check(rs1.mode === 'match' && rs1.phase === 'play' && rs1.status === 'playing', '对决中重进：phase=play');
  check(rs1.b1 === 2 && rs1.b2 === 2 && rs1.round === 2, '对决中重进：状态 (2,2) 第 2 步');
  check(rs1.money[0] === 50 && rs1.picks[0] === 2 && rs1.picks[1] === 2, '对决中重进：筹码与选弹同步');
  await A.waitFor('opponent_rejoined', 3000);

  // 打完本轮：A 装弹致胜
  A.send({ type: 'submit_action', action: 'o' });
  B2.send({ type: 'submit_action', action: 'o' });
  await A.waitFor('round_result', 3000);
  A.send({ type: 'submit_action', action: 'o' });
  B2.send({ type: 'submit_action', action: 'o' });
  await A.waitFor('round_result', 3000);
  A.send({ type: 'submit_action', action: 'o' });
  B2.send({ type: 'submit_action', action: 'i' });
  const rrT = await A.waitFor('round_result', 3000);
  check(rrT.outcome === 'p1_win' && rrT.money[0] === 59 && rrT.money[1] === 41, '第 1 轮结算 (59,41)');
  check(rrT.nextPhase === 'pick' && rrT.nextMatchRound === 2, '进入第 2 轮选弹');

  // 态 2：选弹中重进（A 已选 1，B 未选）
  A.send({ type: 'submit_bullets', bullets: 1 });
  B2.ws.terminate();
  const B3 = new C('RB3'); await B3.connect();
  B3.send({ type: 'rejoin', code, seat: 1, token: joined.token });
  const rs2 = await B3.waitFor('room_state', 3000);
  check(rs2.phase === 'pick' && rs2.matchRound === 2, '选弹中重进：phase=pick 第 2 轮');
  check(rs2.b1 === 0 && rs2.b2 === 0, '选弹阶段子弹归零（不继承上轮终弹）');
  check(rs2.money[0] === 59 && rs2.money[1] === 41, '选弹中重进：筹码同步');
  check(rs2.myPick === undefined, 'B 侧不泄露 A 已选的值（myPick 无）');
  check(rs2.bulletActed[0] === true && rs2.bulletActed[1] === false, 'bulletActed 反映双方提交状态');
  check(rs2.matchHistory.length === 1 && rs2.matchHistory[0].matchRound === 1 &&
    rs2.matchHistory[0].money[0] === 59, '重进携带每轮结算摘要');

  // A 侧重进：恢复自己的选择
  A.ws.terminate();
  const A2 = new C('RA2'); await A2.connect();
  A2.send({ type: 'rejoin', code, seat: 0, token: created.token });
  const rs3 = await A2.waitFor('room_state', 3000);
  check(rs3.myPick === 1, 'A 侧重进恢复自己已选的值 myPick=1');

  // 收尾：B 选 0 → 揭晓 → 快速打完比赛
  B3.send({ type: 'submit_bullets', bullets: 0 });
  const revF = await A2.waitFor('bullet_reveal', 3000);
  check(revF.picks[0] === 1 && revF.picks[1] === 0, '第 2 轮揭晓 [1,0]');
  // 第 2 轮 x=0 不结算
  A2.send({ type: 'submit_action', action: 'u' });
  B3.send({ type: 'submit_action', action: 'o' });
  const rrX = await A2.waitFor('round_result', 3000);
  check(rrX.settled === false && rrX.money[0] === 59, '第 2 轮 x=0 不结算');
  // 第 3~5 轮双倍连赢 → 结束
  for (let r = 3; r <= 5; r++) {
    const rrD = await playRound(A2, B3, [2, 2], [['o', 'o'], ['u', 'o']]);
    if (r === 5) check(rrD.rr.matchOver === true && rrD.rr.money[0] === 113 && rrD.rr.money[1] === -13,
      '第 5 轮结束 (113,-13)');
  }
  await A2.waitFor('game_over', 3000);
  await B3.waitFor('game_over', 3000);

  // 态 3：结束后重进
  B3.ws.terminate();
  const B4 = new C('RB4'); await B4.connect();
  B4.send({ type: 'rejoin', code, seat: 1, token: joined.token });
  const rs4 = await B4.waitFor('room_state', 3000);
  check(rs4.status === 'finished' && rs4.lastGameOver !== null, '结束后重进：finished + lastGameOver');
  check(rs4.lastGameOver.reason === 'match_end' && rs4.lastGameOver.result === 'lose',
    '结束后重进：结果同步（B 负）');
  check(rs4.lastGameOver.money[0] === 113 && rs4.lastGameOver.money[1] === -13, '结束后重进：最终筹码同步');
  await cleanup(A2, B4);
}

/* ---------- 8. 再战重置（复用脚本对局的房间，finished → 再战 → 全量重置） ---------- */
async function testRematchResetsMatch(A, B) {
  console.log('== 再战重置比赛 ==');
  A.send({ type: 'rematch_vote', accept: true });
  await A.waitFor('rematch_status', 3000);
  B.send({ type: 'rematch_vote', accept: true });
  const gsA = await A.waitFor('game_started', 3000);
  const gsB = await B.waitFor('game_started', 3000);
  check(gsA.mode === 'match' && gsA.phase === 'pick' && gsA.matchRound === 1, '再战回到第 1 轮选弹');
  check(gsA.money[0] === 50 && gsA.money[1] === 50, '再战筹码重置 50/50');
  check(gsA.timeoutStrikes[0] === 0 && gsA.timeoutStrikes[1] === 0, '再战连击清零');
  check(gsB.phase === 'pick', '双方同步');
  await cleanup(A, B);
}

main();
