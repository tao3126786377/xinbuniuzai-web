'use strict';
// Released phase6 credit planner: three-step search, zero additional risk in
// simulated descendants. No research files or online model calibration needed.
const { performance } = require('perf_hooks');
const Rules = require('./rules');
const { dot, minimum, safeChoice } = require('./math');
const INITIAL_CREDIT = .0199, NUMERICAL_ALLOWANCE = 1e-10;
function safetyBound(eq) {
  const bound = INITIAL_CREDIT+505*NUMERICAL_ALLOWANCE+eq.manifest.accumulated_error_bound;
  if (!Number.isFinite(bound) || bound > .02) throw new Error('Safety budget exceeded');
  return bound;
}
function advanceCredit(credit, state, eq, decision, human) {
  const j = Rules.actions(state)[1].indexOf(human);
  if (j < 0) throw new Error('Illegal revealed action');
  // Use the entire committed distribution, never the lucky sampled action.
  const next = credit+eq.matrix.reduce((sum,row,i) => sum+decision.probabilities[i]*row[j],0)-eq.value;
  if (!Number.isFinite(next) || next < -NUMERICAL_ALLOWANCE) throw new Error('Spent unavailable match credit');
  return Math.max(0,next);
}
function decide(state, history, equilibrium, model, credit, budgetMs) {
  if (!Number.isFinite(credit) || credit < 0 || !Number.isFinite(budgetMs) || budgetMs < 0) throw new Error('Invalid decision budget');
  const started = performance.now(), stop = {}, invalid = {};
  let nodes = 0, maxOverspend = 0, numericalFallbacks = 0, fallbackReason = null;
  function check() {
    if (nodes >= 20000 || performance.now()-started >= budgetMs) throw stop;
    nodes++;
  }
  function node(s,h,left,path=[]) {
    const [ac,ah] = Rules.actions(s);
    return { s,h,left,path,ac,ah,eq:equilibrium.query(s),hp:null,children:new Map(),zero:null };
  }
  function forecast(n) {
    if (!n.hp) {
      check(); const p = model.predictAt ? model.predictAt(n.s,n.h,equilibrium,n.path) : model.predict(n.s,n.h,equilibrium);
      if (p.some(x => !Number.isFinite(x) || x < 0) || Math.abs(n.ah.reduce((sum,b) => sum+p[b],0)-1) > 1e-9) throw invalid;
      n.hp = p;
    }
    return n.hp;
  }
  function choose(scores,n,risk) {
    const d = safeChoice(scores,n.eq,risk);
    const overspend = n.eq.value-minimum(d.probabilities,n.eq.matrix)-risk;
    maxOverspend = Math.max(maxOverspend,overspend); numericalFallbacks += Number(d.fallback);
    if (!Number.isFinite(overspend) || overspend > NUMERICAL_ALLOWANCE) throw invalid;
    return { probabilities:d.probabilities, scores, value:dot(d.probabilities,scores) };
  }
  function immediate(n,risk) {
    const hp = forecast(n);
    return choose(n.eq.matrix.map(row => dot(row,n.ah.map(b => hp[b]))),n,risk);
  }
  function child(n,i,j) {
    const key = i*3+j;
    if (!n.children.has(key)) {
      check(); const a = n.ac[i], b = n.ah[j], r = Rules.transition(n.s,a,b);
      n.children.set(key,r.state ? node(r.state,Rules.remember(n.h,Rules.event(n.s,a,b,r)),n.left-1,n.path.concat([[a,b]])) : { terminal:r.score });
    }
    return n.children.get(key);
  }
  function visit(n,risk) {
    if (risk === 0 && n.zero) return n.zero;
    check(); if (n.left === 1) return immediate(n,risk);
    const hp = forecast(n), scores = n.ac.map((_,i) => n.ah.reduce((sum,b,j) => {
      const next = child(n,i,j);
      return sum+hp[b]*(next.terminal === undefined ? visit(next,0).value : next.terminal);
    },0));
    const d = choose(scores,n,risk); if (risk === 0) n.zero = d;
    return d;
  }
  const root = node(state,history.slice(-64),3);
  const eqScores = root.eq.matrix.map(row => dot(row,root.eq.human));
  const fallback = { probabilities:root.eq.computer.slice(),scores:eqScores,value:dot(root.eq.computer,eqScores) };
  let result = fallback;
  if (history.length) {
    try { result = immediate(root,credit); result = visit(root,credit); }
    catch (error) {
      if (error !== stop && error !== invalid) throw error;
      fallbackReason = error === stop ? 'time_budget' : 'invalid_prediction';
      if (error === invalid) { result = fallback; root.hp = null; }
    }
  }
  const localLoss = root.eq.value-minimum(result.probabilities,root.eq.matrix);
  if (!Number.isFinite(localLoss) || localLoss > credit+NUMERICAL_ALLOWANCE) throw new Error('Unsafe decision');
  return { ...result, prediction:root.hp, diagnostics:{nodes,maxOverspend,numericalFallbacks,fallbackReason,
    maxLocalLoss:localLoss,creditBefore:credit,seconds:(performance.now()-started)/1000} };
}
module.exports = { INITIAL_CREDIT,NUMERICAL_ALLOWANCE,safetyBound,advanceCredit,decide };
