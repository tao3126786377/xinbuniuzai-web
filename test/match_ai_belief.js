'use strict';
const assert = require('assert/strict');
const { createEngine } = require('../lib/match-ai');
const { prepare } = require('../tools/prepare_match_ai');
const Rules = require('../lib/match-ai/rules');
const Beliefs = require('../lib/match-ai/belief');
async function main() {
  const tablesPath = await prepare(), engine = createEngine({tablesPath,strategy:'belief'}), old = createEngine({tablesPath,strategy:'credit'});
  let decisions = 0, rounds = 0;
  try {
    const session = engine.createSession({seed:41}), other = engine.createSession({seed:42}), isolated = other.exportMemory();
    assert.equal(engine.policy,'full-temporal3-belief005-v1');
    for(let game=0;game<3;game++) {
      while(!session.getState().over) {
        const before = session.getState(), saved = session.exportMemory();
        const ready = session.prepareDecision({budgetMs:1e9,credit:999,belief:null});
        assert.deepEqual(Object.keys(ready).sort(),['decisionId','gameNumber','phase']);
        assert.deepEqual(session.prepareDecision(),ready);assert.deepEqual(session.exportMemory(),saved,'search cannot update persistent beliefs');
        assert.throws(()=>session.reveal(ready.decisionId,99));assert.deepEqual(session.exportMemory(),saved);
        const legal=Rules.actions(before.state)[1],human=legal[decisions%legal.length],r=session.reveal(ready.decisionId,human);
        assert.equal(r.decision.policy,engine.policy);assert.equal(r.decision.diagnostics.creditBefore,before.credit);
        assert(r.decision.diagnostics.maxLocalLoss<=before.credit+1e-10);assert.equal(r.risk.after,session.getState().credit);
        const memory=session.exportMemory();assert.equal(memory.belief.observations,++decisions);assert.equal(memory.observations,decisions);
        assert.equal(memory.belief.plays,saved.belief.plays+Number(before.state.phase==='play'));
        memory.belief.weights.forEach((w,i)=>assert(w>=.005*Beliefs.PRIOR[i]-1e-15));
        assert(Buffer.byteLength(JSON.stringify({requestId:'0'.repeat(36),memory}))<32768);
        assert.throws(()=>session.reveal(ready.decisionId,human));assert.deepEqual(session.exportMemory(),memory);
        if(r.settlement.round_end)rounds++;
        assert(decisions<=1515);
      }
      const saved=session.exportMemory(),restored=engine.createSession({seed:99,memory:saved});
      assert.deepEqual(restored.exportMemory(),saved);assert.equal(restored.getState().credit,.0199);
      assert.deepEqual(restored.getState().state,Rules.initialState());
      const expected=old.createSession({memory:saved}).exportMemory();assert.equal(expected.belief,undefined);
      assert.deepEqual(expected.events,saved.events);
      const migrated=engine.createSession({memory:expected}).exportMemory();
      assert.deepEqual(migrated.events,expected.events);assert.equal(migrated.observations,expected.observations);
      assert.deepEqual(migrated.belief.weights,Array.from(Beliefs.PRIOR));
      const p=restored.prepareDecision();restored.reveal(p.decisionId,1);assert.deepEqual(session.exportMemory(),saved,'restored session must not alias original');
      for(const mutation of [b=>b.weights.pop(),b=>b.weights.fill(0),b=>b.weights[0]=NaN,b=>b.weights[0]=-1,b=>b.plays=-1,b=>b.observations++,b=>b.policy='unknown']) {
        const bad=JSON.parse(JSON.stringify(saved));mutation(bad.belief);assert.throws(()=>engine.createSession({memory:bad}),/belief memory/);
      }
      assert.throws(()=>engine.createSession({memory:{...saved,belief:null}}),/belief memory/);
      if(game<2){session.startNextMatch();assert.deepEqual(session.exportMemory(),saved);assert.equal(session.getState().credit,.0199);}
    }
    assert.deepEqual(other.exportMemory(),isolated,'players must not share posterior state');
    const zero=engine.createSession({memory:session.exportMemory(),seed:1}),first=zero.prepareDecision({budgetMs:0}),result=zero.reveal(first.decisionId,0);
    assert.equal(result.decision.diagnostics.fallbackReason,'time_budget');assert(result.decision.diagnostics.maxLocalLoss<1e-9);
    assert.equal(zero.exportMemory().observations,decisions+1,'fallback still learns exactly one reveal');
    console.log('Belief web runtime passed:',{decisions,rounds,matches:3,models:Beliefs.BANK.length,legacyMemory:true,posteriorRestore:true,sessionIsolation:true,timeout:true});
  } finally {engine.close();old.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
