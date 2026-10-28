'use strict';

const crypto = require('crypto');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const COLLECTION = 'training_matches';
const CONSENT_VERSION = '2026-10-28-v1';
const MAX_EVENTS = 520;
const MAX_BYTES = 240 * 1024;

function validId(value, maximum) {
  return typeof value === 'string'
    && value.length >= 16
    && value.length <= maximum
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function playerHash(identity) {
  const secret = process.env.TRAINING_HASH_SECRET;
  if (!secret || secret.length < 24) throw new Error('TRAINING_HASH_SECRET_NOT_CONFIGURED');
  if (!identity || !identity.openid) throw new Error('WECHAT_IDENTITY_UNAVAILABLE');
  return crypto.createHmac('sha256', secret)
    .update(`${identity.appid || ''}:${identity.openid}`)
    .digest('hex');
}

function trainingRecord(value, identity) {
  if (!value || value.consent !== true || value.consentVersion !== CONSENT_VERSION) {
    throw new Error('CONSENT_REQUIRED');
  }
  if (!validId(value.recordId, 128)) {
    throw new Error('INVALID_RECORD_ID');
  }
  if (value.mode !== 'quick' && value.mode !== 'match') throw new Error('INVALID_MODE');
  if (!Array.isArray(value.events) || value.events.length > MAX_EVENTS) {
    throw new Error('INVALID_EVENTS');
  }
  if (!['win', 'lose', 'draw'].includes(value.outcome)) throw new Error('INVALID_OUTCOME');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) throw new Error('RECORD_TOO_LARGE');

  return {
    schema: 'xnz-training-v1',
    consentVersion: CONSENT_VERSION,
    recordId: value.recordId,
    playerHash: playerHash(identity),
    mode: value.mode,
    startedAt: Number(value.startedAt) || null,
    endedAt: Number(value.endedAt) || Date.now(),
    outcome: value.outcome,
    events: value.events,
    final: value.final && typeof value.final === 'object' ? value.final : null,
    appVersion: typeof value.appVersion === 'string' ? value.appVersion.slice(0, 40) : '',
    createdAt: db.serverDate(),
  };
}

async function upload(payload, identity) {
  const record = trainingRecord(payload, identity);
  await db.collection(COLLECTION).doc(record.recordId).set({ data: record });
  return { ok: true, saved: true };
}

async function removePlayer(identity) {
  const result = await db.collection(COLLECTION)
    .where({ playerHash: playerHash(identity) })
    .remove();
  return { ok: true, removed: result.stats ? result.stats.removed : 0 };
}

exports.main = async (event) => {
  try {
    if (!event || typeof event !== 'object') throw new Error('INVALID_REQUEST');
    const context = cloud.getWXContext();
    const identity = { openid: context.OPENID, appid: context.APPID };
    if (event.action === 'upload') return await upload(event.payload, identity);
    if (event.action === 'delete') return await removePlayer(identity);
    if (event.action === 'status') {
      playerHash(identity);
      return { ok: true, consentVersion: CONSENT_VERSION };
    }
    throw new Error('UNKNOWN_ACTION');
  } catch (error) {
    return { ok: false, error: error.message || 'CLOUD_FUNCTION_FAILED' };
  }
};
