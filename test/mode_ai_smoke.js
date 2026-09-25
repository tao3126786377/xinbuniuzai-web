/* 人机模式冒烟测试（Node 运行，最小 DOM/App 桩）：
 * 1. 用"脏日志"（含 undefined 回合行、空对局、中止对局）构建会话并完整打一局，
 *    断言：不抛异常、每回合电脑动作都是合法 u/i/o、日志无 undefined；
 * 2. 用干净空日志再打一局（空日志 → 纯均衡路径）。
 * 3. 连续对局/菜单重进读取最新日志，中止局不参与学习，加载时不重复开局。
 *
 * 覆盖 2026-09-05 线上事故：mode-ai 手工组装会话缺失记忆字段导致
 * computeFinalStrategyMem 每回合抛 TypeError（电脑动作恒为 undefined）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ==================== 最小浏览器桩 ====================
const storedLog = { text: '' };
global.localStorage = {
  getItem: function (k) { return k === 'xnz_log_v1' ? storedLog.text : null; },
  setItem: function (k, v) { if (k === 'xnz_log_v1') storedLog.text = v; },
  removeItem: function () {}
};
function fakeEl() {
  return {
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    textContent: '', innerHTML: '', value: '', disabled: false,
    style: {}, scrollLeft: 0, scrollWidth: 0,
    appendChild: function () {}, removeChild: function () {},
    addEventListener: function () {}
  };
}
global.document = {
  getElementById: function () { return fakeEl(); },
  createElement: function () { return fakeEl(); },
  body: { appendChild: function () {} },
  addEventListener: function () {}
};
global.window = global;
// 同步化 setTimeout：出招揭示/下一回合立即执行（消除真实计时依赖）
global.setTimeout = function (fn) { fn(); return 0; };
global.clearTimeout = function () {};

// 浏览器全局（mode-ai.js 以裸标识符引用 Game/AI/Strategies）
global.Game = require('../public/js/game.js');
global.Strategies = require('../public/strategies.js');
global.AI = require('../public/js/ai.js');
const Game = global.Game;
const Strategies = global.Strategies;
const AI = global.AI;
const builtSessions = [];
const decisionSessions = [];
const buildAiSession = AI.buildAiSession;
const computeFinalStrategyMem = AI.computeFinalStrategyMem;
AI.buildAiSession = function (logText, strategies) {
  const session = buildAiSession(logText, strategies);
  builtSessions.push({ logText: logText, session: session });
  return session;
};
AI.computeFinalStrategyMem = function (session, b1, b2, mi) {
  decisionSessions.push(session);
  return computeFinalStrategyMem(session, b1, b2, mi);
};
// App 桩（mode-ai 引用的 UI 助手全部 no-op）
global.App = {
  setActiveMode: function () {},
  setText: function () {}, show: function () {}, hide: function () {},
  toast: function () {},
  actionName: function (ch) { return ch; },
  actionBadgeClass: function () { return ''; },
  updateBullets: function () {}, showBadge: function () {}, showBanner: function () {},
  setActionButtons: function () {}, lockActionButtons: function () {},
  addHistoryChip: function () {}, clearHistory: function () {},
  showScreen: function () {}, showResult: function () {}
};
global.Stats = { refresh: function () {} };
require('../public/js/mode-ai.js');

// ==================== 工具 ====================
let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  [通过] ' + msg);
  else { console.error('  [失败] ' + msg); failures++; }
}

function playOneGame(maxRounds) {
  // 同步 setTimeout 下：ModeAI.onAction 一条龙执行到下一回合开始或对局结束。
  // 每步选装弹（不可行则防御）；对局结束的标志 = 存储日志出现新的 GAME_END 行。
  const before = storedLog.text.length;
  let acted = 0;
  while (acted < maxRounds) {
    const b1 = parseB1FromActiveGame();
    const feas = Game.feasible(b1);
    const a = feas.indexOf(Game.ACT_O) >= 0 ? Game.ACT_O : Game.ACT_I;
    ModeAI.onAction(a);
    acted++;
    if (storedLog.text.length > before && /GAME_END NORMAL/.test(storedLog.text.slice(before))) break;
    if (storedLog.text.length > before && /GAME_END ABORT/.test(storedLog.text.slice(before))) break;
  }
  return storedLog.text.slice(before);
}

function parseB1FromActiveGame() {
  // 从存储日志的当前对局推断玩家子弹数（回放最后一条回合行）
  const lines = storedLog.text.split('\n').filter(function (l) { return l.length > 0; });
  let b1 = 0, b2 = 0, ai = 0, pi = 0;
  for (const line of lines) {
    const m = line.match(/^(\d+) (\d+) (\S) (\S) \d+$/);
    if (m) { b1 = +m[1]; b2 = +m[2]; ai = m[3]; pi = m[4]; }
  }
  const st = Game.step(b1, b2, Game.charToAction(ai), Game.charToAction(pi));
  if (st.winner !== -1) return 0;   // 上一回合已终局：新局从 0 开始
  return st.b1;
}

// ==================== 场景 1：脏日志（线上事故数据形态） ====================
console.log('== 场景 1：脏日志（undefined 回合 / 空对局 / 中止对局） ==');
storedLog.text =
  'GAME_START 1788540846\n' +
  'GAME_END NORMAL 1788540879\n' +          // 空对局
  'GAME_START 1788541420\n' +
  'GAME_END NORMAL 1788541438\n' +          // 空对局
  'GAME_START 1788572660\n' +
  '0 0 o undefined 1788572661\n' +          // 事故回合行（电脑动作 undefined）
  'GAME_END ABORT 1788572671\n' +           // 中止对局（构建时应被裁掉）
  'GAME_START 1788572736\n' +
  '0 0 o o 1788572737\n' +
  '1 1 o u 1788572740\n' +
  'GAME_END NORMAL 1788572754\n';
ModeAI.enter();   // 构建会话 + 开局（异常会在此抛出）
check(true, '脏日志构建会话 + 开局不抛异常');
check(builtSessions.length === 1, '首次进入只构建一次模型');
const gameLog1 = playOneGame(30);
{
  const lines = gameLog1.split('\n').filter(function (l) { return l.length > 0; });
  const roundLines = lines.filter(function (l) { return /^\d+ \d+ \S \S \d+$/.test(l); });
  let bad = 0;
  for (const l of roundLines) {
    if (!/^\d+ \d+ [uio] [uio] \d+$/.test(l)) bad++;
  }
  check(roundLines.length > 0, '打了一局且回合行非空（' + roundLines.length + ' 回合）');
  check(bad === 0, '全部回合行电脑动作为合法 u/i/o（非法 ' + bad + ' 行）');
  check(/GAME_END NORMAL/.test(gameLog1), '对局以 GAME_END NORMAL 正常结束');
  const dirty = gameLog1.indexOf('undefined');
  check(dirty === -1, '新日志无 undefined 污染');
}

// ==================== 场景 2：干净日志正常对局 ====================
console.log('== 场景 2：正常日志再打一局 ==');
storedLog.text = storedLog.text.replace(/GAME_START 1788572660[\s\S]*?GAME_END ABORT 1788572671\n/, '');
const latestLog = storedLog.text;
ModeAI.startGame();   // 再来一局：用上一局保存的日志重建模型
check(builtSessions.length === 2 && builtSessions[1].logText === latestLog,
  '连续对局无需刷新，第二局模型读取第一局完整日志');
check(builtSessions.length === 2 && decisionSessions[decisionSessions.length - 1] === builtSessions[1].session,
  '第二局首回合使用新构建的模型决策');
const buildsBeforePlay = builtSessions.length;
const gameLog2 = playOneGame(30);
check(builtSessions.length === buildsBeforePlay, '局内不重建模型');
{
  const lines = gameLog2.split('\n').filter(function (l) { return l.length > 0; });
  const roundLines = lines.filter(function (l) { return /^\d+ \d+ \S \S \d+$/.test(l); });
  let bad = 0;
  for (const l of roundLines) {
    if (!/^\d+ \d+ [uio] [uio] \d+$/.test(l)) bad++;
  }
  check(roundLines.length > 0 && bad === 0, '干净日志对局回合行全部合法（' + roundLines.length + ' 回合）');
  check(/GAME_END NORMAL/.test(gameLog2), '对局以 GAME_END NORMAL 正常结束');
}

// ==================== 场景 3：空日志（纯均衡路径） ====================
console.log('== 场景 3：空日志 ==');
storedLog.text = '';
window.ModeAI = null;
delete require.cache[require.resolve('../public/js/mode-ai.js')];
require('../public/js/mode-ai.js');
ModeAI.enter();
const gameLog3 = playOneGame(30);
{
  const lines = gameLog3.split('\n').filter(function (l) { return l.length > 0; });
  const roundLines = lines.filter(function (l) { return /^\d+ \d+ \S \S \d+$/.test(l); });
  let bad = 0;
  for (const l of roundLines) {
    if (!/^\d+ \d+ [uio] [uio] \d+$/.test(l)) bad++;
  }
  check(roundLines.length > 0 && bad === 0, '空日志对局回合行全部合法（' + roundLines.length + ' 回合）');
  check(/GAME_END NORMAL/.test(gameLog3), '对局以 GAME_END NORMAL 正常结束');
}

// ==================== 场景 4：返回菜单后重新进入 ====================
console.log('== 场景 4：返回菜单后重新进入 ==');
ModeAI.toMenu();
const beforeReenter = builtSessions.length;
const reenterLog = storedLog.text;
ModeAI.enter();
check(builtSessions.length === beforeReenter + 1 &&
  builtSessions[builtSessions.length - 1].logText === reenterLog,
  '返回菜单再进入时也读取最新日志');
check(builtSessions[builtSessions.length - 1].session.loaded.games.length === 1,
  '新模型已学习刚完成的正常对局');

// ==================== 场景 5：中止对局不参与学习 ====================
console.log('== 场景 5：中止对局不参与学习 ==');
ModeAI.abortToMenu();
ModeAI.enter();
check(builtSessions[builtSessions.length - 1].session.loaded.games.length === 1 &&
  storedLog.text.indexOf('GAME_END ABORT') === -1,
  '重建时剔除中止对局，保留正常对局');

// ==================== 场景 6：揭示期间重开与重复点击 ====================
console.log('== 场景 6：揭示期间重开与重复点击 ==');
const immediateTimeout = global.setTimeout;
const pendingTimers = [];
global.setTimeout = function (fn) { pendingTimers.push(fn); return pendingTimers.length; };
ModeAI.onAction(Game.ACT_O);   // 上一局揭示回调尚未执行
ModeAI.abortToMenu();
const beforeLoading = builtSessions.length;
const beforeDecisions = decisionSessions.length;
ModeAI.enter();
ModeAI.startGame();           // 加载期间重复点击
check(pendingTimers.length === 2 && builtSessions.length === beforeLoading,
  '加载先让出绘制时间，重复点击只安排一次模型构建');
pendingTimers.shift()();      // 旧揭示回调先于新模型构建执行
check(decisionSessions.length === beforeDecisions,
  '上一局揭示回调失效，不再启动旧局下一回合');
while (pendingTimers.length) pendingTimers.shift()();
check(builtSessions.length === beforeLoading + 1 &&
  decisionSessions.length === beforeDecisions + 1 &&
  decisionSessions[decisionSessions.length - 1] === builtSessions[builtSessions.length - 1].session,
  '异步加载完成后只开一局，并使用新模型');
check(builtSessions[builtSessions.length - 1].session.loaded.games.length === 1,
  '旧回调没有把中止局写成正常局');
global.setTimeout = immediateTimeout;

console.log(failures === 0 ? '\n人机模式冒烟测试全部通过 ✔' : '\n有 ' + failures + ' 项失败 ✘');
process.exit(failures === 0 ? 0 : 1);
