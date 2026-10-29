'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const storage = new Map([
  ['xnz_adaptive_consent_v1', 'deny'],
  ['xnz_training_consent_v1', 'deny'],
]);

function gradient() {
  return { addColorStop() {} };
}

const context = {
  beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {},
  fill() {}, stroke() {}, fillRect() {}, fillText() {},
  createLinearGradient: gradient, createRadialGradient: gradient,
};

global.canvas = { getContext() { return context; } };
global.wx = {
  getWindowInfo() {
    return { screenWidth: 390, screenHeight: 844, safeArea: { top: 44 } };
  },
  onTouchStart() {}, onTouchEnd() {}, onHide() {},
  getStorageSync(key) { return storage.get(key) || ''; },
  setStorageSync(key, value) { storage.set(key, value); },
  removeStorageSync(key) { storage.delete(key); },
  showToast() {}, showModal() {}, showLoading() {}, hideLoading() {},
};

function loadMain() {
  const filename = path.join(__dirname, '..', 'minigame', 'js', 'app.js');
  const source = fs.readFileSync(filename, 'utf8')
    .replace("import './render';", '')
    .replace('export default class Main', 'class Main')
    .concat('\nmodule.exports = Main;\n');
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(source, filename);
  return compiled.exports;
}

function main() {
  const Main = loadMain();
  const ui = new Main();
  ui.enterPvp('match');
  assert.equal(ui.screen, 'pvp-menu');
  assert.ok(ui.controls.some((control) => control.id === 'pvp-create'));
  assert.ok(ui.controls.some((control) => control.id === 'pvp-join'));

  ui.resetPvpState('match');
  ui.pvpState.code = '12345';
  ui.pvpState.seat = 1;
  ui.handlePvpMessage({
    type: 'game_started', mode: 'match', phase: 'pick', matchRound: 1,
    money: [50, 50], b1: 0, b2: 0, round: 1,
  });
  assert.equal(ui.screen, 'pvp-game');
  assert.equal(ui.pvpState.phase, 'pick');

  ui.handlePvpMessage({
    type: 'bullet_reveal', matchRound: 1, picks: [2, 1],
    b1: 2, b2: 1, round: 1, money: [50, 50],
  });
  assert.deepEqual(ui.pvpReveal, { human: 1, opponent: 2, pick: true });
  clearTimeout(ui.pvpRevealTimer);
  ui.pvpRevealTimer = null;
  ui.pvpReveal = null;

  const sent = [];
  ui.pvp = { send(value) { sent.push(value); return true; } };
  ui.playPvp(2);
  assert.deepEqual(sent.at(-1), { type: 'submit_action', action: 'o' });
  assert.equal(ui.pvpState.acted, true);

  ui.pvpState.acted = false;
  let revealDone;
  ui.schedulePvpReveal = (callback) => { revealDone = callback; ui.pvpRevealTimer = 1; };
  ui.handlePvpMessage({
    type: 'round_result', round: 4, matchRound: 5,
    a1: 'u', a2: 'i', outcome: 'p1_win', b1_next: 3, b2_next: 1,
    timeoutStrikes: [0, 0], picks: [2, 1], money: [72, 28],
    matchOver: true, matchWinner: 1,
  });
  ui.handlePvpMessage({
    type: 'game_over', result: 'lose', reason: 'match_end', rounds: 5,
    timeoutStrikes: [0, 0], money: [72, 28],
  });
  assert.equal(ui.screen, 'pvp-game', '终局先展示双方行动');
  ui.pvpRevealTimer = null;
  revealDone();
  assert.equal(ui.screen, 'result');
  assert.equal(ui.result.outcome, 'lose');
  assert.match(ui.result.reason, /你 28 \/ 好友 72/);

  ui.pvpState.status = 'finished';
  ui.rematchPvp();
  assert.deepEqual(sent.at(-1), { type: 'rematch_vote', accept: true });
  console.log('Mini-game PvP UI passed: room screens, hidden pick reveal, action submit, fifth-round result and rematch.');
}

main();
