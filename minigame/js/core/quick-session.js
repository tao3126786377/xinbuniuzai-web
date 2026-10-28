'use strict';

const Game = require('./game');
const AI = require('./ai');
const Strategies = require('./strategies');

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

class QuickSession {
  constructor(options) {
    const config = options || {};
    this.startedAt = Date.now();
    this.logText = typeof config.logText === 'string' ? config.logText : '';
    this.onSave = typeof config.onSave === 'function' ? config.onSave : null;
    this.ai = AI.buildAiSession(this.logText, Strategies);
    if (this.ai.loaded.changed) {
      this.logText = this.ai.loaded.prunedText;
      this.save();
    }

    this.b1 = 0;
    this.b2 = 0;
    this.round = 1;
    this.mem = 0;
    this.over = false;
    this.computerAction = -1;
    this.history = [];
    this.logLines = [`GAME_START ${nowSec()}`];
    this.prepareTurn();
  }

  prepareTurn() {
    const probabilities = AI.computeFinalStrategyMem(
      this.ai,
      this.b1,
      this.b2,
      this.mem,
    );
    this.computerAction = AI.sampleAction(probabilities);
  }

  play(playerAction) {
    if (this.over) throw new Error('Quick game already ended');
    if (!Game.isFeasible(this.b1, playerAction)) throw new Error('Illegal quick action');

    const computerAction = this.computerAction;
    const beforeB1 = this.b1;
    const beforeB2 = this.b2;
    const playerChar = Game.ACT_CHARS[playerAction];
    const computerChar = Game.ACT_CHARS[computerAction];
    this.mem = AI.memIndex(playerChar, computerChar);
    this.logLines.push(`${this.b1} ${this.b2} ${playerChar} ${computerChar} ${nowSec()}`);

    const step = Game.step(this.b1, this.b2, playerAction, computerAction);
    this.b1 = step.b1;
    this.b2 = step.b2;

    let outcome = 'continue';
    if (step.winner === 1) outcome = 'win';
    else if (step.winner === 2) outcome = 'lose';
    else if (step.winner === 0) outcome = 'draw';

    const event = {
      round: this.round,
      b1: beforeB1,
      b2: beforeB2,
      playerAction,
      computerAction,
      outcome,
    };
    this.history.push(event);

    if (outcome === 'continue' && this.round >= Game.MAX_ROUNDS) {
      return this.finish('draw', `回合数达到 ${Game.MAX_ROUNDS} 上限，平局！`, event);
    }

    if (outcome !== 'continue') {
      let reason = '双方子弹都达到了 10 颗。';
      if (outcome === 'win') {
        reason = step.instant ? '你打中了装弹的电脑！' : '你的子弹率先攒到了 5 颗！';
      } else if (outcome === 'lose') {
        reason = step.instant ? '电脑打中了正在装弹的你！' : '电脑的子弹率先攒到了 5 颗！';
      }
      return this.finish(outcome, reason, event);
    }

    this.round++;
    this.prepareTurn();
    return { ...event, reason: '' };
  }

  finish(outcome, reason, event) {
    this.over = true;
    this.logLines.push(`GAME_END NORMAL ${nowSec()}`);
    this.logText += `${this.logLines.join('\n')}\n`;
    this.save();
    return { ...event, outcome, reason };
  }

  abort() {
    if (this.over) return;
    this.over = true;
    this.logLines.push(`GAME_END ABORT ${nowSec()}`);
    this.logText += `${this.logLines.join('\n')}\n`;
    this.save();
  }

  save() {
    if (this.onSave) this.onSave(this.logText);
  }

  getLog() {
    return this.logText;
  }

  trainingRecord(outcome) {
    return {
      mode: 'quick',
      startedAt: this.startedAt,
      endedAt: Date.now(),
      outcome,
      events: this.history.map((event) => ({
        round: event.round,
        playerBullets: event.b1,
        computerBullets: event.b2,
        playerAction: event.playerAction,
        computerAction: event.computerAction,
        outcome: event.outcome,
      })),
      final: { playerBullets: this.b1, computerBullets: this.b2 },
    };
  }
}

QuickSession.Game = Game;

module.exports = QuickSession;
