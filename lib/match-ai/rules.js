'use strict';
const Game = require('../../public/js/game');
const Match = require('../../public/js/match');

// Computer is always seat 0 inside this module (unlike the quick-mode UI).
function initialState() {
  return { phase: 'pick', round: 1, turn: 1, mc: 50, mh: 50,
    pc: 0, ph: 0, bc: 0, bh: 0, previous: [-1, -1], last_result: 0 };
}
function actions(s) {
  if (s.phase === 'pick') return [[0, 1, 2], [0, 1, 2]];
  if (s.phase !== 'play') throw new Error('Unknown match phase');
  return [Game.feasible(s.bc), Game.feasible(s.bh)];
}
function transition(s, computer, human) {
  const [ac, ah] = actions(s);
  if (!ac.includes(computer) || !ah.includes(human)) throw new Error('Illegal simultaneous action');
  if (s.phase === 'pick') return { state: { ...s, phase: 'play', turn: 1,
    pc: computer, ph: human, bc: computer, bh: human, previous: [-1, -1] }, score: null, settlement: {} };
  const next = Game.step(s.bc, s.bh, computer, human);
  const capped = next.winner === -1 && s.turn >= Game.MAX_ROUNDS;
  if (next.winner === -1 && !capped) return { state: { ...s, turn: s.turn + 1,
    bc: next.b1, bh: next.b2, previous: [computer, human] }, score: null, settlement: {} };
  const winner = capped ? 0 : next.winner;
  const final = Match.finalBullets(s.bc, s.bh, computer, human, winner);
  const money = Match.settleRoundMoney(s.mc, s.mh, s.pc, s.ph, winner, final.b1, final.b2);
  const settlement = { round_end: true, winner, capped, instant: next.instant,
    final_bullets: [final.b1, final.b2], money: [money.money1, money.money2],
    transfer: winner === 2 && money.transfer !== 0 ? -money.transfer : money.transfer };
  const end = Match.checkMatchOver(money.money1, money.money2, s.round);
  if (end.over) return { state: null, score: end.winner === 1 ? 1 : end.winner === 2 ? 0 : 0.5, settlement };
  return { state: { ...initialState(), round: s.round + 1, mc: money.money1, mh: money.money2,
    last_result: winner === 1 ? 1 : winner === 2 ? -1 : 0 }, score: null, settlement };
}
function event(s, a, b, result) {
  return [1, Number(s.phase === 'pick'), ...[0, 1, 2].map(x => Number(a === x)),
    ...[0, 1, 2].map(x => Number(b === x)), Number(!!result.settlement.round_end),
    Number(result.state === null), result.settlement.winner === 1 ? 1 : result.settlement.winner === 2 ? -1 : 0];
}
function remember(history, token) { return history.concat([token]).slice(-64); }
module.exports = { initialState, actions, transition, event, remember };
