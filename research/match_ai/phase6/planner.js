'use strict';
// Offline full-match experiment. Uses only full-match rules, tables and model.
const Rules = require('../../../lib/match-ai/rules');
const {dot,minimum,safeChoice,safeVertices} = require('../../../lib/match-ai/math');
const INITIAL_CREDIT = .0199;
const NUMERICAL_ALLOWANCE = 1e-10;

function nextCredits(eq,p,credit) {
  return eq.human.map((_,j)=>{
    const next=credit+eq.matrix.reduce((sum,row,i)=>sum+p[i]*row[j],0)-eq.value;
    if (next < -NUMERICAL_ALLOWANCE) throw Error('Spent unavailable match credit');
    return Math.max(0,next);
  });
}
function advanceCredit(credit,state,eq,decision,human) {
  const j=Rules.actions(state)[1].indexOf(human);
  if (j<0) throw Error('Illegal revealed action');
  // Average over the committed distribution: lucky sampled actions earn nothing.
  return nextCredits(eq,decision.probabilities,credit)[j];
}
function distributions(eq,credit,preferred) {
  const vertices=safeVertices(eq.matrix,eq.value,credit);
  const candidates=[preferred,eq.computer,...vertices,
    ...vertices.map(p=>p.map((x,i)=>(x+eq.computer[i])*.5))];
  return candidates.filter((p,i)=>p.every(v=>Number.isFinite(v)&&v>=0) &&
    Math.abs(p.reduce((a,b)=>a+b,0)-1)<NUMERICAL_ALLOWANCE &&
    eq.value-minimum(p,eq.matrix)<=credit+1e-11 &&
    !candidates.slice(0,i).some(old=>p.every((v,j)=>Math.abs(v-old[j])<1e-12)));
}
function safetyBound(baseline) {
  const bound=INITIAL_CREDIT+505*NUMERICAL_ALLOWANCE+baseline.manifest.accumulated_error_bound;
  if (bound>.02) throw Error('Full-match safety budget exceeded');
  return bound;
}
function decide(state,history,baseline,model,credit,{mode='forward',depth=3,budgetMs=2500,maxNodes=20000}={}) {
  if (!['credit','forward'].includes(mode) || ![1,2,3].includes(depth) ||
      !Number.isFinite(credit) || credit<0 || !Number.isFinite(budgetMs) || budgetMs<0 ||
      !Number.isInteger(maxNodes) || maxNodes<0) throw Error('Invalid planner budget');
  const started=performance.now(), stop={};
  let nodes=0,predictions=0,cacheHits=0,maxOverspend=0,interrupted=false,completed=0;
  function check() {
    if (nodes>=maxNodes || performance.now()-started>=budgetMs) throw stop;
    nodes++;
  }
  function makeNode(s,h,left) {
    const eq=baseline.query(s), [ac,ah]=Rules.actions(s);
    // Node identity follows the action path, never turn number (which resets).
    return {s,h,left,eq,ac,ah,hp:null,children:new Map(),values:new Map(),zero:null};
  }
  function forecast(node) {
    if (!node.hp) {
      check(); node.hp=model.predict(node.s,node.h,baseline); predictions++;
      if (node.hp.some(x=>!Number.isFinite(x)||x<0) ||
          Math.abs(node.ah.reduce((sum,b)=>sum+node.hp[b],0)-1)>1e-9) throw Error('Invalid prediction');
    }
    return node.hp;
  }
  function child(node,i,j) {
    const key=i*3+j;
    if (!node.children.has(key)) {
      check(); const a=node.ac[i], b=node.ah[j], r=Rules.transition(node.s,a,b);
      node.children.set(key,r.state ? makeNode(r.state,Rules.remember(node.h,Rules.event(node.s,a,b,r)),node.left-1) : {terminal:r.score});
    }
    return node.children.get(key);
  }
  function inspect(eq,p,risk) {
    const overspend=eq.value-minimum(p,eq.matrix)-risk;
    maxOverspend=Math.max(maxOverspend,overspend);
    if (overspend>NUMERICAL_ALLOWANCE) throw Error('Unsafe simulated choice');
  }
  function immediate(node,risk) {
    const hp=forecast(node), scores=node.eq.matrix.map(row=>dot(row,node.ah.map(b=>hp[b])));
    const choice=safeChoice(scores,node.eq,risk);
    inspect(node.eq,choice.probabilities,risk);
    return {probabilities:choice.probabilities,scores,value:dot(choice.probabilities,scores)};
  }
  // Dynamic root budget, conservative future policy spends zero additional risk.
  function conservative(node,risk) {
    if (risk===0 && node.zero) return node.zero;
    check();
    if (node.left===1) return immediate(node,risk);
    const hp=forecast(node), scores=node.ac.map((_,i)=>node.ah.reduce((sum,b,j)=>{
      const next=child(node,i,j);
      return sum+hp[b]*(next.terminal===undefined ? conservative(next,0).value : next.terminal);
    },0));
    const choice=safeChoice(scores,node.eq,risk);
    inspect(node.eq,choice.probabilities,risk);
    const d={probabilities:choice.probabilities,scores,value:dot(choice.probabilities,scores)};
    if (risk===0) node.zero=d;
    return d;
  }
  function evaluate(node,p,risk,includeZero=false) {
    const credits=nextCredits(node.eq,p,risk), hp=forecast(node);
    const scores=p.map(x=>x>0||includeZero?0:null);
    inspect(node.eq,p,risk);
    for (let i=0;i<node.ac.length;i++) for (let j=0;j<node.ah.length;j++) {
      if (scores[i]===null) continue;
      const next=child(node,i,j);
      scores[i]+=hp[node.ah[j]]*(next.terminal===undefined ? visit(next,credits[j]).value : next.terminal);
    }
    return {probabilities:p,scores,value:dot(p,scores)};
  }
  function visit(node,risk) {
    if (node.values.has(risk)) { cacheHits++; return node.values.get(risk); }
    check(); const one=immediate(node,risk); let best=one;
    if (node.left>1) {
      best=null;
      for (const p of distributions(node.eq,risk,one.probabilities)) {
        const d=evaluate(node,p,risk);
        if (!best || d.value>best.value+1e-12) best=d;
      }
    }
    node.values.set(risk,best); return best;
  }
  const root=makeNode(state,history.slice(-64),depth), candidates=[];
  const eqScores=root.eq.matrix.map(row=>dot(row,root.eq.human));
  let fallback={probabilities:root.eq.computer.slice(),scores:eqScores,value:dot(root.eq.computer,eqScores)}, best=null;
  if (history.length) {
    try {
      fallback=immediate(root,credit);
      const preferred=conservative(root,credit);
      fallback=preferred;
      if (mode==='credit' || depth===1) { best=preferred; completed=1; }
      else for (const p of distributions(root.eq,credit,preferred.probabilities)) {
        check(); const d=evaluate(root,p,credit); completed++;
        candidates.push({probabilities:p,value:d.value});
        if (!best || d.value>best.value+1e-12) best=d;
      }
    } catch(error) { if (error!==stop) throw error; interrupted=true; }
  }
  let scoreCompletionInterrupted=false;
  if (best && best.scores.some(x=>x===null)) {
    try { best=evaluate(root,best.probabilities,credit,true); }
    catch(error) { if(error!==stop)throw error; scoreCompletionInterrupted=true; }
  }
  const result=best || fallback;
  inspect(root.eq,result.probabilities,credit);
  return {...result,actions:root.ac,prediction:root.hp,candidates,
    diagnostics:{mode,depth,nodes,predictions,cacheHits,completed,interrupted,maxOverspend,
      fallback:best===null,scoreCompletionInterrupted,scoresConditionalOnDistribution:mode==='forward',
      seconds:(performance.now()-started)/1000,credit,
      localLoss:root.eq.value-minimum(result.probabilities,root.eq.matrix)}};
}
module.exports={INITIAL_CREDIT,NUMERICAL_ALLOWANCE,safetyBound,nextCredits,advanceCredit,distributions,decide};
