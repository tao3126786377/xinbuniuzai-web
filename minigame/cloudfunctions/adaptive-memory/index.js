'use strict';

const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const COLLECTION = 'adaptive_memory';
const CONSENT_VERSION = '2026-10-28-v1';
const MAX_QUICK_BYTES = 2 * 1024 * 1024;
const MAX_FULL_BYTES = 512 * 1024;

function playerHash(identity) {
  const secret = process.env.ADAPTIVE_HASH_SECRET;
  if (!secret || secret.length < 24) throw new Error('ADAPTIVE_HASH_SECRET_NOT_CONFIGURED');
  if (!identity || !identity.openid) throw new Error('WECHAT_IDENTITY_UNAVAILABLE');
  return crypto.createHmac('sha256', secret)
    .update(`adaptive-v1:${identity.appid || ''}:${identity.openid}`)
    .digest('hex');
}

function requireConsent(payload) {
  if (!payload || payload.consent !== true || payload.consentVersion !== CONSENT_VERSION) {
    throw new Error('CONSENT_REQUIRED');
  }
}

async function readRecord(id) {
  try {
    const result = await db.collection(COLLECTION).doc(id).get();
    return result.data || {};
  } catch (error) {
    return {};
  }
}

async function load(identity, payload) {
  requireConsent(payload);
  const record = await readRecord(playerHash(identity));
  return {
    ok: true,
    quickLog: typeof record.quickLog === 'string' ? record.quickLog : '',
    fullMemory: record.fullMemory && typeof record.fullMemory === 'object'
      ? record.fullMemory
      : null,
  };
}

async function save(identity, payload, field) {
  requireConsent(payload);
  const id = playerHash(identity);
  const current = await readRecord(id);
  if (field === 'quickLog') {
    if (typeof payload.quickLog !== 'string'
      || Buffer.byteLength(payload.quickLog, 'utf8') > MAX_QUICK_BYTES) {
      throw new Error('INVALID_QUICK_MEMORY');
    }
    current.quickLog = payload.quickLog;
  } else {
    if (!payload.fullMemory || typeof payload.fullMemory !== 'object'
      || Buffer.byteLength(JSON.stringify(payload.fullMemory), 'utf8') > MAX_FULL_BYTES) {
      throw new Error('INVALID_FULL_MEMORY');
    }
    current.fullMemory = payload.fullMemory;
  }
  await db.collection(COLLECTION).doc(id).set({
    data: {
      schema: 'xnz-adaptive-v1',
      consentVersion: CONSENT_VERSION,
      quickLog: typeof current.quickLog === 'string' ? current.quickLog : '',
      fullMemory: current.fullMemory && typeof current.fullMemory === 'object'
        ? current.fullMemory
        : null,
      updatedAt: db.serverDate(),
    },
  });
  return { ok: true, saved: true };
}

async function remove(identity) {
  const id = playerHash(identity);
  try {
    await db.collection(COLLECTION).doc(id).remove();
    return { ok: true, removed: 1 };
  } catch (error) {
    return { ok: true, removed: 0 };
  }
}

exports.main = async (event) => {
  try {
    if (!event || typeof event !== 'object') throw new Error('INVALID_REQUEST');
    const context = cloud.getWXContext();
    const identity = { openid: context.OPENID, appid: context.APPID };
    if (event.action === 'get') return await load(identity, event.payload);
    if (event.action === 'saveQuick') return await save(identity, event.payload, 'quickLog');
    if (event.action === 'saveFull') return await save(identity, event.payload, 'fullMemory');
    if (event.action === 'delete') return await remove(identity);
    throw new Error('UNKNOWN_ACTION');
  } catch (error) {
    return { ok: false, error: error.message || 'CLOUD_FUNCTION_FAILED' };
  }
};
