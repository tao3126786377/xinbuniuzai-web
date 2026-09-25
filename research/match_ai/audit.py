"""Independent full-horizon best responses against both fixed equilibrium policies."""
import json
from pathlib import Path
import time
import numpy as np
from numba import njit
from .equilibrium import topology, next_value
from .matrix import solve_game


@njit(cache=True)
def audit_round(values,pairs,active,nxt,dc,dh,moves,lengths,beq,blo,bhi,last):
    cap=active.shape[1]; lower=np.empty(len(pairs)); upper=np.empty(len(pairs))
    for mi in range(len(pairs)):
        mc,mh=pairs[mi]; qpl=np.empty((3,3)); qph=np.empty((3,3)); qpe=np.empty((3,3))
        for pick in range(9):
            pc,ph=pick//3,pick%3
            lo=np.full((cap,30),np.nan); hi=np.full((cap,30),np.nan)
            for t in range(cap-1,-1,-1):
                for k in range(30):
                    if not active[pick,t,k]: continue
                    nc,nh=lengths[k,0],lengths[k,1]
                    qe=np.empty((nc,nh)); ql=np.empty_like(qe); qh=np.empty_like(qe)
                    for ai in range(nc):
                        a=moves[k,0,ai]
                        for bi in range(nh):
                            b=moves[k,1,bi]; nk=nxt[k,a,b]
                            if nk>=0 and t+1<cap:
                                qe[ai,bi]=values[mi,pick,t+1,nk]
                                ql[ai,bi]=lo[t+1,nk]; qh[ai,bi]=hi[t+1,nk]
                            else:
                                cm=mc-5*pc if nk>=0 else mc+dc[pick,k,a,b]
                                hm=mh-5*ph if nk>=0 else mh+dh[pick,k,a,b]
                                qe[ai,bi]=next_value(cm,hm,last,beq)
                                ql[ai,bi]=next_value(cm,hm,last,blo)
                                qh[ai,bi]=next_value(cm,hm,last,bhi)
                    _,p,h,_=solve_game(qe)
                    lo[t,k]=np.min(p@ql); hi[t,k]=np.max(qh@h)
            k=pc*5+ph
            qpl[pc,ph]=lo[0,k]; qph[pc,ph]=hi[0,k]; qpe[pc,ph]=values[mi,pick,0,k]
        _,p,h,_=solve_game(qpe)
        lower[mi]=np.min(p@qpl); upper[mi]=np.max(qph@h)
    return lower,upper


def audit(eq,path):
    start=time.perf_counter()
    active,nxt,dc,dh,moves,lengths,pairs=topology(eq.config)
    shape=(2*eq.config.money+1,)*2
    beq=np.full(shape,np.nan); blo=np.full(shape,np.nan); bhi=np.full(shape,np.nan)
    for r in range(eq.config.rounds-1,-1,-1):
        lo,hi=audit_round(eq.values[r],np.asarray(pairs[r]),active,nxt,dc,dh,moves,lengths,
                         beq,blo,bhi,r==eq.config.rounds-1)
        if not np.all(np.isfinite(lo)) or not np.all(np.isfinite(hi)):
            raise ArithmeticError('Nonfinite best response')
        beq[:]=np.nan; blo[:]=np.nan; bhi[:]=np.nan
        for i,(mc,mh) in enumerate(pairs[r]):
            beq[mc,mh]=eq.picks[r][i]; blo[mc,mh]=lo[i]; bhi[mc,mh]=hi[i]
        print('best-response audit round',r+1,flush=True)
    m=eq.config.money
    result=dict(computer_equilibrium_vs_best_response=float(blo[m,m]),
                best_response_vs_human_equilibrium=float(bhi[m,m]),
                exploitability_gap=float(bhi[m,m]-blo[m,m]),seconds=time.perf_counter()-start)
    result['passed']=bool(result['exploitability_gap']<=.0001)
    Path(path).write_text(json.dumps(result,indent=2),encoding='utf-8')
    return result
