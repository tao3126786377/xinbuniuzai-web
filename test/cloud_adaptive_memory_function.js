'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
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
          assert.equal(name, 'adaptive_memory');
          return {
            doc(id) {
              return {
                async get() {
                  if (!documents.has(id)) throw new Error('NOT_FOUND');
                  return { data: documents.get(id) };
                },
                async set({ data }) { documents.set(id, data); },
                async remove() {
                  if (!documents.delete(id)) throw new Error('NOT_FOUND');
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
  process.env.ADAPTIVE_HASH_SECRET = 'adaptive-cloud-secret-123456789012345';

  try {
    const fn = require(path.join('..', 'minigame', 'cloudfunctions', 'adaptive-memory', 'index.js'));
    const consent = { consent: true, consentVersion: '2026-10-28-v1' };
    assert.equal((await fn.main({ action: 'get', payload: consent })).quickLog, '');
    assert.equal((await fn.main({
      action: 'saveQuick', payload: { ...consent, quickLog: 'GAME_START 1\nGAME_END NORMAL 2\n' },
    })).ok, true);
    assert.equal((await fn.main({
      action: 'saveFull', payload: { ...consent, fullMemory: { observations: 3 } },
    })).ok, true);

    assert.equal(documents.size, 1);
    const [id, record] = documents.entries().next().value;
    const trainingHash = crypto.createHmac('sha256', 'adaptive-cloud-secret-123456789012345')
      .update('test-appid:test-openid-value').digest('hex');
    assert.equal(id.length, 64);
    assert.notEqual(id, trainingHash, 'adaptive hash must use a separate namespace');
    assert.equal(record.openid, undefined);
    assert.equal(record.playerHash, undefined);
    assert.equal(record.consentVersion, '2026-10-28-v1');
    assert.equal(record.quickLog.includes('GAME_START'), true);
    assert.deepEqual(record.fullMemory, { observations: 3 });

    const loaded = await fn.main({ action: 'get', payload: consent });
    assert.equal(loaded.quickLog, record.quickLog);
    assert.deepEqual(loaded.fullMemory, record.fullMemory);
    assert.equal((await fn.main({ action: 'saveQuick', payload: { quickLog: 'x' } })).ok, false);

    const deleted = await fn.main({ action: 'delete', payload: {} });
    assert.equal(deleted.removed, 1);
    assert.equal(documents.size, 0);
    delete process.env.ADAPTIVE_HASH_SECRET;
    assert.equal((await fn.main({ action: 'delete', payload: {} })).ok, false);
    console.log('Cloud adaptive memory passed: separate HMAC, save/load and deletion.');
  } finally {
    Module._load = originalLoad;
    delete process.env.ADAPTIVE_HASH_SECRET;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
