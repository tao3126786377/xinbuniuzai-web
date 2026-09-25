"""Oracle diagnosis, held-out prediction tests, and common safe lookahead."""
from functools import lru_cache
import json
from pathlib import Path
import time
import numpy as np
from ..rules import Config, initial, actions, transition
from ..equilibrium import build
from ..belief import Belief, OpponentModel
from ..matrix import safe_distribution, DELTA, SAFETY_TOLERANCE
from ..experiments import opponent_policy, summary, interval
from .data import FAMILIES, features, dense, event, remember, profile, random_stream
from .network import Predictor, group_mean


def oracle_values(eq,name,verify_response=False):
    """Exact known-opponent optimum within LOCAL constraints; not a global-budget optimum."""
    policies={}; local_loss=0.
    @lru_cache(None)
    def visit(s):
        nonlocal local_loss
        v,p,_,qeq=eq.query(s); ac,ah=actions(s)
        hp=opponent_policy(name,s,eq,p)
        scores=np.zeros((3,len(ac)))
        for i,a in enumerate(ac):
            for j,b in enumerate(ah):
                ns,u,_=transition(s,a,b,eq.config)
                scores[:,i]+=hp[j]*(np.full(3,u) if ns is None else visit(ns))
        safe,diag=safe_distribution(scores[1],qeq,v,p,temperature=0.)
        local_loss=max(local_loss,diag['local_loss']); policies[s]=safe
        return np.array([p@scores[0],safe@scores[1],max(scores[2])])
    start=time.perf_counter(); root=initial(eq.config); values=visit(root)
    result=dict(opponent=name,equilibrium=float(values[0]),safe_oracle=float(values[1]),
                unconstrained_diagnostic=float(values[2]),safe_gain=float(values[1]-values[0]),
                states=visit.cache_info().currsize,max_local_loss=local_loss)
    if verify_response:
        @lru_cache(None)
        def worst(s):
            ac,ah=actions(s); p=policies[s]; scores=[]
            for b in ah:
                value=0.
                for i,a in enumerate(ac):
                    if p[i]==0: continue
                    ns,u,_=transition(s,a,b,eq.config)
                    value+=p[i]*(u if ns is None else worst(ns))
                scores.append(value)
            return min(scores)
        result['full_best_response_score']=worst(root)
        result['guaranteed_floor']=eq.value(root)-eq.config.horizon*(DELTA+SAFETY_TOLERANCE)-eq.manifest['accumulated_error_bound']
        if result['full_best_response_score']<result['guaranteed_floor']-1e-12:
            raise ArithmeticError('Oracle policy violates full-game floor')
    result['seconds']=time.perf_counter()-start
    return result


def oracle_study(directory):
    directory=Path(directory); eq=build(directory/'tiny',Config(rounds=2,cap=2,money=10))
    result=dict(config=eq.manifest['config'],delta=DELTA,results=[])
    for name in ('uniform','reload','shoot','reactive','bankroll','switch'):
        row=oracle_values(eq,name,True); result['results'].append(row)
        print('oracle',name,row['safe_gain'],flush=True)
    (directory/'oracle.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result


def paired_bootstrap(values,seed=815,draws=2000):
    """Resample independent synthetic profiles, never individual correlated turns."""
    values=np.asarray(values); rng=np.random.default_rng(seed)
    means=values[rng.integers(len(values),size=(draws,len(values)))].mean(axis=1)
    return [float(x) for x in np.quantile(means,[.025,.975])]


def prediction_study(directory):
    directory=Path(directory)
    with np.load(directory/'test.npz') as f: test={k:f[k] for k in f.files}
    predictions={'bayes':test['bayes']}
    for name in ('linear','neural'):
        predictions[name]=Predictor.load(directory/f'{name}.npz').probabilities(test['x'],test['mask'])
    rows=[]
    for family in range(len(FAMILIES)):
        ix=test['family']==family; true=test['truth'][ix]; groups=test['group'][ix]; y=test['y'][ix]
        metrics={}; all_nll={}
        for name,pred in predictions.items():
            p=pred[ix]; ce=-np.sum(true*np.log(np.maximum(p,1e-300)),axis=1)
            nll=-np.log(np.maximum(p[np.arange(len(y)),y],1e-300))
            nll=group_mean(nll,groups); all_nll[name]=nll
            entropy=-np.sum(true*np.log(np.maximum(true,1e-300)),axis=1)
            metrics[name]=dict(nll=float(nll.mean()),nll_ci95=paired_bootstrap(nll),
                              conditional_kl=float(group_mean(ce-entropy,groups).mean()),
                              brier=float(group_mean(np.sum((p-true)**2,axis=1),groups).mean()))
        diff=all_nll['neural']-all_nll['linear']
        rows.append(dict(family=FAMILIES[family],unseen=family>=6,observations=int(ix.sum()),
                         profiles=len(np.unique(groups)),metrics=metrics,
                         neural_minus_linear=float(diff.mean()),difference_ci95=paired_bootstrap(diff)))
    result=dict(source='synthetic',resampling='independent profile clusters; exploratory per-family 95% intervals',results=rows)
    (directory/'prediction.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result


class Lookahead:
    """Same finite-depth planner for every prediction module. Exact equilibrium leaves.

    This deliberately isolates the prediction module, not a replacement for full
    Bayesian MCTS. Future public history/posteriors update on every branch.
    """
    def __init__(self,eq,kind,network=None,player=None,depth=2):
        if kind not in ('equilibrium','bayes','linear','neural','oracle'): raise ValueError(kind)
        if not eq.manifest['certified'] or eq.manifest['accumulated_error_bound']+505*(DELTA+SAFETY_TOLERANCE)>.02:
            raise ValueError('Missing certified safety baseline')
        self.eq,self.kind,self.network,self.player,self.depth=eq,kind,network,player,depth
        self.model=OpponentModel(eq)

    def prediction(self,s,history,belief):
        ah=actions(s)[1]
        if self.kind=='bayes': return self.model.prediction(s,belief)
        if self.kind=='oracle': return self.player.probabilities(s,history)
        if self.kind=='equilibrium': return self.eq.query(s)[2]
        return self.network.probabilities(features(s,history,self.eq),dense(np.ones(len(ah)),ah))[list(ah)]

    def decision(self,s,history,belief):
        start=time.perf_counter(); nodes=0; max_loss=0.; limited=0; fallbacks=0
        def visit(s,h,b,depth):
            nonlocal nodes,max_loss,limited,fallbacks
            nodes+=1
            v,peq,_,qeq=self.eq.query(s); ac,ah=actions(s)
            hp=self.prediction(s,h,b); scores=np.zeros(len(ac))
            for i,a in enumerate(ac):
                for j,op in enumerate(ah):
                    ns,u,meta=transition(s,a,op,self.eq.config)
                    if ns is None: future=u
                    elif depth==1: future=self.eq.value(ns)
                    else:
                        nh=remember(h,event(s,a,op,meta,False))
                        nb=self.model.update(s,b,op,bool(meta.get('round_end'))) if self.kind=='bayes' else b
                        future=visit(ns,nh,nb,depth-1)[0]
                    scores[i]+=hp[j]*future
            p,diag=safe_distribution(scores,qeq,v,peq,temperature=0.)
            limited+=int(min(qeq[int(np.argmax(scores))])<v-DELTA)
            max_loss=max(max_loss,diag['local_loss']); fallbacks+=int(diag['fallback'])
            return float(p@scores),p,scores
        if self.kind=='equilibrium' or not history:
            v,p,_,q=self.eq.query(s)
            scores=q@self.prediction(s,history,belief)
        else: _,p,scores=visit(s,history,belief,self.depth)
        return p,dict(scores=scores.tolist(),seconds=time.perf_counter()-start,nodes=nodes,
                      max_local_loss=max_loss,limited=limited,fallbacks=fallbacks)


def play(eq,planner,player,rng):
    s=initial(eq.config); belief=Belief.initial(); history=(); diag=dict(decisions=0,nodes=0,limited=0,fallbacks=0,
                                                                   seconds=0.,max_local_loss=0.)
    while True:
        p,d=planner.decision(s,history,belief); ac,ah=actions(s); hp=player.probabilities(s,history)
        a=ac[int(rng.choice(len(ac),p=p))]; b=ah[int(rng.choice(len(ah),p=hp))]
        ns,u,meta=transition(s,a,b,eq.config)
        history=remember(history,event(s,a,b,meta,ns is None))
        if planner.kind=='bayes':
            belief=planner.model.update(s,belief,b,bool(meta.get('round_end')) and ns is not None)
        diag['decisions']+=1
        for k in ('nodes','limited','fallbacks','seconds'): diag[k]+=d[k]
        diag['max_local_loss']=max(diag['max_local_loss'],d['max_local_loss'])
        if ns is None: return u,diag
        s=ns


def games_for_family(baseline,directory,family,games):
    from ..equilibrium import Equilibrium
    eq=Equilibrium(baseline); directory=Path(directory)
    linear=Predictor.load(directory/'linear.npz'); neural=Predictor.load(directory/'neural.npz')
    controllers={'equilibrium':Lookahead(eq,'equilibrium'), 'bayes_d1':Lookahead(eq,'bayes',depth=1),
                 'bayes_d2':Lookahead(eq,'bayes'), 'linear_d2':Lookahead(eq,'linear',linear),
                 'neural_d2':Lookahead(eq,'neural',neural),'oracle_d2':Lookahead(eq,'oracle')}
    scores={k:[] for k in controllers}; diagnostics={k:dict(decisions=0,nodes=0,limited=0,fallbacks=0,seconds=0.,max_local_loss=0.) for k in controllers}
    start=time.perf_counter()
    for trial in range(games):
        player=profile('games',family,trial)
        for name,planner in controllers.items():
            planner.player=player
            score,d=play(eq,planner,player,random_stream('games',family,trial,1))
            scores[name].append(score)
            for k in d:
                if k=='max_local_loss': diagnostics[name][k]=max(diagnostics[name][k],d[k])
                else: diagnostics[name][k]+=d[k]
        if (trial+1)%32==0: print('games',family,trial+1,flush=True)
    comparisons={}
    for name,base in (('neural_d2','linear_d2'),('neural_d2','bayes_d2'),('bayes_d2','bayes_d1'),('oracle_d2','bayes_d2')):
        diff=np.asarray(scores[name])-scores[base]
        comparisons[f'{name}-{base}']=dict(mean=float(diff.mean()),ci95=interval(diff),bootstrap_ci95=paired_bootstrap(diff))
    return dict(family=family,planners={k:summary(v) for k,v in scores.items()},scores=scores,
                comparisons=comparisons,diagnostics=diagnostics,seconds=time.perf_counter()-start)


def game_study(eq,directory,games=128,workers=4):
    from concurrent.futures import ProcessPoolExecutor,as_completed
    directory=Path(directory); result=dict(games_per_family=games,source='synthetic',results={},depths=[1,2])
    start=time.perf_counter()
    with ProcessPoolExecutor(max_workers=workers) as pool:
        jobs=[pool.submit(games_for_family,str(eq.directory),str(directory),f,games) for f in FAMILIES]
        for job in as_completed(jobs):
            row=job.result(); result['results'][row['family']]=row; result['seconds']=time.perf_counter()-start
            (directory/'games.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result
