'use strict';

const STORAGE_KEY = 'xnz_minigame_ai_stats_v1';

function emptyStats() {
  return {
    version: 1,
    quick: { wins: 0, losses: 0, draws: 0 },
    match: { wins: 0, losses: 0, draws: 0 },
  };
}

function validBucket(value) {
  return value && ['wins', 'losses', 'draws'].every(
    (key) => Number.isSafeInteger(value[key]) && value[key] >= 0,
  );
}

function load() {
  try {
    const saved = wx.getStorageSync(STORAGE_KEY);
    const value = typeof saved === 'string' ? JSON.parse(saved || 'null') : saved;
    if (value && value.version === 1 && validBucket(value.quick) && validBucket(value.match)) {
      return value;
    }
  } catch (_) {}
  return emptyStats();
}

function record(mode, outcome) {
  const stats = load();
  const bucket = mode === 'quick' ? stats.quick : mode === 'match' ? stats.match : null;
  const key = outcome === 'win' ? 'wins' : outcome === 'lose' ? 'losses' : outcome === 'draw' ? 'draws' : '';
  if (!bucket || !key) return false;
  bucket[key]++;
  try {
    wx.setStorageSync(STORAGE_KEY, JSON.stringify(stats));
    return true;
  } catch (_) {
    return false;
  }
}

function format(label, bucket) {
  const total = bucket.wins + bucket.losses + bucket.draws;
  if (!total) return `${label}：暂无对局记录`;
  const decisive = bucket.wins + bucket.losses;
  const rate = decisive ? Math.round(bucket.wins / decisive * 100) : 0;
  return `${label}：${total} 局（胜 ${bucket.wins} / 负 ${bucket.losses} / 平 ${bucket.draws}，胜率 ${rate}%）`;
}

function lines() {
  const stats = load();
  return {
    quick: format('快速模式', stats.quick),
    match: format('完整模式', stats.match),
  };
}

module.exports = { STORAGE_KEY, load, record, lines };
