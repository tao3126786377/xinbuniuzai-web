"""Synthetic histories covering delayed reactions and future search branches."""
from dataclasses import dataclass
from pathlib import Path
import json
import numpy as np
from ..rules import initial, actions, transition, DEFEND, RELOAD
from ..phase2.data import Profile, FAMILIES as OLD, event, dense
from ..phase3.data import Scenario, FAMILIES as PREVIOUS
from .model import remember, temporal_features

TRAIN_FAMILIES = PREVIOUS + ('lagged', 'own_lag')
TEST_FAMILIES = TRAIN_FAMILIES + ('hybrid', 'drifting')
SPLITS = dict(train=11, validation=17, tuning=23, test=31)


def rng_for(split, family, index, stream=0):
    return np.random.default_rng(np.random.SeedSequence([20260925,5,SPLITS[split],TEST_FAMILIES.index(family),index,stream]))


@dataclass(frozen=True)
class Player:
    family: str
    scenario: Scenario
    lag: int
    mapping: tuple

    def probabilities(self,s,h):
        if self.family in PREVIOUS: return self.scenario.probabilities(s,h[-8:])
        legal = actions(s)[1]; past = []
        for e in reversed(h):
            if e[8] or e[1]: break
            past.append((int(np.argmax(e[2:5])),int(np.argmax(e[5:8]))))
        if s.phase == 'pick': choice = self.scenario.first.pick
        else:
            lag = self.lag; side = int(self.family == 'own_lag'); mapping = self.mapping
            if self.family == 'hybrid':
                side = int(s.mh < s.mc); lag = 1 + (lag % 4) if side else lag
            elif self.family == 'drifting' and s.turn >= self.scenario.change_turn:
                mapping = tuple((a+1)%3 for a in mapping); lag = 1 + (lag % 4)
            old = past[lag-1][side] if len(past) >= lag else DEFEND
            choice = mapping[old]
        if choice not in legal: choice = RELOAD if RELOAD in legal else DEFEND
        p = np.full(len(legal),self.scenario.first.noise/len(legal)); p[legal.index(choice)] += 1-self.scenario.first.noise
        return p


def profile(split,family,index):
    rng = rng_for(split,family,index)
    def one(name):
        return Profile(name,float(rng.uniform(.08,.30)),int(rng.integers(3)),int(rng.integers(2,5)),
                       tuple(int(x) for x in rng.permutation(3)),int(rng.integers(3)))
    if family == 'changing': first = one('streak'); second = one('reactive' if rng.random()<.5 else 'cycle')
    else: first = one(family if family in OLD else 'fixed'); second = first
    return Player(family,Scenario(family,first,second,int(rng.integers(6,13))),int(rng.integers(1,5)),
                  tuple(int(x) for x in rng.permutation(3)))


def generate(eq,output,counts=None):
    output = Path(output); output.mkdir(parents=True,exist_ok=True)
    counts = counts or dict(train=64,validation=16)
    manifest = dict(source='synthetic',seed_prefix=[20260925,5],splits=SPLITS,train_families=TRAIN_FAMILIES,
        heldout_families=TEST_FAMILIES[-2:],labels='sampled public human actions only; no hidden type or true probability inputs',
        history_window=64,games_per_profile=3,max_rows_per_profile=96,sequences={})
    for split,count in counts.items():
        rows = {k:[] for k in ('x','mask','y','group')}; branches = 0
        for family in TRAIN_FAMILIES:
            for i in range(count):
                player = profile(split,family,i); rng = rng_for(split,family,i,1); h = (); samples = []
                for game in range(3):
                    s = initial(eq.config); exploration = float(rng.choice([0.,.3,.8]))
                    while True:
                        ac,ah = actions(s); hp = player.probabilities(s,h)
                        x = temporal_features(s,h,eq); b = ah[int(rng.choice(len(ah),p=hp))]
                        samples.append((x,dense(np.ones(len(ah)),ah),b))
                        p = (1-exploration)*eq.query(s)[1] + exploration/len(ac)
                        a = ac[int(rng.choice(len(ac),p=p))]
                        # One alternative branch produces another observed-action target.
                        if rng.random() < .3:
                            alt = ac[int(rng.integers(len(ac)))]; ns,_,meta = transition(s,alt,b,eq.config)
                            if ns is not None:
                                nh = remember(h,event(s,alt,b,meta,False)); legal = actions(ns)[1]
                                bx = temporal_features(ns,nh,eq)
                                y = legal[int(rng.choice(len(legal),p=player.probabilities(ns,nh)))]
                                samples.append((bx,dense(np.ones(len(legal)),legal),y)); branches += 1
                        ns,u,meta = transition(s,a,b,eq.config); h = remember(h,event(s,a,b,meta,ns is None))
                        if ns is None: break
                        s = ns
                chosen = rng.choice(len(samples),min(96,len(samples)),replace=False)
                for j in chosen:
                    x,mask,y = samples[j]
                    for k,value in (('x',x),('mask',mask),('y',y),('group',TEST_FAMILIES.index(family)*100000+i)):
                        rows[k].append(value)
            print('phase5 data',split,family,len(rows['y']),flush=True)
        arrays = {k:np.asarray(v,dtype=float if k in ('x','mask') else np.int64) for k,v in rows.items()}
        np.savez_compressed(output/f'{split}.npz',**arrays)
        manifest['sequences'][split] = dict(profiles=count*len(TRAIN_FAMILIES),observations=len(rows['y']),generated_branch_observations=branches)
    (output/'data.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
