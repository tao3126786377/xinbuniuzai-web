'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
function createHandler({ originAllowed, clientIp }) {
  let worker = null, ready = false, serial = 0, stopped = false;
  const pending = new Map(), buckets = new Map();
  function rejectAll() {
    ready = false;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject({ status: 503, message: '电脑服务正在准备，请稍后重试' }); }
    pending.clear();
  }
  function start() {
    if (worker || stopped) return;
    const next = new Worker(path.join(__dirname,'worker.js'),{ workerData: { tablesPath: process.env.MATCH_AI_TABLES_PATH } });
    worker = next;
    next.on('message',msg => {
      if (msg.ready) { ready = true; console.log('[完整人机] '+msg.policy+' 已就绪'); return; }
      const p = pending.get(msg.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value); else p.reject({ status: msg.status, message: msg.message });
    });
    next.on('error',error => console.error('[完整人机] 工作线程错误:',error.message));
    next.on('exit',() => { if (worker === next) { worker = null; rejectAll(); } });
  }
  function call(command,data,ip) {
    start();
    if (!ready) return Promise.reject({ status: 503, message: '电脑服务正在准备，请稍后重试' });
    if (pending.size >= 32) return Promise.reject({ status: 429, message: '电脑正在处理较多对局，请稍后重试' });
    return new Promise((resolve,reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject({ status: 503, message: '本次请求超时，请重试同一动作' }); },10000);
      pending.set(id,{ resolve, reject, timer }); worker.postMessage({ id,command,data,ip });
    });
  }
  function json(res,status,value) {
    if (res.destroyed) return;
    res.writeHead(status,{ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function body(req) {
    return new Promise((resolve,reject) => {
      let size = 0, text = '', failed = false;
      const timer = setTimeout(() => { failed = true; reject({ status: 408, message: '请求读取超时' }); },10000);
      req.on('data',chunk => {
        size += chunk.length;
        if (size > 32768 && !failed) { failed = true; clearTimeout(timer); reject({ status: 413, message: '请求过大' }); }
        if (!failed) text += chunk;
      });
      req.on('end',() => {
        clearTimeout(timer); if (failed) return;
        try { const value = JSON.parse(text); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); resolve(value); }
        catch (_) { reject({ status: 400, message: '请求格式无效' }); }
      });
      req.on('error',() => { clearTimeout(timer); reject({ status: 400, message: '请求中断' }); });
    });
  }
  const cleanup = setInterval(() => { const now = Date.now(); for (const [ip,b] of buckets) if (now-b.time > 60000) buckets.delete(ip); },60000);
  cleanup.unref(); start();
  return {
    handle(req,res) {
      const route = req.url.split('?')[0];
      if (!route.startsWith('/api/match-ai/')) return false;
      if (route === '/api/match-ai/health' && req.method === 'GET') { start(); json(res,ready ? 200 : 503,{ ready }); return true; }
      if (!originAllowed(req)) { json(res,403,{ error: '请求来源不匹配' }); return true; }
      const ip = clientIp(req), now = Date.now(), b = buckets.get(ip) || { tokens: 30, time: now };
      b.tokens = Math.min(30,b.tokens+(now-b.time)*.01); b.time = now; buckets.set(ip,b);
      if (b.tokens < 1) { json(res,429,{ error: '操作过快，请稍后重试' }); return true; } b.tokens--;
      const command = route === '/api/match-ai/session' ? (req.method === 'DELETE' ? 'delete' : 'create') :
        route === '/api/match-ai/step' ? 'step' : route === '/api/match-ai/rematch' ? 'rematch' : null;
      if (!command || (req.method !== 'POST' && !(command === 'delete' && req.method === 'DELETE'))) {
        json(res,404,{ error: '接口不存在' }); return true;
      }
      body(req).then(data => call(command,data,ip)).then(value => json(res,200,value),error => json(res,error.status || 503,{ error: error.message || '服务暂不可用' }));
      return true;
    },
    close() { stopped = true; clearInterval(cleanup); rejectAll(); if (worker) worker.terminate(); }
  };
}
module.exports = { createHandler };
