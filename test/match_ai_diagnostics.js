'use strict';
const assert = require('assert/strict');
const {createEngine} = require('../lib/match-ai');
const {analyse} = require('../tools/analyze_match_ai');
const engine = createEngine();
try {
  const a = engine.createSession({seed:23}), b = engine.createSession({seed:23});
  const pa = a.prepareDecision(), pb = b.prepareDecision();
  assert.deepEqual(Object.keys(pa).sort(),['decisionId','gameNumber','phase']);
  const ra = a.reveal(pa.decisionId,0), rb = b.reveal(pb.decisionId,2);
  assert.equal(ra.computer,rb.computer,'current human choice cannot change committed computer action');
  assert.deepEqual(ra.decision.diagnostics.humanPrediction,rb.decision.diagnostics.humanPrediction,'forecast fixed before reveal');
  assert(Math.abs(ra.predictionReview.nll+Math.log(ra.decision.diagnostics.humanPrediction[0])) < 1e-12);
  assert.equal(ra.decision.diagnostics.mode,'equilibrium_no_history');
  const result = analyse({schema:'xnz-match-diagnostics-v1',games:[{id:'synthetic-check',source:'synthetic',policy:engine.policy,events:[ra,{before:ra.before,human:0}]}]});
  assert.equal(result.forecasts,1); assert.equal(result.totalEvents,2); assert.equal(result.sources.synthetic,1);
  assert.equal(result.meanNll,ra.predictionReview.nll);
  assert.throws(()=>analyse({games:[]}),/Expected/);
  const fallback = engine.decide(a.getState().state,a.exportMemory().events,{budgetMs:0});
  assert.equal(fallback.diagnostics.mode,'equilibrium_fallback'); assert.equal(fallback.diagnostics.humanPrediction,null);
  console.log('Full diagnostics passed: pre-reveal forecast privacy, immutable prediction, proper scoring, legacy-log exclusion, labelled synthetic input and budget fallback.');
} finally { engine.close(); }
