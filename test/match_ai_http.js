'use strict';
const assert = require('assert/strict');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const net = require('net');
const path = require('path');
const Rules = require('../lib/match-ai/rules');
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function main() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0,'127.0.0.1',resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = 'http://127.0.0.1:'+port;
  const server = spawn(process.execPath,['server.js'],{ cwd: path.join(__dirname,'..'),
    env: { ...process.env, PORT: String(port), ALLOW_NO_ORIGIN: 'false' }, stdio: ['ignore','pipe','pipe'] });
  let logs = ''; server.stdout.on('data',b => logs += b); server.stderr.on('data',b => logs += b);
  async function api(route,data,method = 'POST',origin = base) {
    const res = await fetch(base+'/api/match-ai/'+route,{ method,
      headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: res.status, body: await res.json() };
  }
  async function ok(route,data,method) {
    // Observe the production per-IP rate limit during automated play.
    await sleep(110);
    const r = await api(route,data,method); assert.equal(r.status,200,JSON.stringify(r)); return r.body;
  }
  function privateReady(value) {
    assert.deepEqual(Object.keys(value.ready).sort(),['decisionId','gameNumber','phase']);
    assert.equal(value.snapshot.state.previous.length,2);
  }
  try {
    let healthy = false;
    for (let n = 0; n < 150; n++) {
      try { if ((await fetch(base+'/api/match-ai/health')).ok) { healthy = true; break; } } catch (_) {}
      await sleep(100);
    }
    assert.ok(healthy,logs);
    assert.match(await (await fetch(base)).text(),/mode-ai-match\.js/);
    assert.equal((await api('session',{requestId:randomUUID()},'POST','https://evil.example')).status,403);
    assert.equal((await api('session',{garbage:'x'.repeat(17000)})).status,413);
    assert.equal((await api('session',{requestId:randomUUID(),memory:{bad:true}})).status,400);
    const create = { requestId: randomUUID() };
    let game = await ok('session',create);
    assert.equal(game.policy,'full-temporal3-credit-v1');
    assert.equal(game.snapshot.credit,.0199);
    assert.deepEqual(await ok('session',create),game,'create retry must not allocate another session');
    privateReady(game);
    assert.equal(game.memory.observations,0);
    const pick = { sessionId:game.sessionId, decisionId:game.ready.decisionId, action:0 };
    game = await ok('step',pick);
    assert.deepEqual(await ok('step',pick),game,'lost-response retry must be identical');
    assert.equal((await api('step',{...pick,action:1})).status,409);
    assert.equal(game.memory.observations,1);
    privateReady(game);
    assert.equal((await api('step',{sessionId:game.sessionId,decisionId:game.ready.decisionId,action:0})).status,409,'zero bullets cannot shoot');
    let decisions = 1, maxMs = 0;
    while (!game.snapshot.over) {
      assert.ok(decisions < 505);
      const before = game.snapshot.state;
      const action = before.phase === 'pick' ? 2 : before.bh < 10 ? 2 : 1;
      const now = performance.now();
      const next = await ok('step',{sessionId:game.sessionId,decisionId:game.ready.decisionId,action});
      maxMs = Math.max(maxMs,performance.now()-now-110);
      const expected = Rules.transition(before,next.result.computer,action);
      assert.deepEqual(next.result.state,expected.state);
      assert.deepEqual(next.result.settlement,expected.settlement);
      assert.equal(next.result.score,expected.score);
      assert.equal(next.memory.observations,++decisions);
      assert.equal(next.result.risk.before,game.snapshot.credit);
      assert.equal(next.result.risk.after,next.snapshot.credit);
      assert.ok(next.result.decision.diagnostics.maxLocalLoss <= next.result.risk.before+1e-10);
      if (!next.snapshot.over) privateReady(next);
      game = next;
    }
    assert.equal(game.ready,null);
    const rematch = {sessionId:game.sessionId,gameNumber:game.snapshot.gameNumber};
    const again = await ok('rematch',rematch);
    assert.deepEqual(await ok('rematch',rematch),again);
    assert.equal(again.snapshot.gameNumber,2);
    assert.equal(again.snapshot.credit,.0199);
    assert.deepEqual(again.memory,game.memory);
    await ok('session',{sessionId:game.sessionId},'DELETE');
    assert.equal((await api('step',pick)).status,410);
    const restored = await ok('session',{requestId:randomUUID(),memory:game.memory});
    assert.deepEqual(restored.memory,game.memory);
    assert.equal(restored.snapshot.credit,.0199);
    assert.equal(restored.snapshot.state.mc,50,'refresh restores memory into a new match, not a fresh budget in the old match');
    await ok('session',{sessionId:restored.sessionId},'DELETE');
    console.log('Full-match HTTP passed: complete game, '+decisions+' decisions, hidden commitment, retries, legality, memory, origin, body limit; max request '+maxMs.toFixed(1)+' ms (local).');
  } finally { server.kill(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
