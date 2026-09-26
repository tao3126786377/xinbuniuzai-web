'use strict';
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const { createEngine } = require('../lib/match-ai');
const Credit = require('../lib/match-ai/credit'), Rules = require('../lib/match-ai/rules');
const { Equilibrium } = require('../lib/match-ai/equilibrium'), { BehaviorModel } = require('../lib/match-ai/model');
const { minimum } = require('../lib/match-ai/math');
const reference = require('../research/match_ai/phase6/planner');
const model = new BehaviorModel(path.join(__dirname,'../lib/match-ai'));
const eq = new Equilibrium(path.join(__dirname,'../research/artifacts/full'),model.manifest.equilibriumManifestSha256);
const engine = createEngine({ strategy:'credit' }), legacy = createEngine();
const near = (a,b) => assert(Math.abs(a-b)<1e-10,`${a} != ${b}`);
let compared = 0, decisions = 0, rounds = 0;
try {
  const states = JSON.parse(fs.readFileSync(path.join(__dirname,'../research/artifacts/runtime-reference.json'),'utf8')).states;
  for (const f of states) for (const credit of [0,.0199,.08]) {
    const expected = reference.decide(f.state,f.history,eq,model,credit,{mode:'credit'});
    const actual = engine.decide(f.state,f.history,{credit});
    actual.probabilities.forEach((p,i) => near(p,expected.probabilities[i]));
    actual.scores.forEach((q,i) => near(q,expected.scores[i]));
    assert(actual.diagnostics.maxLocalLoss <= credit+1e-10); compared++;
  }
  const session = engine.createSession({seed:81,memory:legacy.createSession().exportMemory()});
  for (let game = 0; game < 3; game++) {
    while (!session.getState().over) {
      const before = session.getState(), saved = session.exportMemory(), ready = session.prepareDecision({credit:999});
      assert.deepEqual(Object.keys(ready).sort(),['decisionId','gameNumber','phase']);
      assert.deepEqual(session.prepareDecision(),ready); assert.deepEqual(session.getState(),before);
      assert.throws(() => session.reveal(ready.decisionId,99),/Illegal/); assert.deepEqual(session.getState(),before);
      const legal = Rules.actions(before.state)[1], human = legal[decisions%legal.length];
      const result = session.reveal(ready.decisionId,human), e = eq.query(before.state);
      assert.equal(result.decision.policy,'full-temporal3-credit-v1');
      near(result.decision.diagnostics.creditBefore,before.credit);
      near(result.risk.after,reference.advanceCredit(before.credit,before.state,e,result.decision,human));
      assert(e.value-minimum(result.decision.probabilities,e.matrix) <= before.credit+1e-10);
      assert.equal(session.getState().credit,result.risk.after);
      assert.equal(session.exportMemory().observations,saved.observations+1);
      const after = session.getState(); assert.throws(() => session.reveal(ready.decisionId,human),/Stale/); assert.deepEqual(session.getState(),after);
      if(result.settlement.round_end){rounds++;assert.equal(after.credit,result.risk.after,'no reset at round boundary');}
      decisions++;assert(decisions <= 3*505);
    }
    const saved = session.exportMemory(), restarted = engine.createSession({memory:{...saved,credit:999},seed:0});
    assert.deepEqual(restarted.exportMemory(),saved);assert.equal(restarted.getState().credit,.0199);
    assert.deepEqual(restarted.getState().state,Rules.initialState());
    assert.deepEqual(legacy.createSession({memory:saved}).exportMemory(),saved,'memory stays compatible with rollback');
    if(game<2){session.startNextMatch();assert.equal(session.getState().credit,.0199);assert.deepEqual(session.exportMemory(),saved);}
  }
  const f = states.find(x => x.history.length);
  const fallback = engine.decide(f.state,f.history,{budgetMs:0,credit:0});
  assert.equal(fallback.diagnostics.fallbackReason,'time_budget');assert.deepEqual(fallback.probabilities,eq.query(f.state).computer);
  const invalid = Credit.decide(f.state,f.history,eq,{predict:()=>[NaN,0,1]},.0199,2500);
  assert.equal(invalid.diagnostics.fallbackReason,'invalid_prediction');assert.deepEqual(invalid.probabilities,eq.query(f.state).computer);
  assert.throws(() => engine.decide(f.state,f.history,{credit:-1}),/budget/);
  assert.throws(() => createEngine({strategy:'unknown'}),/strategy/);
  console.log('Credit web runtime passed:',{compared,decisions,rounds,matches:3,safetyBound:Credit.safetyBound(eq)});
} finally {engine.close();legacy.close();eq.close();}
