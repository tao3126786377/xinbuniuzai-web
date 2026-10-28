'use strict';

const API_BASE = 'https://xinbuniuzai-web.onrender.com/api/match-ai';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestOnce(route, data, method) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${API_BASE}/${route}`,
      method: method || 'POST',
      data,
      timeout: 12000,
      header: { 'Content-Type': 'application/json' },
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
          return;
        }
        const error = new Error(
          response.data && response.data.error
            ? response.data.error
            : `服务器返回 ${response.statusCode}`,
        );
        error.status = response.statusCode;
        reject(error);
      },
      fail(failure) {
        reject(new Error(failure.errMsg || '网络连接失败'));
      },
    });
  });
}

async function request(route, data, method, retries, onRetry) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce(route, data, method);
    } catch (error) {
      const retryable = !error.status || error.status === 503 || error.status === 429;
      if (!retryable || attempt >= retries) throw error;
      if (onRetry) onRetry(attempt + 1);
      await sleep(1500);
    }
  }
}

function requestId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'y' ? (random & 3) | 8 : random;
    return value.toString(16);
  });
}

class MatchClient {
  constructor(options) {
    const config = options || {};
    this.memory = config.memory || null;
    this.data = null;
  }

  accept(value) {
    this.data = value;
    this.memory = value.memory;
    return value;
  }

  async start(onRetry) {
    const value = await request(
      'session',
      { memory: this.memory, requestId: requestId() },
      'POST',
      40,
      onRetry,
    );
    return this.accept(value);
  }

  async step(action) {
    if (!this.data || !this.data.ready) throw new Error('完整对局尚未准备好');
    const value = await request('step', {
      sessionId: this.data.sessionId,
      decisionId: this.data.ready.decisionId,
      action,
    }, 'POST', 1);
    return this.accept(value);
  }

  async rematch() {
    if (!this.data) throw new Error('完整对局尚未建立');
    const value = await request('rematch', {
      sessionId: this.data.sessionId,
      gameNumber: this.data.snapshot.gameNumber,
    }, 'POST', 1);
    return this.accept(value);
  }

  discard() {
    if (!this.data) return Promise.resolve();
    return request('session', { sessionId: this.data.sessionId }, 'DELETE', 0)
      .catch(() => undefined);
  }
}

MatchClient.API_BASE = API_BASE;

module.exports = MatchClient;
