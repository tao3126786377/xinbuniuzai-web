"""Synthetic opponents and independent-seed paired experiments."""
import json
import cProfile
from pathlib import Path
import platform
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
import numpy as np
from .rules import initial, actions, transition, SHOOT, DEFEND, RELOAD, State
from .belief import Belief, OpponentModel
from .planner import Planner

OPPONENTS=('equilibrium','uniform','reload','shoot','reactive','bankroll','switch','counter')
TEMPERATURES=(0.,.002,.005,.01,.02)
SPLIT_SEEDS={'train':190001,'validation':390001,'test':790001}


def trial_seed(split,opponent,trial,game=0):
    return int(np.random.SeedSequence([SPLIT_SEEDS[split],opponent,trial,game]).generate_state(1)[0])


def opponent_policy(name,s,eq,computer_distribution):
    """counter sees the distribution, never the sampled computer action."""
    _,_,base,qeq=eq.query(s)
    ac,ah=actions(s)
    if name=='equilibrium': return base
    if name=='uniform': return np.ones(len(ah))/len(ah)
    if name=='counter':
        p=np.zeros(len(ah)); p[np.argmin(computer_distribution@qeq)]=1; return p
    if name=='switch': name='reload' if s.round%2 else 'shoot'
    if s.phase=='pick': preferred=2 if name in ('reload','shoot') else (2 if s.mh<s.mc else 0)
    elif name=='reload': preferred=RELOAD
    elif name=='shoot': preferred=SHOOT if SHOOT in ah else RELOAD
    elif name=='reactive': preferred=DEFEND if s.previous[0]==SHOOT else RELOAD
    else: preferred=(SHOOT if SHOOT in ah else RELOAD) if s.mh<s.mc else DEFEND
    p=np.full(len(ah),.05/len(ah))
    p[ah.index(preferred) if preferred in ah else 0]+=.95
    return p


def run_match(eq,planner,belief,opponent,seed,simulations=8,trace=None):
    rng=np.random.default_rng(seed); s=initial(eq.config)
    stats=dict(decisions=0,seconds=0.,max_local_loss=0.,fallbacks=0)
    if trace: trace.write(json.dumps(dict(type='match_start',source='synthetic',opponent=opponent,
                        planner=planner.kind,seed=seed,observations=belief.observations))+'\n')
    while True:
        d=planner.decision(s,belief,simulations=simulations,seed=int(rng.integers(2**31)))
        ac,ah=actions(s); hp=opponent_policy(opponent,s,eq,d.probabilities)
        a=d.sample(rng); b=ah[int(rng.choice(len(ah),p=hp))]
        ns,u,meta=transition(s,a,b,eq.config)
        # Frozen lookahead still learns after REAL observations. Forget once at
        # a new round; match-end forgetting is handled by the next-match caller.
        belief=planner.model.update(s,belief,b,bool(meta.get('round_end')) and ns is not None)
        stats['decisions']+=1; stats['seconds']+=d.diagnostics['seconds']
        stats['max_local_loss']=max(stats['max_local_loss'],d.diagnostics.get('local_loss',0.))
        stats['fallbacks']+=int(d.diagnostics.get('fallback',False))
        if trace: trace.write(json.dumps(dict(type='observation',source='synthetic',event_id=belief.observations,
                  state=s.to_dict(),computer=a,human=b,settlement=meta,terminal_score=u,decision=d.to_dict()))+'\n')
        if ns is None:
            if trace: trace.write(json.dumps(dict(type='match_end',source='synthetic',score=u,money=meta['money']))+'\n')
            return u,belief,stats
        s=ns


def trained_belief(eq,opponent,trial,games=2):
    belief=Belief.initial(); planner=Planner(eq,'equilibrium'); oi=OPPONENTS.index(opponent)
    for g in range(games):
        _,belief,_=run_match(eq,planner,belief,opponent,trial_seed('train',oi,trial,g),0)
        belief=belief.forget()
    return belief


def interval(values,confidence=.95,bounds=(-1.,1.)):
    x=np.array(values,dtype=float); mean=float(x.mean())
    # Distribution-free Hoeffding interval, including all-wins/all-draws cases.
    half=(bounds[1]-bounds[0])*np.sqrt(np.log(2/(1-confidence))/(2*len(x)))
    return [max(bounds[0],mean-half),min(bounds[1],mean+half)]


def wilson(success,n):
    z=1.959963984540054; p=success/n; den=1+z*z/n
    mid=(p+z*z/(2*n))/den; half=z*np.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return [mid-half,mid+half]


def summary(scores):
    n=len(scores); win=scores.count(1.); draw=scores.count(.5); lose=scores.count(0.)
    return dict(n=n,score=float(np.mean(scores)),score_ci95=interval(scores,bounds=(0.,1.)),wins=win,draws=draw,losses=lose,
                win_ci95=wilson(win,n),draw_ci95=wilson(draw,n),loss_ci95=wilson(lose,n))


def _tune_opponent(directory,opponent,simulations,trials):
    from .equilibrium import Equilibrium
    eq=Equilibrium(directory)
    candidates={str(t):[] for t in TEMPERATURES}
    planners={t:Planner(eq,'belief',t) for t in TEMPERATURES}
    oi=OPPONENTS.index(opponent)
    for trial in range(trials):
        belief=trained_belief(eq,opponent,trial+10000)
        seed=trial_seed('validation',oi,trial)
        for temp in TEMPERATURES:
            score,_,_=run_match(eq,planners[temp],belief,opponent,seed,simulations)
            candidates[str(temp)].append(score)
    return candidates


def tune(eq,simulations=8,trials=16,workers=4):
    candidates={str(t):[] for t in TEMPERATURES}; parts={}
    with ProcessPoolExecutor(max_workers=workers) as pool:
        jobs={pool.submit(_tune_opponent,str(eq.directory),op,simulations,trials):op for op in OPPONENTS}
        for job in as_completed(jobs):
            op=jobs[job]; parts[op]=job.result(); print('validation',op,flush=True)
    for op in OPPONENTS:
        for key in candidates: candidates[key].extend(parts[op][key])
    best=max(TEMPERATURES,key=lambda t:np.mean(candidates[str(t)])); chosen=best
    for temp in TEMPERATURES:
        delta=np.array(candidates[str(best)])-np.array(candidates[str(temp)])
        if interval(delta)[0]<=0: chosen=temp; break
    return dict(chosen=chosen,trials_per_opponent=trials,
                selection='lowest temperature not significantly worse than empirical best; paired 95% CI',
                results={k:summary(v) for k,v in candidates.items()},
                by_opponent={op:{k:summary(v) for k,v in part.items()} for op,part in parts.items()})


def evaluate(eq,output,temperature,simulations=8,max_games=128,train_games=2,opponents=OPPONENTS):
    output=Path(output); output.mkdir(parents=True,exist_ok=True)
    if max_games<128 or max_games>2048 or max_games%128:
        raise ValueError('max_games must be a multiple of 128 within [128,2048]')
    results={}; start=time.perf_counter()
    for opponent in opponents:
        oi=OPPONENTS.index(opponent)
        scores={k:[] for k in ('equilibrium','frozen','belief')}
        diag={k:dict(decisions=0,seconds=0.,max_local_loss=0.,fallbacks=0) for k in scores}
        planners={k:Planner(eq,k,temperature) for k in scores}
        with (output/f'{opponent}_example.jsonl').open('w',encoding='utf-8') as trace:
            for trial in range(max_games):
                belief=trained_belief(eq,opponent,trial,train_games)
                seed=trial_seed('test',oi,trial)
                for kind,planner in planners.items():
                    score,_,stats=run_match(eq,planner,belief,opponent,seed,simulations,trace if trial==0 else None)
                    scores[kind].append(score)
                    for key in diag[kind]:
                        if key=='max_local_loss': diag[kind][key]=max(diag[kind][key],stats[key])
                        else: diag[kind][key]+=stats[key]
                if (trial+1)%128==0:
                    diff=np.array(scores['belief'])-np.array(scores['frozen'])
                    ci=interval(diff,1-.05/16)
                    print('test',opponent,trial+1,{k:round(np.mean(v),4) for k,v in scores.items()},flush=True)
                    if ci[0]>0 or ci[1]<0 or ci[1]-ci[0]<=.04: break
        diff=np.array(scores['belief'])-np.array(scores['frozen']); seq=interval(diff,1-.05/16)
        results[opponent]=dict(planners={k:summary(v) for k,v in scores.items()},diagnostics=diag,
                paired_belief_minus_frozen=float(diff.mean()),difference_ci95=interval(diff),
                sequential_adjusted_ci=seq,conclusion='positive' if seq[0]>0 else 'negative' if seq[1]<0 else 'inconclusive')
        (output/'evaluation.json').write_text(json.dumps(dict(results=results,seconds=time.perf_counter()-start,
                simulations=simulations,temperature=temperature,train_games=train_games,seeds=SPLIT_SEEDS),indent=2),encoding='utf-8')
    return json.loads((output/'evaluation.json').read_text())


def _evaluate_opponent(directory,output,temperature,simulations,max_games,train_games,opponent):
    from .equilibrium import Equilibrium
    return evaluate(Equilibrium(directory),output,temperature,simulations,max_games,train_games,(opponent,))


def evaluate_parallel(eq,output,temperature,simulations=8,max_games=128,train_games=2,workers=4):
    out=Path(output); out.mkdir(parents=True,exist_ok=True); start=time.perf_counter()
    result=dict(results={},simulations=simulations,temperature=temperature,train_games=train_games,seeds=SPLIT_SEEDS)
    with ProcessPoolExecutor(max_workers=workers) as pool:
        jobs=[pool.submit(_evaluate_opponent,str(eq.directory),str(out/'by_opponent'/op),temperature,
                          simulations,max_games,train_games,op) for op in OPPONENTS]
        for job in as_completed(jobs):
            result['results'].update(job.result()['results']); result['seconds']=time.perf_counter()-start
            (out/'evaluation.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result


def probes(eq,output,temperature=0.):
    rng=np.random.default_rng(909); samples=[]; belief=Belief.initial(); model=OpponentModel(eq)
    for game in range(4):
        s=initial(eq.config)
        while True:
            ac,ah=actions(s); p=eq.query(s)[1]; hp=opponent_policy('reload',s,eq,p)
            a=ac[int(rng.choice(len(ac),p=p))]; b=ah[int(rng.choice(len(ah),p=hp))]
            ns,u,meta=transition(s,a,b,eq.config)
            if belief.observations: samples.append((s,belief))
            belief=model.update(s,belief,b,bool(meta.get('round_end')) and ns is not None)
            if ns is None: break
            s=ns
        belief=belief.forget()
    timing=[]
    for kind in ('frozen','belief'):
        planner=Planner(eq,kind,temperature)
        selected=[samples[i] for i in np.linspace(0,len(samples)-1,3,dtype=int)]
        for i,(s,b) in enumerate(selected):
            for count in (4,16,64):
                d=planner.decision(s,b,simulations=count,seed=123+i)
                timing.append(dict(kind=kind,state=s.to_dict(),budget_simulations=count,decision=d.to_dict()))
            for seconds in (.5,1.,2.5):
                d=planner.decision(s,b,simulations=1000000,seconds=seconds,seed=123+i)
                timing.append(dict(kind=kind,state=s.to_dict(),budget_seconds=seconds,decision=d.to_dict()))
    contexts=[]
    for r in range(1,eq.config.rounds+1):
        pairs=list(eq.indices[r-1])
        chosen=[p for p in ((50,50),(40,40),(40,60),(60,40)) if p in eq.indices[r-1]]
        chosen+=sorted(pairs,key=lambda p:(abs(p[0]-p[1]),sum(p)))[:1]
        for mc,mh in dict.fromkeys(chosen):
            s=State('play',r,1,mc,mh,1,1,1,1); v,p,q,matrix=eq.query(s)
            contexts.append(dict(state=s.to_dict(),value=v,computer=p.tolist(),human=q.tolist(),q=matrix.tolist()))
    payouts=[]
    if eq.config.cap>=3:
        for r in (1,eq.config.rounds):
            for pick in range(9):
                pc,ph=divmod(pick,3)
                s=State('play',r,3,eq.config.money,eq.config.money,pc,ph,1,1)
                v,p,q,matrix=eq.query(s)
                payouts.append(dict(state=s.to_dict(),value=v,computer=p.tolist(),q=matrix.tolist()))
    temperatures=[]
    for temp in TEMPERATURES:
        planner=Planner(eq,'belief',temp)
        for i,(s,b) in enumerate(selected):
            decision=planner.decision(s,b,simulations=256,seed=8123+i)
            temperatures.append(dict(temperature=temp,state=s.to_dict(),decision=decision.to_dict()))
    profiler=cProfile.Profile()
    planner=Planner(eq,'belief',temperature)
    profiler.runcall(planner.decision,selected[0][0],selected[0][1],simulations=1024,seed=444)
    profile=[]
    for entry in profiler.getstats():
        if not isinstance(entry.code,str) and 'match_ai' in entry.code.co_filename:
            profile.append(dict(function=entry.code.co_name,file=Path(entry.code.co_filename).name,
                                calls=entry.callcount,self_seconds=entry.inlinetime,total_seconds=entry.totaltime))
    profile.sort(key=lambda e:e['self_seconds'],reverse=True)
    if platform.system()=='Windows':
        import ctypes
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_=[('cb',wintypes.DWORD),('faults',wintypes.DWORD)]+[(name,ctypes.c_size_t) for name in
                      ('peak_working_set','working_set','peak_pool','pool','peak_nonpaged','nonpaged','pagefile','peak_pagefile')]
        counters=Counters(); counters.cb=ctypes.sizeof(counters)
        kernel=ctypes.WinDLL('kernel32'); kernel.GetCurrentProcess.restype=wintypes.HANDLE
        read=ctypes.WinDLL('psapi').GetProcessMemoryInfo
        read.argtypes=[wintypes.HANDLE,ctypes.POINTER(Counters),wintypes.DWORD]
        if not read(kernel.GetCurrentProcess(),ctypes.byref(counters),counters.cb):
            raise ctypes.WinError()
        peak_bytes=int(counters.peak_working_set)
    else:
        import resource
        peak_bytes=int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)*(1 if platform.system()=='Darwin' else 1024)
    result=dict(timing=timing,contexts=contexts,payout_contexts=payouts,temperatures=temperatures,
                profile=profile[:12],temperature=temperature,process_peak_resident_bytes=peak_bytes,
                python=platform.python_version(),platform=platform.platform())
    Path(output).write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result


def learning_curves(eq,output,trials=128):
    """Prequential prediction quality, measured before each revealed action.

    Independent synthetic histories; this diagnoses learning, not a win-rate
    improvement or a claim about real players.
    """
    edges=(0,1,5,10,20,50,100,200,500,2001); result={}
    model=OpponentModel(eq)
    for oi,op in enumerate(('reload','reactive','switch')):
        sums=np.zeros((len(edges)-1,4))
        for trial in range(trials):
            b=Belief.initial(); rng=np.random.default_rng(trial_seed('validation',oi+20,trial))
            for game in range(4):
                s=initial(eq.config)
                while True:
                    ac,ah=actions(s); p=eq.query(s)[1]; true=opponent_policy(op,s,eq,p)
                    pred=model.prediction(s,b); cold=model.prediction(s,Belief.initial())
                    idx=min(len(edges)-2,max(0,np.searchsorted(edges,b.observations,side='right')-1))
                    sums[idx]+=np.array([1.,-true@np.log(pred),-true@np.log(cold),
                                         -np.sum(b.weights[b.weights>0]*np.log(b.weights[b.weights>0]))])
                    a=ac[int(rng.choice(len(ac),p=p))]; h=ah[int(rng.choice(len(ah),p=true))]
                    ns,u,meta=transition(s,a,h,eq.config)
                    b=model.update(s,b,h,bool(meta.get('round_end')) and ns is not None)
                    if ns is None: break
                    s=ns
                b=b.forget()
        result[op]=[dict(observations=[edges[i],edges[i+1]-1],samples=int(row[0]),
                         learned_logloss=float(row[1]/row[0]),prior_logloss=float(row[2]/row[0]),
                         belief_entropy=float(row[3]/row[0])) for i,row in enumerate(sums) if row[0]]
        print('learning curve',op,flush=True)
    Path(output).write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result
