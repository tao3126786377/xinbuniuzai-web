'use strict';
// All persistent state is derived from public reveals. No opponent instance,
// generator parameter, family label or hidden snapshot is accepted here.
const Rules=require('./rules');
const RATE=.005, MEMORY_POLICY='fixed-share-005-v1';
function priorActions(s,h){const out=[];for(let i=h.length-1;i>=0;i--){const e=h[i];if(e[1]||e[8])break;out.push(e.slice(2,5).indexOf(1));}return out;}
const STRENGTHS=[.2,.35,.5],GROUPS=['network','cautious_habit','long_memory','public_counter','hidden_switch'];
const BANK=[{group:'network'}];
for(const group of GROUPS.slice(1))for(let strength=0;strength<3;strength++){
  if(group==='public_counter'){BANK.push({group,strength});continue;}
  for(let pick=0;pick<3;pick++)for(let offset=0;offset<3;offset++){
    if(group==='cautious_habit')BANK.push({group,strength,pick,offset});
    if(group==='long_memory')for(let lag=9;lag<=12;lag++)BANK.push({group,strength,pick,offset,lag});
    if(group==='hidden_switch')for(let change=6;change<=10;change++)for(let period=8;period<=12;period++)BANK.push({group,strength,pick,offset,change,period});
  }
}
const PRIOR=Float64Array.from(BANK,x=>1/GROUPS.length/BANK.filter(y=>y.group===x.group).length);
function update(weights,forecast,b){const out=Float64Array.from(weights,(w,i)=>w*forecast.components[forecast.members[i]][b]);
  const z=out.reduce((a,v)=>a+v,0);if(!(z>0&&Number.isFinite(z)))throw Error('Invalid Bayesian likelihood');
  return out.map(w=>w/z);
}
function forecast(s,h,plays,weights,eq,network){
  const [ac,ah]=Rules.actions(s),e=eq.query(s),canonical=p=>{const out=[0,0,0];ah.forEach((b,j)=>out[b]=p[j]);return out;};
  const raw=network.predict(s,h,eq),components=[canonical(e.human),canonical(ah.map(b=>.98*raw[b]+.02/ah.length))];
  for(const strength of STRENGTHS)for(let choice=0;choice<3;choice++){
    const legalChoice=ah.includes(choice)?choice:ah.includes(2)?2:1;
    components.push(canonical(ah.map((b,j)=>(1-strength)*e.human[j]+strength*(.05/ah.length+.95*Number(b===legalChoice)))));
  }
  const counts=ac.map((_,i)=>4*e.computer[i]);
  for(const token of h.filter(t=>!!t[1]===(s.phase==='pick')).slice(-16)){
    const i=ac.indexOf(token.slice(2,5).indexOf(1));if(i>=0)counts[i]++;
  }
  const z=counts.reduce((a,b)=>a+b,0),q=ah.map((_,j)=>e.matrix.reduce((v,row,i)=>v+counts[i]/z*row[j],0));
  const min=Math.min(...q),scale=Math.max(.02,Math.max(...q)-min),pc=q.map(v=>Math.exp(-6*(v-min)/scale)),total=pc.reduce((a,b)=>a+b,0);
  for(const strength of STRENGTHS)components.push(canonical(ah.map((_,j)=>(1-strength)*e.human[j]+strength*pc[j]/total)));
  const past=priorActions(s,h),members=new Uint8Array(BANK.length),mass=new Float64Array(components.length);
  for(let i=0;i<BANK.length;i++){
    const p=BANK[i];let member;
    if(p.group==='network')member=1;
    else if(p.group==='public_counter')member=11+p.strength;
    else if(p.group==='long_memory'&&s.phase==='play'&&past.length<p.lag)member=0;
    else{
      const stage=p.group==='hidden_switch'&&plays>=p.change?1+Math.floor((plays-p.change)/p.period):0;
      const context=p.group==='long_memory'?past[p.lag-1]:p.group==='hidden_switch'?(s.previous[0]<0?1:s.previous[0]):0;
      const choice=s.phase==='pick'?(p.pick+stage)%3:(p.offset+context+stage)%3;
      member=2+3*p.strength+choice;
    }
    members[i]=member;mass[member]+=weights[i];
  }
  const prediction=[0,0,0];components.forEach((p,i)=>p.forEach((v,b)=>prediction[b]+=mass[i]*v));
  return {prediction,components,members};
}
class Belief {
  constructor(network,learning=true,snapshot=null){this.network=network;this.learning=learning;
    this.weights=snapshot?Float64Array.from(snapshot.weights):PRIOR.slice();this.plays=snapshot?.plays||0;this.observations=snapshot?.observations||0;this.root=null;
  }
  snapshot(){return {weights:Array.from(this.weights),plays:this.plays,observations:this.observations};}
  groups(){return Object.fromEntries(GROUPS.map(g=>[g,BANK.reduce((n,p,i)=>n+(p.group===g?this.weights[i]:0),0)]));}
  prepare(s,h,eq){if(this.root)throw Error('Previous observation not consumed');this.eq=eq;this.nodes=new Map();
    this.root={s,h:h.slice(-64),plays:this.plays,weights:this.weights};this.nodes.set('',this.root);
  }
  nodeForecast(n){if(n.forecast)return n.forecast;
    if(!n.weights){const parent=this.nodeForecast(n.parent);n.weights=this.learning?share(update(n.parent.weights,parent,n.human)):this.weights;}
    n.forecast=forecast(n.s,n.h,n.plays,n.weights,this.eq,this.network);return n.forecast;
  }
  predictAt(s,h,eq,path=[]){if(eq!==this.eq||!this.root)throw Error('Unprepared belief');let n=this.root,key='';
    for(const [a,b] of path){key+=a+','+b+';';if(!this.nodes.has(key)){
        this.nodeForecast(n);const r=Rules.transition(n.s,a,b);if(!r.state)throw Error('Terminal forecast');
        this.nodes.set(key,{s:r.state,h:Rules.remember(n.h,Rules.event(n.s,a,b,r)),plays:n.plays+Number(n.s.phase==='play'),parent:n,human:b});
      }n=this.nodes.get(key);
    }
    return this.nodeForecast(n).prediction.slice();
  }
  predict(s,h,eq){return this.predictAt(s,h,eq,[]);}
  observe(a,b,r){if(!this.root)throw Error('No pending public observation');const n=this.root,[ac,ah]=Rules.actions(n.s);
    if(!ac.includes(a)||!ah.includes(b))throw Error('Illegal reveal');
    if(JSON.stringify(Rules.transition(n.s,a,b))!==JSON.stringify(r))throw Error('Reveal transition mismatch');
    if(this.learning)this.weights=share(update(this.weights,this.nodeForecast(n),b));
    this.plays+=Number(n.s.phase==='play');this.observations++;this.root=null;this.nodes=null;
  }
}
function share(weights){return weights.map((w,i)=>(1-RATE)*w+RATE*PRIOR[i]);}
function validateMemory(value,observations){
  if(!value||value.policy!==MEMORY_POLICY||!Array.isArray(value.weights)||value.weights.length!==BANK.length||
    value.weights.some(w=>!Number.isFinite(w)||w<0)||Math.abs(value.weights.reduce((a,b)=>a+b,0)-1)>1e-9||
    value.observations!==observations||!Number.isSafeInteger(value.plays)||value.plays<0||value.plays>observations)
    throw Error('Invalid full-match belief memory');
  return value;
}
module.exports={Belief,BANK,PRIOR,GROUPS,STRENGTHS,forecast,update,RATE,MEMORY_POLICY,validateMemory};
