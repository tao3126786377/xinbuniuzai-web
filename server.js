/* 西部牛仔 Web 服务器（单进程）：静态页面 + WebSocket 房间对战
 *
 * 设计要点：
 *  - PvP 服务器权威：对局状态只在内存维护，客户端消息全部校验后由服务器结算广播；
 *  - 多房间并发：rooms Map<房间号, Room>，房间号 4 位数字（公网可调长）；
 *  - 每回合限时 ROUND_TIMEOUT_MS（默认 60s）：到点未出招的座位在可行动作上均匀随机代出，
 *    连续 TIMEOUT_STRIKES 次（默认 3）判负；断线不暂停倒计时（防拖延）；
 *  - 意外断线宽限期 GRACE_MS（默认 60s）内凭 {code,seat,token} 可重进；主动离开立即判负；
 *  - 安全：maxPayload 4KB、Origin 校验、令牌桶限流、防路径穿越、无自由文本、零磁盘写入。
 *
 * 环境变量：PORT / ROUND_TIMEOUT_MS / GRACE_MS / TIMEOUT_STRIKES / MAX_ROOMS /
 *          MAX_ROOMS_PER_IP / ROOM_TTL_MS / ROOM_CODE_LENGTH / ALLOWED_ORIGINS / ALLOW_NO_ORIGIN
 *
 * 一局模式（mode='match'）：最多 5 轮筹码对决，每轮先保密选初始子弹 0~2（选弹与出招
 * 共享 60 秒限时与连击计数），轮末按子弹差 x 结算 y=(i+1)(j+1)x（劣势方胜双倍），
 * 平局各 -5×自选子弹；结算规则见 public/js/match.js（服务器权威）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const Game = require('./public/js/game.js');
const Match = require('./public/js/match.js');

// ==================== 环境配置 ====================
const PORT = parseInt(process.env.PORT, 10) || 3000;
const ROUND_TIMEOUT_MS = parseInt(process.env.ROUND_TIMEOUT_MS, 10) || 60000;
const GRACE_MS = parseInt(process.env.GRACE_MS, 10) || 60000;   // 断线重连宽限（用户拍板：1 分钟）
const TIMEOUT_STRIKES = parseInt(process.env.TIMEOUT_STRIKES, 10) || 3;
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS, 10) || 1000;
const MAX_ROOMS_PER_IP = parseInt(process.env.MAX_ROOMS_PER_IP, 10) || 10;
const ROOM_TTL_MS = parseInt(process.env.ROOM_TTL_MS, 10) || 600000;
const ROOM_CODE_LENGTH = parseInt(process.env.ROOM_CODE_LENGTH, 10) || 4;
// 测试钩子（生产环境不设置即无影响）
const ROUND_CAP = parseInt(process.env.ROUND_CAP_OVERRIDE, 10) || Game.MAX_ROUNDS;   // 回合上限覆盖
const TEST_TIMEOUT_ACTION = process.env.TEST_TIMEOUT_ACTION || null;                // 超时代出固定动作（自动化测试用）
const TEST_BULLET_CHOICE_RAW = parseInt(process.env.TEST_BULLET_CHOICE, 10);
const TEST_BULLET_CHOICE = (TEST_BULLET_CHOICE_RAW >= 0 && TEST_BULLET_CHOICE_RAW <= 2)
  ? TEST_BULLET_CHOICE_RAW : null;                                                 // 选弹超时代选固定值（自动化测试用）
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_NO_ORIGIN = (process.env.ALLOW_NO_ORIGIN || 'true') !== 'false';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ==================== 静态文件服务（防路径穿越） ====================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (urlPath.indexOf('\0') !== -1) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const resolved = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.stat(resolved, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(resolved).pipe(res);
  });
}

// ==================== 工具 ====================
class TokenBucket {
  constructor(ratePerSec, burst) {
    this.rate = ratePerSec;
    this.burst = burst;
    this.tokens = burst;
    this.last = Date.now();
  }
  tryTake() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) / 1000 * this.rate);
    this.last = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

const ipCreateBuckets = new Map(); // ip -> TokenBucket（建房 5/min）
const ipJoinBuckets = new Map();   // ip -> TokenBucket（加入 30/min）

function ipBucket(map, ip, ratePerSec, burst) {
  let b = map.get(ip);
  if (!b) { b = new TokenBucket(ratePerSec, burst); map.set(ip, b); }
  return b;
}

function clientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendError(ws, code, msg) {
  send(ws, { type: 'error', code: code, msg: msg });
}

// ==================== 房间 ====================
const rooms = new Map(); // code -> room

function createRoom(code, mode) {
  return {
    code: code,
    status: 'waiting',          // waiting | playing | finished
    mode: mode || 'single',     // 'single'（一轮） | 'match'（一局）
    phase: 'play',              // 'play'（出招） | 'pick'（选初始子弹，仅 match）
    seats: [
      { token: null, conn: null, connected: false, ip: null },
      { token: null, conn: null, connected: false, ip: null }
    ],
    b1: 0, b2: 0,               // 座位 0 / 座位 1 子弹
    round: 1,
    pending: [null, null],      // 本回合已提交的动作（null = 未出招）
    timedOut: [false, false],
    timeoutStrikes: [0, 0],     // 超时连击（一局：选弹与出招共享）
    roundDeadline: null,
    lastRound: null,            // 最近一次 round_result（重进同步）
    lastOutcome: null,          // 最近一次对局结果（重进同步，按座位构造 game_over）
    rematchVotes: [false, false],
    history: [],
    money: [Match.START_MONEY, Match.START_MONEY],   // 一局筹码（仅 match 使用）
    matchRound: 1,              // 一局第几轮（1..MATCH_ROUNDS，仅 match 使用）
    picks: [0, 0],              // 本轮已公开的初始子弹 i/j（仅 match 使用）
    pendingBullets: [null, null],   // 选弹阶段已提交的选择（null = 未选，仅 match 使用）
    matchHistory: [],           // 每轮结算摘要（重进重建筹码芯片，仅 match 使用）
    createdAt: Date.now(),
    lastActivity: Date.now(),
    graceUntil: null
  };
}

function generateRoomCode() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const code = String(crypto.randomInt(Math.pow(10, ROOM_CODE_LENGTH - 1), Math.pow(10, ROOM_CODE_LENGTH)));
    if (!rooms.has(code)) return code;
  }
  // 冲突过多：加长一位再试
  return String(crypto.randomInt(Math.pow(10, ROOM_CODE_LENGTH), Math.pow(10, ROOM_CODE_LENGTH + 1)));
}

function broadcast(room, obj) {
  for (const s of room.seats) send(s.conn, obj);
}

function startRound(room) {
  room.pending = [null, null];
  room.timedOut = [false, false];
  room.roundDeadline = Date.now() + ROUND_TIMEOUT_MS;
}

function startGame(room) {
  if (room.mode === 'match') { startMatch(room); return; }
  room.status = 'playing';
  room.b1 = 0;
  room.b2 = 0;
  room.round = 1;
  room.timeoutStrikes = [0, 0];
  room.graceUntil = null;
  room.lastRound = null;
  room.lastOutcome = null;
  room.history = [];
  startRound(room);
  const now = Date.now();
  for (let seat = 0; seat < 2; seat++) {
    const conn = room.seats[seat].conn;
    if (conn) {
      send(conn, {
        type: 'game_started',
        mode: 'single',
        b1: room.b1, b2: room.b2, round: room.round,
        roundDeadline: room.roundDeadline,
        serverNow: now,
        roundTimeoutMs: ROUND_TIMEOUT_MS,
        timeoutStrikes: room.timeoutStrikes.slice()
      });
    }
  }
  notifyAbsentSeats(room);
}

/* 一局开局：进入第 1 轮选弹阶段（选弹与出招共用 60 秒限时） */
function startMatch(room) {
  room.status = 'playing';
  room.phase = 'pick';
  room.b1 = 0;
  room.b2 = 0;
  room.round = 1;
  room.money = [Match.START_MONEY, Match.START_MONEY];
  room.matchRound = 1;
  room.picks = [0, 0];
  room.pending = [null, null];
  room.timedOut = [false, false];
  room.pendingBullets = [null, null];
  room.timeoutStrikes = [0, 0];
  room.graceUntil = null;
  room.lastRound = null;
  room.lastOutcome = null;
  room.history = [];
  room.matchHistory = [];
  room.roundDeadline = Date.now() + ROUND_TIMEOUT_MS;   // 选弹死线
  const now = Date.now();
  for (let seat = 0; seat < 2; seat++) {
    const conn = room.seats[seat].conn;
    if (conn) {
      send(conn, {
        type: 'game_started',
        mode: 'match',
        phase: 'pick',
        matchRound: room.matchRound,
        money: room.money.slice(),
        b1: room.b1, b2: room.b2, round: room.round,
        roundDeadline: room.roundDeadline,
        serverNow: now,
        roundTimeoutMs: ROUND_TIMEOUT_MS,
        timeoutStrikes: room.timeoutStrikes.slice()
      });
    }
  }
  notifyAbsentSeats(room);
}

/* 开局时缺席的座位视同断线：立即开始宽限期 */
function notifyAbsentSeats(room) {
  for (let seat = 0; seat < 2; seat++) {
    if (!room.seats[seat].connected) {
      room.graceUntil = Date.now() + GRACE_MS;
      const other = 1 - seat;
      if (room.seats[other].conn) {
        send(room.seats[other].conn, { type: 'opponent_left', graceMs: GRACE_MS });
      }
    }
  }
}

/* 双方选弹就位：公布初始子弹并开始对决回合 */
function revealAndStartDuel(room) {
  room.picks = room.pendingBullets.slice();
  room.pendingBullets = [null, null];
  room.timedOut = [false, false];
  room.phase = 'play';
  room.round = 1;
  room.b1 = room.picks[0];
  room.b2 = room.picks[1];
  room.history = [];   // 清空上一轮对决移动芯片
  startRound(room);
  broadcast(room, {
    type: 'bullet_reveal',
    matchRound: room.matchRound,
    picks: room.picks.slice(),
    b1: room.b1,
    b2: room.b2,
    round: room.round,
    roundDeadline: room.roundDeadline,
    serverNow: Date.now(),
    roundTimeoutMs: ROUND_TIMEOUT_MS,
    timeoutStrikes: room.timeoutStrikes.slice(),
    money: room.money.slice()
  });
}

function outcomeToResults(winner) {
  if (winner === 1) return ['win', 'lose'];
  if (winner === 2) return ['lose', 'win'];
  return ['draw', 'draw'];
}

function finishGame(room, reason, results) {
  room.status = 'finished';
  room.roundDeadline = null;
  room.graceUntil = null;
  room.pending = [null, null];
  room.pendingBullets = [null, null];
  room.rematchVotes = [false, false];
  room.lastActivity = Date.now();
  room.lastOutcome = buildOutcome(room, reason, results);
  for (let seat = 0; seat < 2; seat++) {
    send(room.seats[seat].conn, gameOverPayload(room, seat));
  }
}

/* 统一构造对局结果（一轮与一局共用；一局附带筹码与局轮数） */
function buildOutcome(room, reason, results) {
  const o = {
    reason: reason,
    results: results.slice(),
    rounds: room.mode === 'match' ? room.matchRound : room.round,
    timeoutStrikes: room.timeoutStrikes.slice()
  };
  if (room.mode === 'match') o.money = room.money.slice();
  return o;
}

/* 按座位构造 game_over（result 为座位相对视角） */
function gameOverPayload(room, seat) {
  const o = room.lastOutcome;
  const p = {
    type: 'game_over',
    result: o.results[seat],
    reason: o.reason,
    rounds: o.rounds,
    timeoutStrikes: o.timeoutStrikes.slice()
  };
  if (o.money) p.money = o.money.slice();
  return p;
}

function resolveRound(room) {
  const r = Game.step(room.b1, room.b2, room.pending[0], room.pending[1]);
  const outcome = r.winner === 1 ? 'p1_win' : r.winner === 2 ? 'p2_win' : r.winner === 0 ? 'draw' : 'continue';
  const payload = {
    type: 'round_result',
    round: room.round,
    b1: room.b1, b2: room.b2,   // 行动前子弹（C++ 日志约定）
    a1: Game.ACT_CHARS[room.pending[0]],
    a2: Game.ACT_CHARS[room.pending[1]],
    outcome: outcome,
    timeouts: [room.timedOut[0], room.timedOut[1]],
    timeoutStrikes: room.timeoutStrikes.slice()
  };
  room.history.push({ b1: room.b1, b2: room.b2, a1: payload.a1, a2: payload.a2, outcome: outcome });
  if (room.history.length > Game.MAX_ROUNDS) room.history.shift();

  if (room.mode === 'match') {
    resolveMatchRound(room, r, payload);
    return;
  }

  if (r.winner === -1) {
    room.b1 = r.b1;
    room.b2 = r.b2;
    payload.b1_next = r.b1;
    payload.b2_next = r.b2;
    if (room.round >= ROUND_CAP) {
      // 回合上限平局（C++ 语义：非终止结算后检查）
      room.lastRound = payload;
      broadcast(room, payload);          // 先广播最后一回合，再发 game_over
      finishGame(room, 'round_cap', ['draw', 'draw']);
      return;
    }
    room.round++;
    startRound(room);   // 隐式开始下一回合（新 deadline 随 round_result 下发）
    payload.roundDeadline = room.roundDeadline;
  } else {
    payload.b1_next = r.b1;
    payload.b2_next = r.b2;
    room.lastRound = payload;
    broadcast(room, payload);            // 先广播最后一回合，再发 game_over
    finishGame(room, 'normal', outcomeToResults(r.winner));
    return;
  }
  room.lastRound = payload;
  broadcast(room, payload);
}

/* 一局对决回合结算（一轮路径不走此处）。
 * r = Game.step 结果；payload = 已填基础字段的 round_result（b1/b2 为行动前子弹）。 */
function resolveMatchRound(room, r, payload) {
  payload.matchRound = room.matchRound;
  payload.picks = room.picks.slice();
  payload.money = room.money.slice();
  if (r.winner === -1) {
    room.b1 = r.b1;
    room.b2 = r.b2;
    payload.b1_next = r.b1;
    payload.b2_next = r.b2;
    if (room.round >= ROUND_CAP) {
      // 对决步数封顶：轮平局（同 -5×自选子弹罚金）
      payload.outcome = 'draw';
      payload.capped = true;
      settleMatchRound(room, 0, payload);
      advanceMatch(room, payload);
    } else {
      room.round++;
      startRound(room);   // 隐式开始下一回合（新 deadline 随 round_result 下发）
      payload.roundDeadline = room.roundDeadline;
    }
  } else {
    payload.b1_next = r.b1;
    payload.b2_next = r.b2;
    settleMatchRound(room, r.winner, payload);
    advanceMatch(room, payload);
  }
  room.lastRound = payload;
  broadcast(room, payload);            // 先广播最后一回合，再发 game_over
  if (payload.matchOver) {
    finishGame(room, 'match_end', outcomeToResults(payload.matchWinner));
  }
}

/* 一局单轮筹码结算：更新 room.money 并回填 payload（x/y/A/double/transfer/settled/money）。
 * winner: 1|2 非平局（按末动作终弹差结算）；0 平局（双方各 -5×自选子弹）。
 * 注意：结算终弹必须用行动前 room.b1/b2 喂 finalBullets（瞬间胜负时 step 返回子弹不变）。 */
function settleMatchRound(room, winner, payload) {
  let s;
  if (winner === 0) {
    s = Match.settleRoundMoney(room.money[0], room.money[1], room.picks[0], room.picks[1], 0, 0, 0);
  } else {
    const fb = Match.finalBullets(room.b1, room.b2, room.pending[0], room.pending[1], winner);
    s = Match.settleRoundMoney(room.money[0], room.money[1], room.picks[0], room.picks[1], winner, fb.b1, fb.b2);
  }
  room.money = [s.money1, s.money2];
  payload.settled = s.settled;
  payload.money = room.money.slice();
  if (winner === 0) {
    payload.drawPenalty = [Match.PICK_PENALTY * room.picks[0], Match.PICK_PENALTY * room.picks[1]];
  } else {
    payload.x = s.x;
    payload.y = s.y;
    payload.A = s.A;
    payload.double = s.double;
    payload.transfer = s.transfer;
  }
  room.matchHistory.push({
    matchRound: room.matchRound,
    picks: room.picks.slice(),
    outcome: payload.outcome,
    settled: s.settled,
    x: s.x, y: s.y, A: s.A, double: s.double, transfer: s.transfer,
    capped: !!payload.capped,
    draw: winner === 0,
    money: room.money.slice()
  });
  if (room.matchHistory.length > Match.MATCH_ROUNDS) room.matchHistory.shift();
}

/* 每轮结算后推进比赛：筹码 ≤0 或已满 5 轮 → matchOver（matchWinner 1|2|0）；
 * 否则进入下一轮选弹阶段（新死线随 payload 下发，客户端揭示完再展示倒计时）。 */
function advanceMatch(room, payload) {
  const t = Match.checkMatchOver(room.money[0], room.money[1], room.matchRound);
  payload.matchOver = t.over;
  if (t.over) {
    payload.matchWinner = t.winner;
    return;
  }
  room.matchRound++;
  room.phase = 'pick';
  room.b1 = 0;      // 选弹阶段子弹归零（新轮不继承上轮终弹，客户端同步显示 0/0）
  room.b2 = 0;
  room.pendingBullets = [null, null];
  room.picks = [0, 0];
  room.pending = [null, null];
  room.timedOut = [false, false];
  room.roundDeadline = Date.now() + ROUND_TIMEOUT_MS;
  payload.nextPhase = 'pick';
  payload.nextMatchRound = room.matchRound;
  payload.nextDeadline = room.roundDeadline;
}

/* 到点结算：代出 + 连击检查（连击先于结算——随机动作不能救拖延者） */
function applyTimeout(room) {
  if (room.mode === 'match' && room.phase === 'pick') { applyPickTimeout(room); return; }
  for (let seat = 0; seat < 2; seat++) {
    if (room.pending[seat] !== null) continue;
    const bullets = seat === 0 ? room.b1 : room.b2;
    const feas = Game.feasible(bullets);
    let a;
    if (TEST_TIMEOUT_ACTION) {
      const t = Game.charToAction(TEST_TIMEOUT_ACTION);
      a = Game.isFeasible(bullets, t) ? t : feas[crypto.randomInt(feas.length)];
    } else {
      a = feas[crypto.randomInt(feas.length)];       // 可行动作上均匀随机
    }
    room.pending[seat] = a;
    room.timedOut[seat] = true;
    room.timeoutStrikes[seat]++;
  }
  const s0 = room.timeoutStrikes[0] >= TIMEOUT_STRIKES;
  const s1 = room.timeoutStrikes[1] >= TIMEOUT_STRIKES;

  // 广播代出通知（先于结算）
  for (let seat = 0; seat < 2; seat++) {
    if (room.timedOut[seat]) {
      broadcast(room, {
        type: 'timeout_notice',
        seat: seat,
        action: Game.ACT_CHARS[room.pending[seat]],
        timeoutStrikes: room.timeoutStrikes.slice()
      });
    }
  }

  if (s0 || s1) {
    let results;
    if (s0 && s1) results = ['draw', 'draw'];
    else if (s0) results = ['lose', 'win'];
    else results = ['win', 'lose'];
    finishGame(room, 'timeout_loss', results);
    return;
  }
  resolveRound(room);
}

/* 选弹到点：代选 + 连击检查（连击先于揭晓——随机代选不能救拖延者） */
function applyPickTimeout(room) {
  for (let seat = 0; seat < 2; seat++) {
    if (room.pendingBullets[seat] !== null) continue;
    const pick = TEST_BULLET_CHOICE !== null ? TEST_BULLET_CHOICE : crypto.randomInt(Match.MAX_PICK + 1);
    room.pendingBullets[seat] = pick;
    room.timedOut[seat] = true;
    room.timeoutStrikes[seat]++;
  }
  const s0 = room.timeoutStrikes[0] >= TIMEOUT_STRIKES;
  const s1 = room.timeoutStrikes[1] >= TIMEOUT_STRIKES;

  // 广播代选通知（先于揭晓）
  for (let seat = 0; seat < 2; seat++) {
    if (room.timedOut[seat]) {
      broadcast(room, {
        type: 'timeout_notice',
        seat: seat,
        phase: 'pick',
        pick: room.pendingBullets[seat],
        timeoutStrikes: room.timeoutStrikes.slice()
      });
    }
  }

  if (s0 || s1) {
    let results;
    if (s0 && s1) results = ['draw', 'draw'];
    else if (s0) results = ['lose', 'win'];
    else results = ['win', 'lose'];
    finishGame(room, 'timeout_loss', results);
    return;
  }
  revealAndStartDuel(room);
}

/* 宽限期到期：断线方判负（败者 token 作废） */
function forfeitByDisconnect(room, offSeat) {
  console.log('[房间] ' + room.code + ' 座位 ' + offSeat + ' 宽限期满判负');
  room.graceUntil = null;
  const other = 1 - offSeat;
  const results = ['draw', 'draw'];
  results[offSeat] = 'lose';
  results[other] = 'win';
  room.lastOutcome = buildOutcome(room, 'opponent_left', results);
  send(room.seats[other].conn, gameOverPayload(room, other));
  room.seats[offSeat].token = null;
  room.status = 'waiting';
  room.roundDeadline = null;
  room.pending = [null, null];
  room.rematchVotes = [false, false];
  room.lastActivity = Date.now();
}

function roomStatePayload(room, seat) {
  const p = {
    type: 'room_state',
    code: room.code,
    status: room.status,
    mode: room.mode,
    seat: seat,
    b1: room.b1,
    b2: room.b2,
    round: room.round,
    acted: room.phase === 'pick'
      ? [room.pendingBullets[0] !== null, room.pendingBullets[1] !== null]
      : [room.pending[0] !== null, room.pending[1] !== null],
    opponentConnected: room.seats[1 - seat].connected,
    roundDeadline: room.roundDeadline,
    serverNow: Date.now(),
    roundTimeoutMs: ROUND_TIMEOUT_MS,
    graceMs: GRACE_MS,
    timeoutStrikes: room.timeoutStrikes.slice(),
    lastRound: room.lastRound,
    lastGameOver: room.lastOutcome ? gameOverPayload(room, seat) : null,
    history: room.history.slice()
  };
  if (room.mode === 'match') {
    p.phase = room.phase;
    p.matchRound = room.matchRound;
    p.money = room.money.slice();
    p.picks = room.picks.slice();
    p.bulletActed = [room.pendingBullets[0] !== null, room.pendingBullets[1] !== null];
    // 仅下发自己的选择；对手 pendingBullets 保密
    if (room.pendingBullets[seat] !== null) p.myPick = room.pendingBullets[seat];
    p.matchHistory = room.matchHistory.slice();
  }
  return p;
}

function detachSeat(room, seat) {
  const s = room.seats[seat];
  if (s.conn) { s.conn.room = null; s.conn.seat = null; }
  s.conn = null;
  s.connected = false;
}

// ==================== 消息处理 ====================
function handleMessage(ws, msg) {
  const room = ws.room;
  const seat = ws.seat;

  switch (msg.type) {
    case 'create_room': {
      if (room) { sendError(ws, 'bad_request', '已在房间中'); return; }
      if (rooms.size >= MAX_ROOMS) { sendError(ws, 'server_full', '服务器房间已满'); return; }
      if (!ipBucket(ipCreateBuckets, ws.ip, 5 / 60, 5).tryTake()) {
        sendError(ws, 'rate_limited', '创建房间过于频繁，请稍后再试');
        return;
      }
      let myRooms = 0;
      for (const r of rooms.values()) {
        for (const s of r.seats) if (s.ip === ws.ip && s.token) myRooms++;
      }
      if (myRooms >= MAX_ROOMS_PER_IP) { sendError(ws, 'server_full', '你创建的房间过多'); return; }

      const code = generateRoomCode();
      const newRoom = createRoom(code, msg.mode === 'match' ? 'match' : 'single');
      rooms.set(code, newRoom);
      const token = crypto.randomBytes(16).toString('hex');
      newRoom.seats[0].token = token;
      newRoom.seats[0].conn = ws;
      newRoom.seats[0].connected = true;
      newRoom.seats[0].ip = ws.ip;
      ws.room = newRoom;
      ws.seat = 0;
      send(ws, { type: 'room_created', code: code, seat: 0, token: token, mode: newRoom.mode });
      console.log('[房间] ' + code + ' 创建（' + newRoom.mode + '，' + rooms.size + ' 个活跃房间）');
      return;
    }

    case 'join_room': {
      if (room) { sendError(ws, 'bad_request', '已在房间中'); return; }
      if (!ipBucket(ipJoinBuckets, ws.ip, 30 / 60, 30).tryTake()) {
        sendError(ws, 'rate_limited', '加入尝试过于频繁，请稍后再试');
        return;
      }
      if (typeof msg.code !== 'string' || !/^\d+$/.test(msg.code)) {
        sendError(ws, 'bad_request', '房间号格式错误');
        return;
      }
      const target = rooms.get(msg.code);
      if (!target) { sendError(ws, 'room_not_found', '房间不存在'); return; }
      if (target.status !== 'waiting') { sendError(ws, 'game_in_progress', '房间对局已在进行'); return; }
      const freeSeat = target.seats.findIndex(s => !s.token);
      if (freeSeat < 0) { sendError(ws, 'room_full', '房间已满'); return; }

      const token = crypto.randomBytes(16).toString('hex');
      target.seats[freeSeat].token = token;
      target.seats[freeSeat].conn = ws;
      target.seats[freeSeat].connected = true;
      target.seats[freeSeat].ip = ws.ip;
      ws.room = target;
      ws.seat = freeSeat;
      target.lastActivity = Date.now();
      send(ws, { type: 'room_joined', code: target.code, seat: freeSeat, token: token });

      const other = 1 - freeSeat;
      if (target.seats[other].conn) {
        send(target.seats[other].conn, { type: 'opponent_joined' });
      }
      // 双方就位：自动开局
      if (target.seats[0].token && target.seats[1].token) {
        startGame(target);
      }
      console.log('[房间] ' + target.code + ' 座位 ' + freeSeat + ' 加入');
      return;
    }

    case 'rejoin': {
      if (room) { sendError(ws, 'bad_request', '已在房间中'); return; }
      if (typeof msg.code !== 'string' || !/^\d+$/.test(msg.code) ||
          (msg.seat !== 0 && msg.seat !== 1) || typeof msg.token !== 'string') {
        sendError(ws, 'bad_request', '重进参数格式错误');
        return;
      }
      const target = rooms.get(msg.code);
      if (!target) {
        console.log('[重进] ' + msg.code + ' 房间不存在');
        sendError(ws, 'room_not_found', '房间不存在');
        return;
      }
      const s = target.seats[msg.seat];
      if (!s.token || s.token !== msg.token) {
        console.log('[重进] ' + target.code + ' 座位 ' + msg.seat + ' 凭证无效');
        sendError(ws, 'bad_token', '座位凭证无效');
        return;
      }
      if (s.connected) {
        // 旧连接可能已僵死：手机锁屏时系统内核仍会替浏览器回应协议层心跳
        // （lastSeenAt 一直新鲜），但应用层 JS 已冻结——应用层消息停止。
        // 因此用"应用层最后活跃时间"判定：超过 25 秒无应用层消息则允许接管
        // （健康的前台客户端每 20 秒必发一次应用层 ping，不会误伤）。
        const lastAppMsg = (s.conn && s.conn.lastAppMsgAt) || Date.now();
        if (Date.now() - lastAppMsg > 25000) {
          console.log('[重进] ' + target.code + ' 座位 ' + msg.seat + ' 接管僵死旧连接（静默 ' +
            Math.round((Date.now() - lastAppMsg) / 1000) + 's）');
          const oldConn = s.conn;
          detachSeat(target, msg.seat);   // 先解除归属，避免旧连接 close 事件误判离场
          try { oldConn.terminate(); } catch (e) { /* 忽略 */ }
        } else {
          console.log('[重进] ' + target.code + ' 座位 ' + msg.seat + ' 旧连接未达接管阈值（静默 ' +
            Math.round((Date.now() - lastAppMsg) / 1000) + 's），拒绝');
          sendError(ws, 'seat_taken', '该座位已有活跃连接');
          return;
        }
      }

      s.conn = ws;
      s.connected = true;
      ws.room = target;
      ws.seat = msg.seat;
      target.lastActivity = Date.now();
      send(ws, roomStatePayload(target, msg.seat));

      const other = 1 - msg.seat;
      if (target.seats[other].connected) {
        // 双方都在线：清除宽限期并通知对方
        target.graceUntil = null;
        send(target.seats[other].conn, { type: 'opponent_rejoined' });
      }
      console.log('[房间] ' + target.code + ' 座位 ' + msg.seat + ' 重进（' + target.status + '）');
      return;
    }

    case 'submit_bullets': {
      if (!room) { sendError(ws, 'not_playing', '不在对局中'); return; }
      if (room.mode !== 'match' || room.status !== 'playing' || room.phase !== 'pick') {
        sendError(ws, 'not_playing', '当前不是选弹阶段');
        return;
      }
      if (room.pendingBullets[seat] !== null) { sendError(ws, 'already_submitted', '本轮已选初始子弹'); return; }
      if (typeof msg.bullets !== 'number' || !Number.isInteger(msg.bullets) ||
          msg.bullets < 0 || msg.bullets > Match.MAX_PICK) {
        sendError(ws, 'invalid_bullets', '初始子弹须为 0~2 的整数');
        return;
      }
      room.pendingBullets[seat] = msg.bullets;
      room.timeoutStrikes[seat] = 0;   // 准时提交清空超时连击（选弹与出招共享）
      room.lastActivity = Date.now();
      if (room.pendingBullets[0] !== null && room.pendingBullets[1] !== null) {
        revealAndStartDuel(room);
      }
      return;
    }

    case 'submit_action': {
      if (!room) { sendError(ws, 'not_playing', '不在对局中'); return; }
      if (room.status !== 'playing') { sendError(ws, 'not_playing', '对局未在进行'); return; }
      if (room.mode === 'match' && room.phase !== 'play') {
        sendError(ws, 'not_playing', '当前不是出招阶段');
        return;
      }
      if (room.pending[seat] !== null) { sendError(ws, 'already_submitted', '本回合已出招'); return; }
      if (typeof msg.action !== 'string') { sendError(ws, 'invalid_action', '非法动作'); return; }
      const a = Game.charToAction(msg.action);
      if (a < 0) { sendError(ws, 'invalid_action', '非法动作'); return; }
      const bullets = seat === 0 ? room.b1 : room.b2;
      if (!Game.isFeasible(bullets, a)) { sendError(ws, 'invalid_action', '当前子弹数无法执行该动作'); return; }

      room.pending[seat] = a;
      room.timeoutStrikes[seat] = 0;   // 准时提交清空超时连击
      room.lastActivity = Date.now();
      if (room.pending[0] !== null && room.pending[1] !== null) {
        resolveRound(room);
      }
      return;
    }

    case 'rematch_vote': {
      if (!room) { sendError(ws, 'not_playing', '不在对局中'); return; }
      if (room.status !== 'finished') { sendError(ws, 'not_playing', '对局未结束'); return; }
      room.rematchVotes[seat] = !!msg.accept;
      broadcast(room, { type: 'rematch_status', votes: room.rematchVotes.slice() });
      if (room.rematchVotes[0] && room.rematchVotes[1]) {
        startGame(room);
      }
      return;
    }

    case 'leave_room': {
      if (!room) return;
      const wasPlaying = room.status === 'playing';
      const other = 1 - seat;
      detachSeat(room, seat);
      room.seats[seat].token = null;
      room.lastActivity = Date.now();
      if (wasPlaying) {
        // 主动离开 = 立即判负（对方获胜），房间回到等待
        const results = ['draw', 'draw'];
        results[seat] = 'lose';
        results[other] = 'win';
        room.lastOutcome = {
          reason: 'opponent_left',
          results: results,
          rounds: room.round,
          timeoutStrikes: room.timeoutStrikes.slice()
        };
        send(room.seats[other].conn, gameOverPayload(room, other));
        room.status = 'waiting';
        room.roundDeadline = null;
        room.graceUntil = null;
        room.pending = [null, null];
        room.rematchVotes = [false, false];
        console.log('[房间] ' + room.code + ' 座位 ' + seat + ' 离开（判负）');
      } else {
        if (!room.seats[0].token && !room.seats[1].token) {
          rooms.delete(room.code);
          console.log('[房间] ' + room.code + ' 清空删除');
        }
      }
      ws.room = null;
      ws.seat = null;
      return;
    }

    case 'ping': {
      send(ws, { type: 'pong', t: Date.now() });
      return;
    }

    default:
      invalidMsg(ws);
      return;
  }
}

function invalidMsg(ws) {
  ws.invalidCount = (ws.invalidCount || 0) + 1;
  if (ws.invalidCount >= 5) {
    ws.close(1008, 'invalid messages');
    return;
  }
  sendError(ws, 'bad_request', '消息格式错误');
}

// ==================== WebSocket 服务 ====================
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

const server = http.createServer((req, res) => serveStatic(req, res));

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return ALLOW_NO_ORIGIN;
  try {
    const u = new URL(origin);
    if (u.host === req.headers.host) return true;
    return ALLOWED_ORIGINS.indexOf(origin) !== -1 || ALLOWED_ORIGINS.indexOf(u.host) !== -1;
  } catch (e) {
    return false;
  }
}

server.on('upgrade', (req, socket, head) => {
  if (!originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.invalidCount = 0;
  ws.rateStrikes = 0;
  ws.lastSeenAt = Date.now();
  ws.lastAppMsgAt = Date.now();          // 应用层消息时间（接管判定用；协议层 pong 不算）
  ws.bucket = new TokenBucket(30, 60);   // 每连接 30 msg/s，突发 60
  ws.ip = clientIp(req);
  ws.room = null;
  ws.seat = null;

  ws.on('pong', () => {
    ws.isAlive = true;
    ws.lastSeenAt = Date.now();
  });

  ws.on('message', (raw) => {
    ws.lastSeenAt = Date.now();
    ws.lastAppMsgAt = Date.now();
    if (!ws.bucket.tryTake()) {
      ws.rateStrikes++;
      sendError(ws, 'rate_limited', '消息过快');
      if (ws.rateStrikes >= 3) ws.close(1008, 'rate limited');
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { invalidMsg(ws); return; }
    if (!msg || typeof msg.type !== 'string') { invalidMsg(ws); return; }
    handleMessage(ws, msg);
  });

  ws.on('close', (code) => {
    const room = ws.room, seat = ws.seat;
    if (!room) return;
    // 诊断日志：仅在仍有房间归属时打印（正常离场先 detach，不会走到这里）
    console.log('[连接] 房间 ' + room.code + ' 座位 ' + seat + ' 断开（code=' + code + '）');
    ws.room = null;
    ws.seat = null;
    const s = room.seats[seat];
    s.conn = null;
    s.connected = false;
    room.lastActivity = Date.now();
    if (room.status === 'playing') {
      const other = 1 - seat;
      if (room.seats[other].connected) {
        room.graceUntil = Date.now() + GRACE_MS;   // 回合倒计时不暂停（用户确认）
        send(room.seats[other].conn, { type: 'opponent_left', graceMs: GRACE_MS });
      }
      // 双方都断：TTL 清理兜底；先断者宽限期照走
    } else if (room.status === 'waiting' && !room.seats[0].connected && !room.seats[1].connected) {
      rooms.delete(room.code);
    }
  });

  ws.on('error', () => { /* 忽略，close 会走清理 */ });
});

// ==================== 心跳 ====================
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      console.log('[连接] 心跳超时断开（' + (ws.room ? ws.room.code + ' 座位 ' + ws.seat : '无房间归属') + '）');
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// ==================== 游戏滴答（1s）：回合死线 + 宽限期 ====================
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.status === 'playing') {
      if (room.roundDeadline !== null && now >= room.roundDeadline) {
        applyTimeout(room);
      }
      if (room.graceUntil !== null && now >= room.graceUntil) {
        const offSeat = room.seats.findIndex(s => !s.connected);
        if (offSeat >= 0) forfeitByDisconnect(room, offSeat);
      }
    }
  }
}, 1000);

// ==================== 清理（30s） ====================
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConnected = room.seats[0].connected || room.seats[1].connected;
    if (!anyConnected && now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code);
    } else if (room.status === 'finished' &&
               !room.rematchVotes[0] && !room.rematchVotes[1] &&
               now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}, 30000);

// ==================== 启动 ====================
// 优雅关闭（平台重启/本地 Ctrl+C）：通知所有房间后退出
function shutdown(signal) {
  console.log('[' + signal + '] 正在关闭服务器…');
  for (const room of rooms.values()) {
    broadcast(room, { type: 'room_closed', reason: 'shutdown' });
  }
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('[错误] 端口 ' + PORT + ' 已被占用。请关闭占用该端口的程序，或用 PORT=其他端口 node server.js 启动');
  } else {
    console.error('[错误] 服务器启动失败：' + err.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('============================================');
  console.log('  西部牛仔 Web 服务器已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log('  局域网访问: http://' + iface.address + ':' + PORT + '   (' + name + ')');
      }
    }
  }
  console.log('  手机与电脑需连接同一 WiFi');
  console.log('  若手机无法访问，请在 Windows 防火墙弹窗中允许 Node.js');
  console.log('  (Ctrl+C 停止服务器)');
  console.log('============================================');
});
