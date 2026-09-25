'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createEngine } = require('../lib/match-ai');
const Rules = require('../lib/match-ai/rules');
const MathAI = require('../lib/match-ai/math');
const { Equilibrium } = require('../lib/match-ai/equilibrium');
const { BehaviorModel, features } = require('../lib/match-ai/model');
const root = path.join(__dirname,'..');
const fixtureFile = path.join(root,'research/artifacts/runtime-reference.json');
if (!fs.existsSync(fixtureFile)) throw new Error('Run python tools/gen_match_ai_reference.py first');
const reference = JSON.parse(fs.readFileSync(fixtureFile,'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(root,'lib/match-ai/policy.json'),'utf8'));
const tables = path.join(root,'research/artifacts/full');
const eq = new Equilibrium(tables,policy.equilibriumManifestSha256);
const model = new BehaviorModel(path.join(root,'lib/match-ai'));
const engine = createEngine({ tablesPath: tables });
const difference = (a,b) => Math.max(...a.map((x,i) => Math.abs(x-b[i])));
let maxFeature = 0, maxPrediction = 0, maxScore = 0, maxValue = 0, maxLoss = 0, alternateTies = 0;
const times = [];
try {
  for (const f of reference.transitions) assert.deepStrictEqual(Rules.transition(f.state,f.computer,f.human),f.expected);
  for (const f of reference.matrices) {
    const result = MathAI.solveGame(f.matrix), choice = MathAI.safeChoice(f.scores,result);
    assert(Math.abs(result.value-f.value) < 1e-10);
    assert(Math.abs(MathAI.dot(choice.probabilities,f.scores)-f.optimum) < 1e-9);
    assert(choice.loss <= MathAI.DELTA+MathAI.TOLERANCE);
  }
  for (const f of reference.states) {
    const exact = eq.query(f.state), hp = model.predict(f.state,f.history,eq), ah = Rules.actions(f.state)[1];
    maxFeature = Math.max(maxFeature,difference([...features(f.state,f.history,eq)],f.features));
    maxPrediction = Math.max(maxPrediction,difference(ah.map(a => hp[a]),f.prediction));
    maxValue = Math.max(maxValue,Math.abs(exact.value-f.value));
    const decision = engine.decide(f.state,f.history);
    times.push(decision.diagnostics.seconds*1000);
    maxScore = Math.max(maxScore,difference(decision.scores,f.scores));
    const loss = exact.value-MathAI.minimum(decision.probabilities,exact.matrix);
    maxLoss = Math.max(maxLoss,loss,decision.diagnostics.maxLocalLoss);
    assert(loss <= MathAI.DELTA+MathAI.TOLERANCE);
    // Floating-point ties may use different safe mixtures with the same action value.
    assert(Math.abs(MathAI.dot(decision.probabilities,f.scores)-MathAI.dot(f.probabilities,f.scores)) < 1e-9);
    if (difference(decision.probabilities,f.probabilities) > 1e-7) alternateTies++;
    assert.strictEqual(decision.diagnostics.fallbackReason,null);
  }
  assert(maxFeature < 1e-10 && maxPrediction < 1e-10 && maxValue < 1e-10 && maxScore < 1e-9);
  const first = reference.states.find(f => f.history.length > 0);
  const fallback = engine.decide(first.state,first.history,{ budgetMs: 0 });
  assert.strictEqual(fallback.diagnostics.fallbackReason,'time_budget');
  assert.deepStrictEqual(fallback.probabilities,eq.query(first.state).computer);

  const a = engine.createSession({ seed: 81 }), b = engine.createSession({ seed: 81 });
  let matches = 0, decisions = 0;
  while (matches < 3) {
    while (!a.getState().over) {
      const before = a.getState(), memory = a.exportMemory(), pa = a.prepareDecision(), pb = b.prepareDecision();
      assert.deepStrictEqual(a.prepareDecision(),pa);
      assert(!('computer' in pa) && !('probabilities' in pa));
      assert.deepStrictEqual(a.exportMemory(),memory);
      assert.throws(() => a.reveal(pa.decisionId,99),/Illegal/);
      assert.deepStrictEqual(a.getState(),before);
      const legal = Rules.actions(before.state)[1], human = legal[decisions%legal.length];
      const ra = a.reveal(pa.decisionId,human), rb = b.reveal(pb.decisionId,human);
      assert.strictEqual(ra.computer,rb.computer); assert.deepStrictEqual(ra.state,rb.state);
      assert.throws(() => a.reveal(pa.decisionId,human),/Stale/);
      assert.strictEqual(a.exportMemory().observations,memory.observations+1);
      decisions++;
      assert(decisions <= 3*505);
    }
    matches++;
    assert.throws(() => a.prepareDecision(),/over/);
    const saved = a.exportMemory(), restored = engine.createSession({ memory: saved, seed: 1 });
    assert.deepStrictEqual(restored.exportMemory(),saved);
    saved.events[0][0] = 99; assert.notStrictEqual(restored.exportMemory().events[0][0],99);
    if (matches < 3) { a.startNextMatch(); b.startNextMatch(); assert(a.exportMemory().events.length > 0); }
  }
  assert.throws(() => engine.createSession({ memory: { version: 0 } }),/Invalid/);
  assert.throws(() => engine.decide(first.state,first.history,{ budgetMs: -1 }),/budget/);
  assert.throws(() => new Equilibrium(tables,'wrong'),/release/);
  assert(eq.blocks.size <= 32);
  times.sort((a,b) => a-b);
  const result = { policy: policy.id, transitions: reference.transitions.length, matrices: reference.matrices.length,
    policyStates: reference.states.length, maxFeature, maxPrediction, maxScore, maxValue, maxLoss,
    alternateTies, completeSessionMatches: matches, sessionDecisions: decisions,
    meanDecisionMs: times.reduce((a,b) => a+b,0)/times.length, p95DecisionMs: times[Math.floor(times.length*.95)],
    maxDecisionMs: times[times.length-1], nodeVersion: process.version, platform: process.platform,
    tableBlockCacheCapacityBytes: 32*9*100*30*8 };
  fs.writeFileSync(path.join(root,'research/artifacts/runtime-validation.json'),JSON.stringify(result,null,2)+'\n');
  console.log('Full-match runtime checks passed:',result);
} finally { engine.close(); eq.close(); }
assert.throws(() => engine.decide(Rules.initialState()),/closed/);
