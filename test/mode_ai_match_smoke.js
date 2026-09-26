'use strict';
const assert = require('assert/strict');
const { webcrypto } = require('crypto');
const elements = new Map(), storage = new Map([['xnz_log_v1','quick-log-must-survive']]);
function element() { return { textContent:'', innerHTML:'', disabled:false, children:[],
  classList:{add(){},remove(){},toggle(){}}, appendChild(x){this.children.push(x);} }; }
global.window = { crypto: webcrypto };
global.document = { getElementById(id) { if (!elements.has(id)) elements.set(id,element()); return elements.get(id); },
  createElement:element, createTextNode:text => ({textContent:text}) };
global.localStorage = { getItem:k => storage.get(k)||null, setItem:(k,v) => storage.set(k,v) };
global.Game = require('../public/js/game');
let screen = '', result = null, calls = [], pending = [], timers = new Map(), serial = 0;
global.setTimeout = (fn,ms) => { const id=++serial; timers.set(id,{fn,ms}); return id; };
global.clearTimeout = id => timers.delete(id);
function reveal() { for (const [id,t] of [...timers]) if (t.ms === 850 || t.ms === 1500) { timers.delete(id); t.fn(); } }
global.fetch = (url,options) => { calls.push({url,data:JSON.parse(options.body),method:options.method}); return new Promise(resolve => pending.push(resolve)); };
global.App = { setActiveMode(){},showScreen(s){screen=s;},setText(id,text){document.getElementById(id).textContent=text;},
  show(){},hide(){},clearHistory(){},lockActionButtons(){},setActionButtons(){},updateBullets(){},toast(){},
  showBanner(){},showBadge(){},addHistoryChip(){},actionBadgeClass(){return '';},showResult(r){result=r;screen='result';} };
require('../public/js/stats'); global.Stats = window.Stats;
require('../public/js/mode-ai-match'); const Mode = window.ModeMatchAI;
const state = {phase:'pick',round:1,turn:1,mc:50,mh:50,pc:0,ph:0,bc:0,bh:0,previous:[-1,-1],last_result:0};
const base = { sessionId:'a'.repeat(48),policy:'full-temporal3-credit-v1',snapshot:{state,over:false,gameNumber:1,lastScore:null,credit:.0199},
  ready:{decisionId:'d1',phase:'pick',gameNumber:1},memory:{version:1,policy:'full-temporal3-v1',observations:0,events:[]} };
async function deliver(value,status=200) { const resolve = pending.shift(); assert.ok(resolve); resolve({ok:status===200,status,json:async()=>value}); await new Promise(resolve => setImmediate(resolve)); }
async function main() {
  Mode.enter(); Mode.enter(); assert.equal(calls.length,1,'double enter');
  await deliver(base); assert.equal(screen,'game');
  Mode.onAction(2); Mode.onAction(1); assert.equal(calls.length,2,'double submit');
  assert.deepEqual(calls[1].data,{sessionId:base.sessionId,decisionId:'d1',action:2});
  const next = {...base,snapshot:{...base.snapshot,state:{...state,phase:'play',pc:1,ph:2,bc:1,bh:2}},ready:{...base.ready,decisionId:'d2',phase:'play'},
    memory:{...base.memory,observations:1},result:{before:state,computer:1,human:2,state:{...state,bc:1,bh:2},score:null,settlement:{},
      decision:{diagnostics:{humanPrediction:[.2,.3,.5]}},predictionReview:{nll:Math.log(2)},risk:{before:.0199,after:.018}}};
  await deliver(next); assert.equal(JSON.parse(storage.get('xnz_match_memory_v1')).observations,1);
  Mode.onAction(0); assert.equal(calls.length,2,'cannot act during reveal'); reveal();
  Mode.onAction(0);
  const end = {...next,snapshot:{...next.snapshot,state:null,over:true,lastScore:0},ready:null,memory:{...next.memory,observations:2},
    result:{before:next.snapshot.state,computer:2,human:0,state:null,score:0,settlement:{round_end:true,winner:2,money:[0,100],final_bullets:[2,2]}}};
  await deliver(end); reveal(); assert.equal(result,'win','computer score must invert for human');
  assert.equal(JSON.parse(storage.get('xnz_match_history_v1')).wins,1);
  Stats.recordFullMatch(JSON.parse(storage.get('xnz_match_history_v1')).games[0]);
  assert.equal(JSON.parse(storage.get('xnz_match_history_v1')).wins,1,'duplicate log');
  const exported = JSON.parse(Stats.exportFullDiagnostics());
  assert.equal(exported.schema,'xnz-match-diagnostics-v1');
  assert(!Stats.exportFullDiagnostics().includes(base.sessionId),'diagnostic export removes session tokens');
  assert.deepEqual(exported.games[0].initialMemory,base.memory,'retain game-start public memory for replay');
  assert.deepEqual(exported.games[0].events[0].decision,next.result.decision,'save revealed forecast for analysis');
  assert.deepEqual(exported.games[0].events[0].predictionReview,next.result.predictionReview);
  assert.deepEqual(exported.games[0].events[0].risk,next.result.risk);
  Mode.startGame(); assert.equal(calls.at(-1).url,'/api/match-ai/rematch');
  await deliver({...base,snapshot:{...base.snapshot,gameNumber:2},memory:end.memory});
  assert.equal(screen,'game');
  Mode.toMenu(); await deliver({ok:true}); assert.equal(screen,'menu');
  Mode.enter(); assert.equal(calls.at(-1).data.memory.observations,2,'reenter restores full memory');
  Mode.toMenu(); await deliver({...base,sessionId:'b'.repeat(48)});
  assert.equal(screen,'menu','late create must not reopen');
  assert.equal(calls.at(-1).method,'DELETE','late session must be discarded'); await deliver({ok:true});
  Mode.enter(); await deliver(base); Mode.onAction(0); await deliver(next);
  Mode.toMenu(); await deliver({ok:true}); reveal(); assert.equal(screen,'menu','late animation must not reopen');
  assert.equal(storage.get('xnz_log_v1'),'quick-log-must-survive');
  Stats.refresh(); Stats.openHistory(); assert.match(document.getElementById('ai-memory-note').innerHTML,/完整模式：1 局/);
  console.log('Full-match browser controller passed: routing state, double clicks, reveal lock, outcomes, logs, rematch, memory, abort races, quick-log isolation.');
}
main().catch(e => { console.error(e); process.exitCode=1; });
