'use strict';

const CONSENT_VERSION = '2026-10-28-v1';
const CONSENT_KEY = 'xnz_adaptive_consent_v1';
const PENDING_DELETE_KEY = 'xnz_adaptive_delete_pending_v1';

function get(key) {
  try { return wx.getStorageSync(key); }
  catch (error) { return ''; }
}

function set(key, value) {
  try { wx.setStorageSync(key, value); return true; }
  catch (error) { return false; }
}

function remove(key) {
  try { wx.removeStorageSync(key); }
  catch (error) { /* 保留标记，稍后重试删除 */ }
}

function request(action, payload) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud) {
      reject(new Error('当前微信基础库不支持云开发'));
      return;
    }
    wx.cloud.callFunction({
      name: 'adaptive-memory',
      data: { action, payload },
      success(response) {
        const value = response.result;
        if (value && value.ok) {
          resolve(value);
          return;
        }
        reject(new Error(value && value.error ? value.error : '云函数返回异常'));
      },
      fail(error) { reject(new Error(error.errMsg || '网络连接失败')); },
    });
  });
}

function consent() {
  return get(CONSENT_KEY) || 'unset';
}

function setConsent(allowed) {
  return set(CONSENT_KEY, allowed ? 'allow' : 'deny');
}

async function load() {
  if (consent() !== 'allow') return { quickLog: '', fullMemory: null, skipped: true };
  return request('get', { consent: true, consentVersion: CONSENT_VERSION });
}

async function saveQuick(quickLog) {
  if (consent() !== 'allow') return { skipped: true };
  return request('saveQuick', {
    consent: true,
    consentVersion: CONSENT_VERSION,
    quickLog,
  });
}

async function saveFull(fullMemory) {
  if (consent() !== 'allow' || !fullMemory) return { skipped: true };
  return request('saveFull', {
    consent: true,
    consentVersion: CONSENT_VERSION,
    fullMemory,
  });
}

async function withdrawAndDelete() {
  setConsent(false);
  set(PENDING_DELETE_KEY, '1');
  const value = await request('delete', {});
  remove(PENDING_DELETE_KEY);
  return value;
}

function hasPendingDeletion() {
  return consent() === 'deny' && get(PENDING_DELETE_KEY) === '1';
}

module.exports = {
  CONSENT_VERSION,
  consent,
  setConsent,
  load,
  saveQuick,
  saveFull,
  withdrawAndDelete,
  hasPendingDeletion,
};
