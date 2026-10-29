'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const storage = new Map();
const calls = [];
const cloudCalls = [];
const sockets = [];
const audios = [];
const subpackages = [];

function fakeSocket(options) {
  const handlers = {};
  const socket = {
    options,
    sent: [],
    closed: false,
    onOpen(fn) { handlers.open = fn; },
    onMessage(fn) { handlers.message = fn; },
    onClose(fn) { handlers.close = fn; },
    onError(fn) { handlers.error = fn; },
    send(value) { this.sent.push(JSON.parse(value.data)); },
    close() { this.closed = true; if (handlers.close) handlers.close({}); },
    emitOpen() { handlers.open(); },
    emitMessage(value) { handlers.message({ data: JSON.stringify(value) }); },
  };
  sockets.push(socket);
  return socket;
}

global.wx = {
  getStorageSync(key) { return storage.get(key) || ''; },
  setStorageSync(key, value) { storage.set(key, value); },
  removeStorageSync(key) { storage.delete(key); },
  connectSocket(options) { return fakeSocket(options); },
  loadSubpackage(options) {
    subpackages.push(options.name);
    options.success({});
    return { onProgressUpdate() {} };
  },
  createInnerAudioContext() {
    const handlers = {};
    const audio = {
      playing: false,
      play() { this.playing = true; if (handlers.play) handlers.play(); },
      pause() { this.playing = false; if (handlers.pause) handlers.pause(); },
      stop() { this.playing = false; if (handlers.stop) handlers.stop(); },
      seek(value) { this.position = value; },
      onPlay(fn) { handlers.play = fn; },
      onPause(fn) { handlers.pause = fn; },
      onStop(fn) { handlers.stop = fn; },
      onError(fn) { handlers.error = fn; },
    };
    audios.push(audio);
    return audio;
  },
  request(options) {
    calls.push(options);
    const session = {
      sessionId: 'session-1', memory: { belief: 1 }, ready: { decisionId: 'decision-1' },
      snapshot: { gameNumber: 1, over: false, state: { phase: 'pick' } },
    };
    if (options.url.endsWith('/step')) {
      options.success({ statusCode: 200, data: { ...session, ready: { decisionId: 'decision-2' } } });
    } else if (options.url.endsWith('/rematch')) {
      options.success({ statusCode: 200, data: { ...session, snapshot: { ...session.snapshot, gameNumber: 2 } } });
    } else {
      options.success({ statusCode: 200, data: session });
    }
    return { abort() {} };
  },
  cloud: {
    callFunction(options) {
      cloudCalls.push(options);
      let value;
      if (options.name === 'adaptive-memory' && options.data.action === 'get') {
        value = { ok: true, quickLog: 'saved-log', fullMemory: { belief: 4 } };
      } else if (options.data.action === 'delete') {
        value = { ok: true, removed: 1 };
      } else {
        value = { ok: true, saved: true };
      }
      options.success({ result: value });
    },
  },
};

async function main() {
  const entry = fs.readFileSync(path.join(__dirname, '../minigame/game.js'), 'utf8');
  assert(entry.includes('wx.setInnerAudioOption'), 'global audio policy must be configured');
  assert(entry.includes('obeyMuteSwitch: false'), 'iOS mute switch must not silence the game');
  assert(entry.includes('speakerOn: true'), 'audio output must use the speaker');

  const MatchClient = require('../minigame/js/core/match-client');
  const PvpClient = require('../minigame/js/core/pvp-client');
  const MusicController = require('../minigame/js/core/music');
  const EffectsController = require('../minigame/js/core/effects');
  const QuickSession = require('../minigame/js/core/quick-session');
  const Adaptive = require('../minigame/js/core/adaptive-client');
  const Training = require('../minigame/js/core/training-client');
  const match = new MatchClient({ memory: { belief: 0 } });
  await match.start();
  assert.deepEqual(match.memory, { belief: 1 });
  assert.equal(storage.has('xnz_match_memory_v1'), false);
  await match.step(2);
  await match.rematch();
  await match.discard();
  assert.deepEqual(calls.slice(0, 4).map((call) => call.method), ['POST', 'POST', 'POST', 'DELETE']);
  assert.match(calls[0].data.requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(calls[1].data.action, 2);

  const pvpMessages = [];
  const pvp = new PvpClient({ onMessage(value) { pvpMessages.push(value); } });
  pvp.create('match');
  const socket = sockets.at(-1);
  assert.equal(socket.options.url, 'wss://xinbuniuzai-web.onrender.com');
  socket.emitOpen();
  assert.deepEqual(socket.sent[0], { type: 'create_room', mode: 'match' });
  socket.emitMessage({ type: 'room_created', code: '12345', seat: 0, token: 'token-1' });
  assert.equal(JSON.parse(storage.get(PvpClient.SESSION_KEY)).code, '12345');
  pvp.send({ type: 'submit_bullets', bullets: 2 });
  assert.deepEqual(socket.sent.at(-1), { type: 'submit_bullets', bullets: 2 });
  assert.equal(pvpMessages.at(-1).type, 'room_created');
  pvp.leave();
  assert.equal(storage.has(PvpClient.SESSION_KEY), false);
  assert.equal(socket.closed, true);

  const music = new MusicController();
  assert.equal(music.isEnabled(), false);
  assert.equal(music.toggle(), true);
  await music.loading;
  assert.equal(audios.at(-1).src, MusicController.MUSIC_URL);
  assert.equal(audios.at(-1).volume, 0.22);
  assert.equal(audios.at(-1).playing, true);
  assert.equal(music.toggle(), false);
  assert.equal(audios.at(-1).playing, false);

  assert.deepEqual(EffectsController.plan(2, 0), [
    { actor: 'opponent', action: 0, delay: 0 },
  ]);
  assert.deepEqual(EffectsController.plan(1, 0), [
    { actor: 'opponent', action: 0, delay: 0 },
    { actor: 'human', action: 1, delay: 150, hit: true },
  ]);
  assert.deepEqual(EffectsController.plan(0, 1), [
    { actor: 'human', action: 0, delay: 0 },
    { actor: 'opponent', action: 1, delay: 150, hit: true },
  ]);
  assert.deepEqual(EffectsController.plan(0, 0), [
    { actor: 'human', action: 0, delay: 0 },
    { actor: 'opponent', action: 0, delay: 140 },
  ]);
  const effects = new EffectsController();
  await effects.loading;
  assert.equal(audios.at(-8).src, 'assets/sfx/sfx-gun-player.wav');
  assert.equal(audios.at(-7).src, 'assets/sfx/sfx-guard-player.wav');
  assert.equal(audios.at(-4).src, 'assets/sfx/sfx-gun-player.wav');
  assert.equal(audios.at(-3).src, 'assets/sfx/sfx-guard-opponent.wav');
  assert.equal(EffectsController.HITS.human, 'assets/sfx/sfx-defend-player.wav');
  effects.playRound(2, 0);
  await Promise.resolve();
  assert.equal(audios.at(-4).playing, true);
  effects.stop();
  assert.deepEqual(subpackages, []);

  let savedQuickLog = '';
  const quick = new QuickSession({ onSave(value) { savedQuickLog = value; } });
  quick.abort();
  assert.match(savedQuickLog, /GAME_END ABORT/);
  assert.equal(storage.has('xnz_log_v1'), false);

  assert.equal(Adaptive.consent(), 'unset');
  Adaptive.setConsent(true);
  const adaptive = await Adaptive.load();
  assert.equal(adaptive.quickLog, 'saved-log');
  assert.deepEqual(adaptive.fullMemory, { belief: 4 });
  await Adaptive.saveQuick('next-log');
  await Adaptive.saveFull({ belief: 5 });
  assert.equal(cloudCalls.find((call) => call.data.action === 'saveQuick').name, 'adaptive-memory');
  assert.equal(cloudCalls.find((call) => call.data.action === 'saveFull').name, 'adaptive-memory');
  await Adaptive.withdrawAndDelete();
  assert.equal(Adaptive.consent(), 'deny');
  const adaptiveCalls = cloudCalls.length;
  assert.equal((await Adaptive.saveQuick('must-not-upload')).skipped, true);
  assert.equal(cloudCalls.length, adaptiveCalls, 'denied adaptive memory must not call cloud');

  assert.equal(Training.consent(), 'unset');
  Training.setConsent(true);
  await Training.upload({
    mode: 'quick', startedAt: 1, endedAt: 2, outcome: 'win', events: [], final: {},
  });
  const uploadCall = cloudCalls.find((call) => call.data.action === 'upload');
  assert.equal(uploadCall.name, 'training-data');
  const upload = uploadCall.data.payload;
  assert.equal(upload.consent, true);
  assert.equal(upload.consentVersion, Training.CONSENT_VERSION);
  assert.equal(upload.appVersion, 'minigame-0.3.0');
  assert.equal(upload.nickname, undefined);
  assert.equal(upload.openid, undefined);
  assert.equal(upload.clientId, undefined);

  const deleted = await Training.withdrawAndDelete();
  assert.equal(deleted.removed, 1);
  assert.equal(Training.consent(), 'deny');
  assert.equal(cloudCalls.at(-1).data.action, 'delete');
  const trainingCalls = cloudCalls.length;
  assert.equal((await Training.upload({ mode: 'quick' })).skipped, true);
  assert.equal(cloudCalls.length, trainingCalls, 'denied training must not call cloud');
  console.log('Mini-game clients passed: match lifecycle, optional upload and withdrawal.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
