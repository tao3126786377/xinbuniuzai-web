'use strict';
const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
const { prepare } = require('../../tools/prepare_match_ai');
const { createEngine } = require('./index');
const sessions = new Map();
let engine;
function fail(status,message) { const e = new Error(message); e.status = status; throw e; }
function response(id,record,extra = {}) {
  const snapshot = record.session.getState();
  const ready = snapshot.over ? null : record.session.prepareDecision();
  return { sessionId: id, policy: engine.policy, snapshot, ready, memory: record.session.exportMemory(), ...extra };
}
function handle(command,data,ip) {
  const now = Date.now();
  for (const [id,r] of sessions) if (now-r.touched > 30*60*1000) sessions.delete(id);
  if (command === 'create') {
    if (typeof data.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.requestId)) fail(400,'请求编号无效');
    for (const [id,r] of sessions) if (r.ip === ip && r.requestId === data.requestId) {
      r.touched = now; return r.created;
    }
    if (sessions.size >= 128 || [...sessions.values()].filter(r => r.ip === ip).length >= 4) fail(429,'当前对局较多，请先结束已有对局再试');
    let session;
    try { session = engine.createSession({ memory: data.memory }); } catch (_) { fail(400,'完整模式记忆格式不兼容，请清除记忆后重试'); }
    const id = crypto.randomBytes(24).toString('hex'), record = { session, ip, touched: now, requestId: data.requestId };
    sessions.set(id,record); record.created = response(id,record); return record.created;
  }
  if (typeof data.sessionId !== 'string' || !/^[a-f0-9]{48}$/.test(data.sessionId)) fail(400,'对局编号无效');
  const record = sessions.get(data.sessionId);
  if (!record) fail(410,'对局已过期或服务器已重启，请返回菜单重新开始');
  record.touched = now;
  if (command === 'delete') { sessions.delete(data.sessionId); return { ok: true }; }
  if (command === 'step') {
    if (typeof data.decisionId !== 'string' || data.decisionId.length > 100 || ![0,1,2].includes(data.action)) fail(400,'出招格式无效');
    if (record.last && record.last.id === data.decisionId) {
      if (record.last.action !== data.action) fail(409,'本回合已提交其他动作');
      return record.last.response;
    }
    let result;
    try { result = record.session.reveal(data.decisionId,data.action); }
    catch (_) { fail(409,'本回合已结束或动作不可用，请重新进入对局'); }
    // Only a revealed decision is sent back. The NEXT committed action stays in this worker.
    const output = response(data.sessionId,record,{ result });
    record.last = { id: data.decisionId, action: data.action, response: output };
    record.rematch = null;
    return output;
  }
  if (command === 'rematch') {
    if (record.rematch && record.rematch.number === data.gameNumber) return record.rematch.response;
    const state = record.session.getState();
    if (!state.over || data.gameNumber !== state.gameNumber) fail(409,'当前对局尚未结束');
    record.session.startNextMatch(); record.last = null;
    const output = response(data.sessionId,record);
    record.rematch = { number: data.gameNumber, response: output }; return output;
  }
  fail(404,'接口不存在');
}
async function main() {
  const tablesPath = workerData.tablesPath || await prepare();
  engine = createEngine({ tablesPath, strategy: 'belief' });
  parentPort.on('message',job => {
    try { parentPort.postMessage({ id: job.id, ok: true, value: handle(job.command,job.data,job.ip) }); }
    catch (error) {
      if (!error.status) console.error('[完整人机]',error);
      parentPort.postMessage({ id: job.id, ok: false, status: error.status || 503,
        message: error.status ? error.message : '电脑暂时无法决策，请稍后重试' });
    }
  });
  parentPort.postMessage({ ready: true, policy: engine.policy });
}
main().catch(error => { console.error('[完整人机] 初始化失败',error); process.exitCode = 1; parentPort.close(); });
