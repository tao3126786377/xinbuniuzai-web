'use strict';

const assert = require('assert/strict');
const storage = new Map();
const calls = [];
const cloudCalls = [];

global.wx = {
  getStorageSync(key) { return storage.get(key) || ''; },
  setStorageSync(key, value) { storage.set(key, value); },
  removeStorageSync(key) { storage.delete(key); },
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
  const MatchClient = require('../minigame/js/core/match-client');
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
  assert.equal(calls[1].data.action, 2);

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
