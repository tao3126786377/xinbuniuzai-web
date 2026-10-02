'use strict';
const crypto = require('crypto');
const path = require('path');
const { performance } = require('perf_hooks');
const Rules = require('./rules');
const { Equilibrium } = require('./equilibrium');
const { BehaviorModel } = require('./model');
const { dot, minimum, safeChoice, DELTA, TOLERANCE } = require('./math');
const Credit = require('./credit');
const Beliefs = require('./belief');

class DeadlineReached extends Error {}
class InvalidPrediction extends Error {}
const copy = value => JSON.parse(JSON.stringify(value));
function randomSource(seed) {
  if (seed === undefined) return Math.random;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Seed must be a uint32');
  let state = seed;
  return () => {
    state = (state+0x6D2B79F5)|0; let t = Math.imul(state^(state>>>15),1|state);
    t ^= t+Math.imul(t^(t>>>7),61|t); return ((t^(t>>>14))>>>0)/4294967296;
  };
}
function sample(p, rng) {
  const value = rng(); let sum = 0;
  for (let i = 0; i < p.length; i++) { sum += p[i]; if (value < sum) return i; }
  return p.length-1;
}
function loadMemory(memory, version) {
  if (!memory) return { history: [], observations: 0 };
  if (memory.version !== 1 || memory.policy !== version || !Array.isArray(memory.events) || memory.events.length > 64 ||
      !Number.isSafeInteger(memory.observations) || memory.observations < memory.events.length) throw new Error('Invalid full-match memory');
  for (const e of memory.events) {
    if (!Array.isArray(e) || e.length !== 11 || e[0] !== 1 || e.slice(1,10).some(x => x !== 0 && x !== 1) ||
        e.slice(2,5).reduce((a,b) => a+b,0) !== 1 || e.slice(5,8).reduce((a,b) => a+b,0) !== 1 || ![-1,0,1].includes(e[10]))
      throw new Error('Invalid public observation');
  }
  return { history: copy(memory.events), observations: memory.observations };
}

function createEngine({ tablesPath = path.join(__dirname,'../../research/artifacts/full'), strategy = 'static' } = {}) {
  // Keep the original stateless engine available for historical study replay.
  // The web worker explicitly selects the released belief strategy.
  if (!['static','credit','belief'].includes(strategy)) throw new Error('Unknown match strategy');
  const model = new BehaviorModel(__dirname), memoryVersion = model.manifest.id;
  const adaptive = strategy === 'belief', usesCredit = strategy !== 'static';
  const version = adaptive ? 'full-temporal3-belief005-v1' : strategy === 'credit' ? 'full-temporal3-credit-v1' : memoryVersion;
  const equilibrium = new Equilibrium(tablesPath,model.manifest.equilibriumManifestSha256);
  if (505*(DELTA+TOLERANCE)+equilibrium.manifest.accumulated_error_bound > .02) {
    equilibrium.close(); throw new Error('Safety budget exceeded');
  }
  if (usesCredit) Credit.safetyBound(equilibrium);
  function decide(s, history = [], { budgetMs = 2500, credit = Credit.INITIAL_CREDIT, belief } = {}) {
    if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new Error('Invalid decision budget');
    if (usesCredit) {
      if (!Number.isFinite(credit) || credit < 0) throw new Error('Invalid decision budget');
      const predictor = adaptive ? belief || new Beliefs.Belief(model) : model;
      if (adaptive) predictor.prepare(s,history,equilibrium);
      const result = Credit.decide(s,history,equilibrium,predictor,credit,budgetMs), root = equilibrium.query(s);
      const equilibriumPrediction = [0,0,0];
      Rules.actions(s)[1].forEach((a,i) => equilibriumPrediction[a] = root.human[i]);
      const gap = Math.max(...result.scores)-result.value;
      const mode = !history.length ? 'equilibrium_no_history' : result.diagnostics.fallbackReason ? 'budget_or_prediction_fallback' : 'adaptive_safe';
      return { policy:version,actions:Rules.actions(s)[0],probabilities:result.probabilities,scores:result.scores,
        diagnostics:{...result.diagnostics,strategy,mode,observationWindow:Math.min(history.length,64),
          humanPrediction:history.length ? result.prediction : equilibriumPrediction,equilibriumPrediction,
          ...(adaptive ? {beliefGroups:predictor.groups(),forgettingRate:Beliefs.RATE} : {}),
          predictedValue:result.value,estimatedGainOverEquilibrium:result.value-dot(root.computer,result.scores),
          actionScoreRange:Math.max(...result.scores)-Math.min(...result.scores),unconstrainedScoreGap:gap,
          safetyLimited:mode === 'adaptive_safe' && gap > 1e-10,
          distanceFromEquilibrium:result.probabilities.reduce((sum,p,i) => sum+Math.abs(p-root.computer[i]),0)/2,
          equilibriumValue:root.value} };
    }
    const start = performance.now(), deadline = start+budgetMs, root = equilibrium.query(s);
    let nodes = 0, maxLocalLoss = 0, numericalFallbacks = 0, fallbackReason = null, probabilities, scores, rootPrediction = null;
    function prediction(state, h) {
      const p = model.predict(state,h,equilibrium);
      if (p.some(x => !Number.isFinite(x))) throw new InvalidPrediction();
      return p;
    }
    function visit(state, h, depth) {
      if (performance.now() >= deadline) throw new DeadlineReached();
      nodes++;
      const eq = equilibrium.query(state), [ac,ah] = Rules.actions(state), hp = prediction(state,h);
      if (depth === 3) rootPrediction = hp.slice();
      const q = ac.map(a => {
        let score = 0;
        for (const b of ah) {
          const result = Rules.transition(state,a,b);
          const value = !result.state ? result.score : depth === 1 ? equilibrium.value(result.state) :
            visit(result.state,Rules.remember(h,Rules.event(state,a,b,result)),depth-1).value;
          score += hp[b]*value;
        }
        return score;
      });
      const choice = safeChoice(q,eq); maxLocalLoss = Math.max(maxLocalLoss,choice.loss);
      numericalFallbacks += Number(choice.fallback);
      return { probabilities: choice.probabilities, scores: q, value: dot(choice.probabilities,q) };
    }
    try {
      if (!history.length) {
        probabilities = root.computer.slice(); const hp = prediction(s,history), ah = Rules.actions(s)[1];
        rootPrediction = hp.slice();
        scores = root.matrix.map(row => dot(row,ah.map(b => hp[b])));
      } else ({ probabilities, scores } = visit(s,history.slice(-64),3));
    } catch (error) {
      if (!(error instanceof DeadlineReached) && !(error instanceof InvalidPrediction)) throw error;
      fallbackReason = error instanceof DeadlineReached ? 'time_budget' : 'nonfinite_prediction';
      probabilities = root.computer.slice(); scores = root.matrix.map(row => dot(row,root.human));
    }
    maxLocalLoss = Math.max(maxLocalLoss,root.value-minimum(probabilities,root.matrix));
    const predictedValue = dot(probabilities,scores), unconstrainedScoreGap = Math.max(...scores)-predictedValue;
    const equilibriumPrediction = [0,0,0];
    Rules.actions(s)[1].forEach((a,i) => equilibriumPrediction[a] = root.human[i]);
    const mode = !history.length ? 'equilibrium_no_history' : fallbackReason ? 'equilibrium_fallback' : 'adaptive_safe';
    return { policy: version, actions: Rules.actions(s)[0], probabilities, scores,
      diagnostics: { nodes, maxLocalLoss, numericalFallbacks, fallbackReason,
        mode, observationWindow: Math.min(history.length,64), humanPrediction: rootPrediction, equilibriumPrediction,
        predictedValue, estimatedGainOverEquilibrium: predictedValue-dot(root.computer,scores),
        actionScoreRange: Math.max(...scores)-Math.min(...scores), unconstrainedScoreGap,
        safetyLimited: mode === 'adaptive_safe' && unconstrainedScoreGap > 1e-10,
        distanceFromEquilibrium: probabilities.reduce((sum,p,i) => sum+Math.abs(p-root.computer[i]),0)/2,
        equilibriumValue: root.value, seconds: (performance.now()-start)/1000 } };
  }
  function createSession({ seed, memory } = {}) {
    // Memory identifies the unchanged model/event format, not the planner.
    // Existing browser memory survives this upgrade and a release rollback.
    const restored = loadMemory(memory,memoryVersion), random = randomSource(seed), id = crypto.randomUUID();
    let history = restored.history, observations = restored.observations, state = Rules.initialState();
    // Old memory keeps its public history; the newly introduced posterior starts at the prior.
    const savedBelief = adaptive && memory && Object.prototype.hasOwnProperty.call(memory,'belief') ? Beliefs.validateMemory(memory.belief,observations) : null;
    const belief = adaptive ? new Beliefs.Belief(model,true,savedBelief || {weights:Beliefs.PRIOR,plays:0,observations}) : null;
    let pending = null, gameNumber = 1, lastScore = null;
    let credit = Credit.INITIAL_CREDIT;
    function getState() { return { state: copy(state), over: state === null, gameNumber, lastScore,
      ...(usesCredit ? {credit} : {}) }; }
    return {
      getState,
      prepareDecision(options) {
        if (!state) throw new Error('Match is over; start the next match');
        if (!pending) {
          const decision = decide(state,history,{...options,credit,belief});
          pending = { id: `${id}:${observations+1}`, decision,
            computer: decision.actions[sample(decision.probabilities,random)] };
        }
        // The current player choice cannot be supplied, and the committed computer action stays private.
        return { decisionId: pending.id, phase: state.phase, gameNumber };
      },
      reveal(decisionId, humanAction) {
        if (!pending || decisionId !== pending.id) throw new Error('Stale or duplicate decision');
        const result = Rules.transition(state,pending.computer,humanAction);
        const before = copy(state), computer = pending.computer, decision = pending.decision;
        const nextCredit = usesCredit ? Credit.advanceCredit(credit,state,equilibrium.query(state),decision,humanAction) : credit;
        const risk = usesCredit ? {before:credit,after:nextCredit} : null;
        const hp = decision.diagnostics.humanPrediction;
        // Score the frozen pre-reveal prediction, never a forecast rebuilt using this action.
        const predictionReview = hp ? {
          observedProbability: hp[humanAction], nll: -Math.log(Math.max(hp[humanAction],1e-12)),
          brier: hp.reduce((sum,p,a) => sum+(p-Number(a===humanAction))**2,0),
          uniformNll: Math.log(Rules.actions(state)[1].length)
        } : null;
        if (belief) belief.observe(computer,humanAction,result);
        history = Rules.remember(history,Rules.event(state,computer,humanAction,result)); observations++;
        state = result.state; lastScore = result.score; pending = null; credit = nextCredit;
        return { decisionId, eventId: observations, gameNumber, before, computer, human: humanAction,
          ...copy(result), decision: copy(decision), predictionReview, ...(risk ? {risk} : {}) };
      },
      startNextMatch() {
        if (state) throw new Error('Current match is not finished');
        state = Rules.initialState(); lastScore = null; gameNumber++; credit = Credit.INITIAL_CREDIT;
        return getState();
      },
      exportMemory() { return { version: 1, policy: memoryVersion, observations, events: copy(history),
        ...(belief ? {belief:{policy:Beliefs.MEMORY_POLICY,...belief.snapshot()}} : {}) }; }
    };
  }
  return { policy: version, decide, createSession, close: () => equilibrium.close() };
}
module.exports = { createEngine };
