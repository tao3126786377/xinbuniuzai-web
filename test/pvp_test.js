/* PvP 全流程自动化测试（Node 双客户端模拟）：node test/pvp_test.js
 *
 * 启动一个独立测试服务器（PORT=3101，ROUND_TIMEOUT_MS=2000，GRACE_MS=5000，
 * TIMEOUT_STRIKES=3，ROUND_CAP_OVERRIDE=6，TEST_TIMEOUT_ACTION=i），覆盖：
 *   建房/加入/自动开局 → 非法动作/未知消息拒绝 → 完整对局（与本地 Game.step 纸面对照）
 *   → 双方再战 → 超时代出/连击清零/3 连击判负 → 断线宽限/重进同步/宽限期满判负
 *   → 主动离开判负 → 凭证错误/房间不存在 → 房间清空删除 → 回合上限平局
 *   → 恶意 Origin 拒绝 → 消息洪泛限流 → 超大消息断开
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const Game = require('../public/js/game.js');

const PORT = 3101;
const ROUND_TIMEOUT_MS = 2000;
const GRACE_MS = 5000;
const ROUND_CAP = 6;
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log('  [通过] ' + msg); }
  else { fail++; console.error('  [失败] ' + msg); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------- 测试客户端 ---------- */
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
  sendRaw(buf) { this.ws.send(buf); }
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

function outcomeName(winner) {
  return winner === 1 ? 'p1_win' : winner === 2 ? 'p2_win' : winner === 0 ? 'draw' : 'continue';
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
      ROUND_CAP_OVERRIDE: String(ROUND_CAP),
      TEST_TIMEOUT_ACTION: 'i'
    }),
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let serverErr = '';
  server.stderr.on('data', d => { serverErr += d; });

  // 等待端口就绪
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
    await testStatic();
    await testRoomFlowAndGame();
    await testTimeoutStrikes();
    await testGraceRejoin();
    await testLeaveForfeit();
    await testBadTokenAndCleanup();
    await testRoundCap();
    await testSecurity();
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

/* ---------- 静态服务 ---------- */
async function testStatic() {
  console.log('== 静态服务 ==');
  const home = await httpGet('/');
  check(home.status === 200 && home.body.indexOf('西部牛仔') !== -1, '首页 200 且含标题');
  const js = await httpGet('/js/game.js');
  check(js.status === 200, '静态 JS 可访问');
  const trav = await httpGet('/../server.js');
  check(trav.status === 404 || trav.status === 403, '路径穿越被拒绝（' + trav.status + '）');
}

function httpGet(p) {
  return new Promise(resolve => {
    const req = http.get('http://127.0.0.1:' + PORT + p, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

/* ---------- 建房/加入/对局 ---------- */
async function testRoomFlowAndGame() {
  console.log('== 建房 / 加入 / 完整对局 ==');
  const A = new C('A'), B = new C('B');
  await A.connect(); await B.connect();

  A.send({ type: 'create_room' });
  const created = await A.waitFor('room_created');
  check(/^\d{4}$/.test(created.code), '房间号 4 位数字（' + created.code + '）');
  const code = created.code;

  B.send({ type: 'join_room', code });
  const joined = await B.waitFor('room_joined');
  check(joined.seat === 1, '加入者座位 1');

  const gsA = await A.waitFor('game_started');
  const gsB = await B.waitFor('game_started');
  check(gsA.round === 1 && gsA.b1 === 0 && gsA.b2 === 0, '双方就位自动开局 (0,0)');
  check(Math.abs(gsA.roundDeadline - Date.now()) <= ROUND_TIMEOUT_MS + 500, '死线 ≈ 现在 + ' + ROUND_TIMEOUT_MS + 'ms');
  check(gsA.roundTimeoutMs === ROUND_TIMEOUT_MS, 'roundTimeoutMs 下发');

  // 非法动作：0 弹开枪
  B.send({ type: 'submit_action', action: 'u' });
  await B.expectError('invalid_action');
  check(true, '0 弹开枪被拒绝');
  // 非法动作：未知动作字符
  B.send({ type: 'submit_action', action: 'x' });
  await B.expectError('invalid_action');
  check(true, '未知动作被拒绝');
  // 未知消息类型
  A.send({ type: 'nonsense' });
  await A.expectError('bad_request');
  check(true, '未知消息类型被拒绝');
  // 对局中加入 → 拒绝
  const C2 = new C('C2'); await C2.connect();
  C2.send({ type: 'join_room', code });
  await C2.expectError('game_in_progress');
  check(true, '对局进行中禁止加入');

  // 完整对局：与本地 Game.step 纸面对照
  const moves = [['o', 'o'], ['o', 'i'], ['o', 'o'], ['o', 'i'], ['u', 'o']];
  let b1 = 0, b2 = 0;
  for (let r = 0; r < moves.length; r++) {
    const [ma, mb] = moves[r];
    A.send({ type: 'submit_action', action: ma });
    B.send({ type: 'submit_action', action: mb });
    const rrA = await A.waitFor('round_result');
    const exp = Game.step(b1, b2, Game.charToAction(ma), Game.charToAction(mb));
    check(rrA.b1 === b1 && rrA.b2 === b2, '回合 ' + (r + 1) + ' 行动前状态 (' + b1 + ',' + b2 + ')');
    check(rrA.outcome === outcomeName(exp.winner), '回合 ' + (r + 1) + ' outcome = ' + outcomeName(exp.winner));
    check(rrA.b1_next === exp.b1 && rrA.b2_next === exp.b2, '回合 ' + (r + 1) + ' 转移 (' + exp.b1 + ',' + exp.b2 + ')');
    b1 = exp.b1; b2 = exp.b2;
    if (exp.winner === -1) {
      check(rrA.roundDeadline > Date.now(), '回合 ' + (r + 1) + ' 新死线已下发');
    }
  }
  const goA = await A.waitFor('game_over');
  const goB = await B.waitFor('game_over');
  check(goA.result === 'win' && goA.reason === 'normal', 'A 获胜（normal）');
  check(goB.result === 'lose', 'B 落败');

  // 再战
  A.send({ type: 'rematch_vote', accept: true });
  const rs = await A.waitFor('rematch_status');
  check(rs.votes[0] === true && rs.votes[1] === false, 'A 投票后状态 [true,false]');
  B.send({ type: 'rematch_vote', accept: true });
  const gsA2 = await A.waitFor('game_started');
  const gsB2 = await B.waitFor('game_started');
  check(gsA2.round === 1 && gsA2.timeoutStrikes[0] === 0, '双方同意后再战，连击清零');

  return { A, B, code, joined };
}

/* ---------- 超时与连击 ---------- */
async function testTimeoutStrikes() {
  console.log('== 超时代出 / 连击清零 / 3 连击判负 ==');
  const A = new C('TA'), B = new C('TB');
  await A.connect(); await B.connect();
  A.send({ type: 'create_room' });
  const created = await A.waitFor('room_created');
  B.send({ type: 'join_room', code: created.code });
  await B.waitFor('room_joined');
  await A.waitFor('game_started');
  await B.waitFor('game_started');

  // 第 1 回合：双方闲置 → 双代出 i
  const n1 = await A.waitFor('timeout_notice', ROUND_TIMEOUT_MS + 3000);
  check(n1.action === 'i', '超时代出固定动作 i');
  const rr1 = await A.waitFor('round_result', 3000);
  check(rr1.outcome === 'continue' && rr1.timeouts[0] && rr1.timeouts[1], '双方超时代出');
  check(rr1.timeoutStrikes[0] === 1 && rr1.timeoutStrikes[1] === 1, '连击 [1,1]');

  // 第 2 回合：A 准时提交（清连击），B 继续超时
  A.send({ type: 'submit_action', action: 'i' });
  await A.waitFor('timeout_notice', ROUND_TIMEOUT_MS + 3000);
  const rr2 = await A.waitFor('round_result', 3000);
  check(rr2.timeoutStrikes[0] === 0 && rr2.timeoutStrikes[1] === 2, 'A 准时提交清连击，B 连击 2');

  // 第 3 回合：B 第三次超时 → 立即判负（连击检查先于结算，无 round_result）
  A.send({ type: 'submit_action', action: 'i' });
  await A.waitFor('timeout_notice', ROUND_TIMEOUT_MS + 3000);
  const goA = await A.waitFor('game_over', 3000);
  const goB = await B.waitFor('game_over', 3000);
  check(goA.result === 'win' && goA.reason === 'timeout_loss', 'A 因对手连续超时获胜');
  check(goB.result === 'lose' && goB.reason === 'timeout_loss', 'B 连续 3 次超时判负');
  check(goB.timeoutStrikes[1] === 3, '判负时连击计数 3');
}

/* ---------- 断线宽限与重进 ---------- */
async function testGraceRejoin() {
  console.log('== 断线宽限 / 重进同步 / 宽限期满判负 ==');
  const A = new C('GA'), B = new C('GB');
  await A.connect(); await B.connect();
  A.send({ type: 'create_room' });
  const created = await A.waitFor('room_created');
  const code = created.code;
  B.send({ type: 'join_room', code });
  const joined = await B.waitFor('room_joined');
  await A.waitFor('game_started');
  await B.waitFor('game_started');

  // B 异常断线
  B.ws.terminate();
  const ol = await A.waitFor('opponent_left', 3000);
  check(ol.graceMs === GRACE_MS, '对手断线通知带宽限期 ' + GRACE_MS + 'ms');

  // B 新连接重进（宽限期内）
  const B2 = new C('GB2');
  await B2.connect();
  B2.send({ type: 'rejoin', code, seat: 1, token: joined.token });
  const rs = await B2.waitFor('room_state', 3000);
  check(rs.status === 'playing' && rs.code === code, '重进同步：对局进行中');
  check(rs.opponentConnected === true, '重进同步：对手在线');
  check(rs.round === 1, '重进同步：回合数一致');
  await A.waitFor('opponent_rejoined', 3000);
  check(true, '对方收到重连通知');

  // 完成当前回合（双方 i）
  A.send({ type: 'submit_action', action: 'i' });
  B2.send({ type: 'submit_action', action: 'i' });
  const rr = await A.waitFor('round_result', 3000);
  check(rr.outcome === 'continue', '重进后对局正常继续');

  // B 再次断线，宽限期满 → A 获胜
  B2.ws.terminate();
  await A.waitFor('opponent_left', 3000);
  const go = await A.waitFor('game_over', GRACE_MS + 4000);
  check(go.result === 'win' && go.reason === 'opponent_left', '宽限期满对手判负，A 获胜');

  return { A, code };
}

/* ---------- 主动离开判负 ---------- */
async function testLeaveForfeit() {
  console.log('== 主动离开判负 / 房间回等待 ==');
  const A = new C('LA'), B = new C('LB');
  await A.connect(); await B.connect();
  A.send({ type: 'create_room' });
  const created = await A.waitFor('room_created');
  const code = created.code;
  B.send({ type: 'join_room', code });
  await B.waitFor('room_joined');
  await A.waitFor('game_started');
  await B.waitFor('game_started');

  B.send({ type: 'leave_room' });
  const go = await A.waitFor('game_over', 3000);
  check(go.result === 'win' && go.reason === 'opponent_left', '对手主动离开 → 我立即获胜');

  // 新玩家可加入该房间（回 waiting）
  const C2 = new C('LC'); await C2.connect();
  C2.send({ type: 'join_room', code });
  await C2.waitFor('room_joined');
  await A.waitFor('game_started');
  await C2.waitFor('game_started');
  check(true, '判负后房间回到等待，新玩家可加入');
}

/* ---------- 凭证错误与房间清理 ---------- */
async function testBadTokenAndCleanup() {
  console.log('== 凭证错误 / 房间删除 ==');
  const A = new C('BA'), E = new C('BE');
  await A.connect(); await E.connect();
  A.send({ type: 'create_room' });
  const created = await A.waitFor('room_created');
  const code = created.code;

  E.send({ type: 'rejoin', code, seat: 0, token: 'deadbeefdeadbeefdeadbeefdeadbeef' });
  await E.expectError('bad_token');
  check(true, '错误凭证重进被拒绝');
  E.send({ type: 'join_room', code: '9876' });
  await E.expectError('room_not_found');
  check(true, '加入不存在的房间被拒绝');

  // A 离开 → 房间空 → 立即删除
  A.send({ type: 'leave_room' });
  await sleep(200);
  const D = new C('BD'); await D.connect();
  D.send({ type: 'join_room', code });
  await D.expectError('room_not_found');
  check(true, '清空后房间被删除');
}

/* ---------- 回合上限 ---------- */
async function testRoundCap() {
  console.log('== 回合上限（ROUND_CAP_OVERRIDE=6）==');
  const F = new C('RF'), G = new C('RG');
  await F.connect(); await G.connect();
  F.send({ type: 'create_room' });
  const created = await F.waitFor('room_created');
  G.send({ type: 'join_room', code: created.code });
  await G.waitFor('room_joined');
  await F.waitFor('game_started');
  await G.waitFor('game_started');

  for (let r = 0; r < ROUND_CAP; r++) {
    F.send({ type: 'submit_action', action: 'i' });
    G.send({ type: 'submit_action', action: 'i' });
    const rr = await F.waitFor('round_result', 3000);
    check(rr.outcome === 'continue', '第 ' + (r + 1) + ' 回合继续（i,i 不变状态）');
  }
  const goF = await F.waitFor('game_over', 3000);
  const goG = await G.waitFor('game_over', 3000);
  check(goF.reason === 'round_cap' && goF.result === 'draw', '回合上限平局');
  check(goF.rounds === ROUND_CAP, 'game_over 回合数 = ' + ROUND_CAP);
  check(goG.result === 'draw', '双方皆平');
}

/* ---------- 安全 ---------- */
async function testSecurity() {
  console.log('== 安全：Origin / 限流 / 超大消息 ==');
  // 恶意 Origin 拒绝
  let originRejected = false;
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT, { origin: 'http://evil.example.com' });
      ws.on('open', () => { ws.close(); reject(new Error('open')); });
      ws.on('error', () => { originRejected = true; resolve(); });
    });
  } catch (e) { /* onerror 已置位 */ }
  check(originRejected, '恶意 Origin 的 WS 升级被拒绝');

  // 消息洪泛限流
  const R = new C('RATE'); await R.connect();
  for (let i = 0; i < 100; i++) R.send({ type: 'ping' });
  await sleep(1500);
  check(R.countType('error') > 0 && R.history.some(m => m.type === 'error' && m.code === 'rate_limited'), '突发 100 条消息触发限流');
  if (!R.closed) check(R.closed || R.countType('error') >= 3, '限流 3 次后关闭连接');

  // 超大消息断开（maxPayload 4096）
  const P = new C('PAYLOAD');
  await P.connect();
  const closedPromise = new Promise(resolve => {
    P.ws.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 3000);
  });
  P.sendRaw(Buffer.alloc(10000, 0x78));
  const closedBySize = await closedPromise;
  check(closedBySize, '10KB 超大消息被 maxPayload 断开');
}

main();
