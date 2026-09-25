"""Causal reliability tests and a common safe two-decision lookahead."""
import json
from pathlib import Path
import time
import numpy as np
from ..rules import initial,actions,transition
from ..matrix import safe_distribution,DELTA,SAFETY_TOLERANCE
from ..experiments import summary,interval
from ..phase2.network import group_mean
from ..phase2.study import paired_bootstrap
from ..phase2.data import event,remember,dense
from .data import FAMILIES,profile,random_stream
from .reliability import Evidence,Forecast,expert_array,replay

KINDS=('equilibrium','linear','neural','calibrated','static','adaptive','frozen')


def metrics(p,y,groups,truth):
    losses=group_mean(-np.log(np.maximum(p[np.arange(len(y)),y],1e-300)),groups)
    confidence=p.max(axis=1); correct=p.argmax(axis=1)==y; high=confidence>=.9
    ece=0.
    for left,right in zip(np.linspace(0,1,11)[:-1],np.linspace(0,1,11)[1:]):
        ix=(confidence>left)&(confidence<=right)
        if ix.any(): ece+=ix.mean()*abs(confidence[ix].mean()-correct[ix].mean())
    kl=np.sum(truth*(np.log(np.maximum(truth,1e-300))-np.log(np.maximum(p,1e-300))),axis=1)
    return dict(nll=float(losses.mean()),ci95=paired_bootstrap(losses),conditional_kl=float(group_mean(kl,groups).mean()),
                ece=float(ece),high_confidence_count=int(high.sum()),
                high_confidence_error=float(1-correct[high].mean()) if high.any() else None),losses


def prediction_study(directory):
    directory=Path(directory); selection=json.loads((directory/'selection.json').read_text(encoding='utf-8'))
    with np.load(directory/'test.npz') as f: data={k:f[k] for k in f.files}
    experts=expert_array(data,selection['temperatures'])
    adaptive,weights=replay(experts,data['y'],data['group'],selection['share'])
    predictions=dict(linear=experts[:,1],neural=data['neural'],calibrated=experts[:,0],
                     static=np.einsum('k,nka->na',selection['static_weights'],experts),adaptive=adaptive)
    rows=[]
    for index,family in enumerate(FAMILIES):
        ix=data['family']==index; ms={}; losses={}
        for name,p in predictions.items():
            ms[name],losses[name]=metrics(p[ix],data['y'][ix],data['group'][ix],data['truth'][ix])
        comparisons={}
        for base in ('neural','calibrated','static'):
            diff=losses['adaptive']-losses[base]
            comparisons[base]=dict(mean=float(diff.mean()),ci95=paired_bootstrap(diff))
        rows.append(dict(family=family,unseen=family in FAMILIES[-2:],metrics=ms,comparisons=comparisons,
                         mean_expert_weights=weights[ix].mean(axis=0).tolist(),observations=int(ix.sum()),
                         profiles=len(np.unique(data['group'][ix]))))
    recovery=[]
    for lo,hi in ((0,3),(3,8),(8,100)):
        ix=(data['family']==FAMILIES.index('changing'))&(data['after_change']>=lo)&(data['after_change']<hi)
        if not ix.any(): continue
        recovery.append(dict(turns_after_change=[lo,hi-1],observations=int(ix.sum()),
            weights=weights[ix].mean(axis=0).tolist(),
            nll={k:float(-np.log(np.maximum(p[ix][np.arange(ix.sum()),data['y'][ix]],1e-300)).mean()) for k,p in predictions.items()}))
    result=dict(source='synthetic',results=rows,recovery=recovery,
                intervals='paired profile bootstrap; exploratory, no multiplicity correction')
    (directory/'prediction.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result


class ReliabilityPlanner:
    def __init__(self,eq,forecast,kind,depth=2):
        if kind not in KINDS: raise ValueError(kind)
        if not eq.manifest['certified'] or eq.manifest['accumulated_error_bound']+505*(DELTA+SAFETY_TOLERANCE)>.02:
            raise ValueError('Uncertified safety baseline')
        self.eq,self.forecast,self.kind,self.depth=eq,forecast,kind,depth

    def decision(self,s,history,evidence):
        start=time.perf_counter(); nodes=0; loss=0.; fallbacks=0
        v,peq,eqh,qeq=self.eq.query(s); ac,ah=actions(s)
        if self.kind=='equilibrium':
            root_raw=dense(eqh,ah); root_experts=np.tile(root_raw,(3,1)); prediction=root_raw
        else:
            root_experts,root_raw=self.forecast.experts(s,history,self.eq)
            prediction=self.forecast.predict(self.kind,root_experts,root_raw,evidence)
        def visit(s,h,e,depth,cached=None):
            nonlocal nodes,loss,fallbacks
            nodes+=1; v,p,_,q=self.eq.query(s); ac,ah=actions(s)
            experts,raw=cached if cached is not None else self.forecast.experts(s,h,self.eq)
            hp=self.forecast.predict(self.kind,experts,raw,e); scores=np.zeros(len(ac))
            next_e={b:e.update(experts,b,self.forecast.selection['share'],e.observations+1)
                    if self.kind=='adaptive' and depth>1 else e for b in ah}
            for i,a in enumerate(ac):
                for b in ah:
                    ns,u,meta=transition(s,a,b,self.eq.config)
                    if ns is None: future=u
                    elif depth==1: future=self.eq.value(ns)
                    else: future=visit(ns,remember(h,event(s,a,b,meta,False)),next_e[b],depth-1)[0]
                    scores[i]+=hp[b]*future
            chosen,diag=safe_distribution(scores,q,v,p,temperature=0.)
            loss=max(loss,float(v-min(chosen@q))); fallbacks+=int(diag['fallback'])
            return float(chosen@scores),chosen,scores
        if self.kind=='equilibrium' or evidence.observations==0:
            p=peq; scores=qeq@prediction[list(ah)]; loss=float(v-min(p@qeq))
        else: _,p,scores=visit(s,history,evidence,self.depth,(root_experts,root_raw))
        return p,dict(seconds=time.perf_counter()-start,nodes=nodes,max_local_loss=loss,fallbacks=fallbacks,
                      scores=scores.tolist(),prediction=prediction,experts=root_experts)


def play(eq,planner,player,rng,trace=None):
    s=initial(eq.config); evidence=Evidence(); history=()
    stats=dict(decisions=0,nodes=0,seconds=0.,max_local_loss=0.,fallbacks=0)
    while True:
        p,d=planner.decision(s,history,evidence); ac,ah=actions(s); hp=player.probabilities(s,history)
        a=ac[int(rng.choice(len(ac),p=p))]; b=ah[int(rng.choice(len(ah),p=hp))]
        ns,u,meta=transition(s,a,b,eq.config)
        before=evidence
        if planner.kind in ('adaptive','frozen'):
            evidence=evidence.update(d['experts'],b,planner.forecast.selection['share'],evidence.observations+1)
        else: evidence=Evidence(evidence.log_weights,evidence.observations+1)
        history=remember(history,event(s,a,b,meta,ns is None))
        stats['decisions']+=1
        for key in ('nodes','seconds','fallbacks'): stats[key]+=d[key]
        stats['max_local_loss']=max(stats['max_local_loss'],d['max_local_loss'])
        if trace is not None:
            trace.write(json.dumps(dict(source='synthetic',planner=planner.kind,state=s.to_dict(),
                event_id=evidence.observations,computer=a,human=b,computer_distribution=p.tolist(),
                prediction_before_reveal=d['prediction'].tolist(),weights_before=before.weights.tolist(),
                weights_after=evidence.weights.tolist(),settlement=meta,terminal_score=u))+'\n')
        if ns is None: return u,stats
        s=ns


def games_for_family(baseline,directory,family,games):
    from ..equilibrium import Equilibrium
    eq=Equilibrium(baseline); forecast=Forecast(directory); directory=Path(directory)
    controllers={kind:ReliabilityPlanner(eq,forecast,kind) for kind in KINDS}
    scores={k:[] for k in KINDS}; diagnostics={k:dict(decisions=0,nodes=0,seconds=0.,max_local_loss=0.,fallbacks=0) for k in KINDS}
    start=time.perf_counter()
    with (directory/f'{family}_example.jsonl').open('w',encoding='utf-8') as trace:
        for i in range(games):
            player=profile('games',family,i)
            for kind,planner in controllers.items():
                score,d=play(eq,planner,player,random_stream('games',family,i,1),trace if i==0 else None)
                scores[kind].append(score)
                for key in d:
                    if key=='max_local_loss': diagnostics[kind][key]=max(diagnostics[kind][key],d[key])
                    else: diagnostics[kind][key]+=d[key]
            if (i+1)%32==0: print('phase3 games',family,i+1,flush=True)
    comparisons={}
    for base in ('neural','calibrated','static','frozen'):
        diff=np.asarray(scores['adaptive'])-scores[base]
        comparisons[base]=dict(mean=float(diff.mean()),ci95=interval(diff),bootstrap_ci95=paired_bootstrap(diff))
    return dict(scores=scores,planners={k:summary(v) for k,v in scores.items()},diagnostics=diagnostics,
                comparisons=comparisons,seconds=time.perf_counter()-start,family=family)


def game_study(eq,directory,games=128,workers=4):
    from concurrent.futures import ProcessPoolExecutor,as_completed
    directory=Path(directory); start=time.perf_counter()
    result=dict(source='synthetic',games_per_family=games,config=eq.manifest['config'],results={})
    with ProcessPoolExecutor(max_workers=workers) as pool:
        jobs=[pool.submit(games_for_family,str(eq.directory),str(directory),family,games) for family in FAMILIES]
        for job in as_completed(jobs):
            row=job.result(); result['results'][row['family']]=row; result['seconds']=time.perf_counter()-start
            (directory/'games.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result


def decision_probe(eq,directory):
    """Post-hoc matched-state diagnostic, never used to select model parameters.

    Score each root distribution with a common privileged two-step continuation.
    These are truncated-horizon opportunity costs, not full-game regret estimates.
    """
    from ..rules import State
    from ..belief import Belief
    from ..phase2.study import Lookahead
    directory=Path(directory); forecast=Forecast(directory)
    kinds=('neural','calibrated','static','adaptive','frozen')
    planners={kind:ReliabilityPlanner(eq,forecast,kind) for kind in kinds}; rows=[]
    for family in FAMILIES:
        records=[json.loads(line) for line in (directory/f'{family}_example.jsonl').read_text(encoding='utf-8').splitlines()]
        records=[r for r in records if r['planner']=='neural']
        chosen=set(np.linspace(0,len(records)-1,min(12,len(records)),dtype=int))
        history=(); evidence=Evidence(); player=profile('games',family,0)
        oracle=Lookahead(eq,'oracle',player=player,depth=2)
        for index,r in enumerate(records):
            values=dict(r['state']); values['previous']=tuple(values['previous']); s=State(**values)
            experts,_=forecast.experts(s,history,eq)
            if index in chosen:
                op,od=oracle.decision(s,history,Belief.initial()); scores=np.asarray(od['scores'])
                best=float(op@scores); policies={}; costs={}; ce={}; ah=actions(s)[1]; truth=player.probabilities(s,history)
                for kind,planner in planners.items():
                    p,d=planner.decision(s,history,evidence)
                    policies[kind]=p.tolist(); costs[kind]=max(0.,best-float(p@scores))
                    ce[kind]=float(-truth@np.log(np.maximum(d['prediction'][list(ah)],1e-300)))
                tv=float(np.abs(np.asarray(policies['adaptive'])-policies['neural']).sum()/2)
                rows.append(dict(family=family,event_id=index+1,state=s.to_dict(),policies=policies,
                                 oracle_root_scores=scores.tolist(),opportunity_cost=costs,prediction_cross_entropy=ce,
                                 adaptive_vs_neural_total_variation=tv))
            evidence=evidence.update(experts,r['human'],forecast.selection['share'],evidence.observations+1)
            history=remember(history,event(s,r['computer'],r['human'],r['settlement'],r['terminal_score'] is not None))
    tv=np.array([r['adaptive_vs_neural_total_variation'] for r in rows])
    changed=[r for r in rows if r['adaptive_vs_neural_total_variation']>.01]
    result=dict(source='synthetic',selection='up to 12 evenly spaced states from the first neural game in each family; post-hoc descriptive diagnostic',
                states=len(rows),mean_total_variation=float(tv.mean()),fraction_tv_above_001=float((tv>.01).mean()),
                changed_states=len(changed),changed_with_equal_reference_values=int(sum(np.ptp(r['oracle_root_scores'])<1e-10 for r in changed)),
                mean_opportunity_cost={k:float(np.mean([r['opportunity_cost'][k] for r in rows])) for k in kinds},
                rows=rows)
    (directory/'decisions.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result
