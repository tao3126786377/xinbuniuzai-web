'use strict';

const Subpackage = require('./subpackage');

const SOURCES = {
  human: [
    'packs/sfx/sfx-gun-player.wav',
    'packs/sfx/sfx-guard-player.wav',
    'packs/sfx/sfx-reload-player.wav',
  ],
  opponent: [
    'packs/sfx/sfx-gun-player.wav',
    'packs/sfx/sfx-guard-opponent.wav',
    'packs/sfx/sfx-reload-opponent.wav',
  ],
};

const HITS = {
  human: 'packs/sfx/sfx-defend-player.wav',
  opponent: 'packs/sfx/sfx-defend-opponent.wav',
};

function sound(actor, action, delay, hit) {
  return { actor, action, delay: delay || 0, ...(hit ? { hit: true } : {}) };
}

function plan(human, opponent) {
  const shootActor = human === 0 ? 'human' : opponent === 0 ? 'opponent' : '';
  const otherAction = shootActor === 'human' ? opponent : human;
  const otherActor = shootActor === 'human' ? 'opponent' : 'human';

  if (shootActor && otherAction === 2) return [sound(shootActor, 0)];
  if (shootActor && otherAction === 1) {
    return [sound(shootActor, 0), sound(otherActor, 1, 150, true)];
  }
  return [sound('human', human), sound('opponent', opponent, 140)];
}

class EffectsController {
  constructor() {
    this.audios = { human: [], opponent: [] };
    this.hits = {};
    this.timers = [];
    this.sequence = 0;
    this.loading = Subpackage.load('sfx').then(() => this.create()).catch(() => false);
  }

  create() {
    Object.keys(this.audios).forEach((actor) => {
      SOURCES[actor].forEach((src, action) => {
        const audio = wx.createInnerAudioContext();
        audio.src = src;
        audio.volume = action === 0 ? (actor === 'human' ? 0.58 : 0.48) : 0.52;
        this.audios[actor][action] = audio;
      });
      const hit = wx.createInnerAudioContext();
      hit.src = HITS[actor];
      hit.volume = 0.56;
      this.hits[actor] = hit;
    });
    return true;
  }

  play(actor, action, hit) {
    const audio = hit ? this.hits[actor] : this.audios[actor] && this.audios[actor][action];
    if (!audio) return;
    if (audio.stop) audio.stop();
    if (audio.seek) audio.seek(0);
    audio.play();
  }

  playRound(human, opponent) {
    const sequence = ++this.sequence;
    this.clearTimers();
    const items = plan(human, opponent);
    this.loading.then((ready) => {
      if (!ready || sequence !== this.sequence) return;
      items.forEach((item) => {
        if (!item.delay) this.play(item.actor, item.action, item.hit);
        else this.timers.push(setTimeout(() => this.play(item.actor, item.action, item.hit), item.delay));
      });
    });
  }

  clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  stop() {
    this.sequence++;
    this.clearTimers();
    Object.keys(this.audios).forEach((actor) => {
      this.audios[actor].forEach((audio) => { if (audio.stop) audio.stop(); });
      if (this.hits[actor] && this.hits[actor].stop) this.hits[actor].stop();
    });
  }
}

EffectsController.plan = plan;
EffectsController.SOURCES = SOURCES;
EffectsController.HITS = HITS;

module.exports = EffectsController;
