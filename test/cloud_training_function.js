'use strict';

const assert = require('assert/strict');
const Module = require('module');
const path = require('path');

async function main() {
  const documents = new Map();
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init() {},
    getWXContext() { return { OPENID: 'test-openid-value', APPID: 'test-appid' }; },
    database() {
      return {
        serverDate() { return 'SERVER_DATE'; },
        collection(name) {
          assert.equal(name, 'training_matches');
          return {
            doc(id) {
              return { set({ data }) { documents.set(id, data); return Promise.resolve({}); } };
            },
            where(query) {
              return {
                async remove() {
                  let removed = 0;
                  for (const [id, value] of documents) {
                    if (value.playerHash === query.playerHash) { documents.delete(id); removed++; }
                  }
                  return { stats: { removed } };
                },
              };
            },
          };
        },
      };
    },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.TRAINING_HASH_SECRET = 'test-cloud-hash-secret-1234567890';

  try {
    const fn = require(path.join('..', 'minigame', 'cloudfunctions', 'training-data', 'index.js'));
    const invalid = await fn.main({ action: 'upload', payload: {} });
    assert.equal(invalid.ok, false);

    const payload = {
      consent: true,
      consentVersion: '2026-10-28-v1',
      recordId: 'game_1234567890abcdef',
      mode: 'quick',
      startedAt: 1,
      endedAt: 2,
      outcome: 'win',
      events: [{ round: 1, playerAction: 2, computerAction: 1 }],
      final: { playerBullets: 1, computerBullets: 0 },
      appVersion: 'test',
    };
    assert.equal((await fn.main({ action: 'upload', payload })).ok, true);
    assert.equal((await fn.main({ action: 'upload', payload })).ok, true);
    assert.equal(documents.size, 1, 'record id must be idempotent');
    const stored = documents.get(payload.recordId);
    assert.equal(stored.clientId, undefined);
    assert.equal(stored.openid, undefined);
    assert.equal(stored.playerHash.length, 64);
    assert.equal(stored.createdAt, 'SERVER_DATE');

    const deleted = await fn.main({ action: 'delete', payload: {} });
    assert.equal(deleted.removed, 1);
    assert.equal(documents.size, 0);
    console.log('Cloud training function passed: consent, HMAC, idempotency and deletion.');
  } finally {
    Module._load = originalLoad;
    delete process.env.TRAINING_HASH_SECRET;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
