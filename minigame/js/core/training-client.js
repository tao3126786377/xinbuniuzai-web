'use strict';

const CLOUD_ENV = 'cloud1-d1gclwenrc6f659c0';
const CONSENT_VERSION = '2026-10-28-v1';
const CONSENT_KEY = 'xnz_training_consent_v1';
const PENDING_DELETE_KEY = 'xnz_training_delete_pending_v1';
const NETWORK_NOTICE_KEY = 'xnz_match_network_notice_v1';
const APP_VERSION = 'minigame-0.3.0';

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

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
  catch (error) { /* 保留本地标识以便稍后重试删除 */ }
}

function request(action, payload) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud) {
      reject(new Error('当前微信基础库不支持云开发'));
      return;
    }
    wx.cloud.callFunction({
      name: 'training-data',
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

function hasAcceptedNetworkNotice() {
  return get(NETWORK_NOTICE_KEY) === CONSENT_VERSION;
}

function acceptNetworkNotice() {
  set(NETWORK_NOTICE_KEY, CONSENT_VERSION);
}

async function upload(record) {
  if (consent() !== 'allow') return { skipped: true };
  const payload = {
    ...record,
    recordId: randomId('game'),
    consent: true,
    consentVersion: CONSENT_VERSION,
    appVersion: APP_VERSION,
  };
  return request('upload', payload);
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
  APP_VERSION,
  CLOUD_ENV,
  CONSENT_VERSION,
  consent,
  setConsent,
  hasAcceptedNetworkNotice,
  acceptNetworkNotice,
  upload,
  withdrawAndDelete,
  hasPendingDeletion,
};
