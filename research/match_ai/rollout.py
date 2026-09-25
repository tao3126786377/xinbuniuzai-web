"""Compiled equilibrium tail. Root sampling marginalizes belief updates exactly.

The tail policy is belief-independent, so sampling a hidden type once (and
resampling from the prior at round switches) is distributionally equivalent to
updating the posterior after each observation. Frozen prediction resamples a
type from the same frozen belief at every step instead.
"""
import numpy as np
from numba import njit
from numba.typed import List
from .equilibrium import topology, BINDEX
from .matrix import solve_game
from .belief import PARAMETERS, PRIOR


@njit(cache=True)
def sample(p):
    u=np.random.random(); c=0.
    for i in range(len(p)):
        c+=p[i]
        if u<c: return i
    return len(p)-1


@njit(cache=True)
def boundary_value(mc,mh,r,rounds,indices,picks):
    if mc<=0 or mh<=0 or r+1>=rounds:
        return 1. if mc>mh else 0. if mc<mh else .5
    return picks[r+1][indices[r+1,mc,mh]]


@njit(cache=True)
def tail(values,picks,indices,nxt,dc,dh,moves,lengths,parameters,prior,weights,
         rounds,cap,phase,r,t,mc,mh,pc,ph,k,previous_c,last_result,adaptive,seed):
    np.random.seed(seed)
    theta=sample(weights)
    while True:
        mi=indices[r,mc,mh]
        if phase==0:
            nc=nh=3; q=np.empty((3,3))
            for a in range(3):
                for b in range(3): q[a,b]=values[r][mi,3*a+b,0,5*a+b]
        else:
            nc,nh=lengths[k,0],lengths[k,1]; q=np.empty((nc,nh)); pick=3*pc+ph
            draw=boundary_value(mc-5*pc,mh-5*ph,r,rounds,indices,picks)
            for ai in range(nc):
                a=moves[k,0,ai]
                for bi in range(nh):
                    b=moves[k,1,bi]; nk=nxt[k,a,b]
                    if nk>=0: q[ai,bi]=values[r][mi,pick,t+1,nk] if t+1<cap else draw
                    else: q[ai,bi]=boundary_value(mc+dc[pick,k,a,b],mh+dh[pick,k,a,b],r,rounds,indices,picks)
        _,p,h,_=solve_game(q)
        if not adaptive: theta=sample(weights)
        param=parameters[theta]; human=np.empty(nh); deficit=(mc-mh)/(mc+mh)
        for bi in range(nh):
            b=bi if phase==0 else moves[k,1,bi]
            if phase==0: logit=(param[3]*deficit+param[4]*last_result+param[5])*b
            else:
                logit=param[0]*(b==0)+param[1]*(b==2)+param[2]*(b==1 and previous_c==0)
                logit+=(param[3]*deficit+param[4]*last_result)*(b!=1)
            human[bi]=(.98*h[bi]+.02/nh)*np.exp(logit)
        human/=human.sum()
        ai=sample(p); bi=sample(human)
        if phase==0:
            pc,ph=ai,bi; k=pc*5+ph; t=0; previous_c=-1; phase=1; continue
        a=moves[k,0,ai]; b=moves[k,1,bi]; nk=nxt[k,a,b]
        if nk>=0 and t+1<cap:
            k=nk; t+=1; previous_c=a; continue
        if nk>=0:
            mc-=5*pc; mh-=5*ph; last_result=0
        else:
            change=dc[3*pc+ph,k,a,b]
            # Infer round result from immediate shot/load or terminal ammo state;
            # transfer can be zero despite a non-draw win.
            bc=k//5 if k<25 else k-20
            bh=k%5 if k<25 else bc
            nbc=bc+(a==2)-(a==0); nbh=bh+(b==2)-(b==0)
            if a==0 and b==2: last_result=1
            elif b==0 and a==2: last_result=-1
            elif nbc>=10 and nbh>=10: last_result=0
            else: last_result=1 if nbc>=5 and nbc>nbh else -1
            mc+=change; mh+=dh[3*pc+ph,k,a,b]
        if mc<=0 or mh<=0 or r+1>=rounds:
            return 1. if mc>mh else 0. if mc<mh else .5
        r+=1; phase=0; t=0; previous_c=-1
        if adaptive and np.random.random()<.05: theta=sample(prior)


class Rollout:
    def __init__(self,eq):
        self.eq=eq
        _,self.nxt,self.dc,self.dh,self.moves,self.lengths,_=topology(eq.config)
        self.values=List([np.asarray(x) for x in eq.values])
        self.picks=List([np.asarray(x) for x in eq.picks])
        self.indices=np.full((eq.config.rounds,2*eq.config.money+1,2*eq.config.money+1),-1,dtype=np.int64)
        for r,lookup in enumerate(eq.indices):
            for (mc,mh),i in lookup.items(): self.indices[r,mc,mh]=i

    def run(self,s,belief,adaptive,seed):
        return tail(self.values,self.picks,self.indices,self.nxt,self.dc,self.dh,self.moves,self.lengths,
                    PARAMETERS,PRIOR,belief.weights,self.eq.config.rounds,self.eq.config.cap,
                    int(s.phase=='play'),s.round-1,s.turn-1,s.mc,s.mh,s.pc,s.ph,
                    BINDEX.get((s.bc,s.bh),0),s.previous[0],s.last_result,adaptive,seed)
