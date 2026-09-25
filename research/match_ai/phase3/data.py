"""Fresh causal sequences with development drift and unseen temporal behavior."""
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import shutil
import numpy as np
from ..rules import initial,actions,transition,SHOOT,DEFEND,RELOAD
from ..phase2.data import Profile,FAMILIES as OLD_FAMILIES,features,dense,event,remember
from ..phase2.network import Predictor

DEVELOPMENT=OLD_FAMILIES+('changing',)
FAMILIES=DEVELOPMENT+('delayed','contrarian')
SPLITS={'validation':103,'test':107,'games':109}


def random_stream(split,family,index,stream=0):
    return np.random.default_rng(np.random.SeedSequence([20260925,3,SPLITS[split],FAMILIES.index(family),index,stream]))


@dataclass(frozen=True)
class Scenario:
    family: str
    first: Profile
    second: Profile
    change_turn: int

    def probabilities(self,s,history):
        if self.family in OLD_FAMILIES: return self.first.probabilities(s,history)
        if self.family=='changing':
            return (self.second if s.phase=='play' and s.turn>=self.change_turn else self.first).probabilities(s,history)
        legal=actions(s)[1]; past=[]
        for e in reversed(history):
            if e[8] or e[1]: break
            past.append(int(np.argmax(e[2:5])))
        if s.phase=='pick': choice=self.first.pick
        elif self.family=='delayed':
            old=past[2] if len(past)>2 else DEFEND
            choice={SHOOT:DEFEND,DEFEND:RELOAD,RELOAD:SHOOT}[old]
        elif self.family=='contrarian':
            most=int(np.argmax(np.bincount(past[:5],minlength=3))) if past else DEFEND
            choice={SHOOT:DEFEND,DEFEND:RELOAD,RELOAD:SHOOT}[most]
            if s.mh<s.mc and s.bh>0 and most==DEFEND: choice=SHOOT
        else: raise ValueError(self.family)
        if choice not in legal: choice=RELOAD if RELOAD in legal else DEFEND
        p=np.full(len(legal),self.first.noise/len(legal)); p[legal.index(choice)]+=1-self.first.noise
        return p


def profile(split,family,index):
    rng=random_stream(split,family,index)
    def one(name):
        return Profile(name,float(rng.uniform(.08,.30)),int(rng.integers(3)),int(rng.integers(2,5)),
                       tuple(int(i) for i in rng.permutation(3)),int(rng.integers(3)))
    if family=='changing':
        first=one('streak'); second=one('reactive' if rng.random()<.5 else 'cycle')
    else: first=one(family if family in OLD_FAMILIES else 'fixed'); second=first
    return Scenario(family,first,second,int(rng.integers(6,13)))


def generate(eq,directory,source):
    directory=Path(directory); source=Path(source); directory.mkdir(parents=True,exist_ok=True)
    models={name:Predictor.load(source/f'{name}.npz') for name in ('linear','neural')}
    for name in models: shutil.copyfile(source/f'{name}.npz',directory/f'{name}.npz')
    manifest=dict(source='synthetic',study=3,seed_prefix=[20260925,3],splits=SPLITS,
                  development_families=DEVELOPMENT,unseen_families=FAMILIES[-2:],config=eq.manifest['config'],
                  baseline_error=eq.manifest['accumulated_error_bound'],sequences={},
                  frozen_weights={n:hashlib.sha256((source/f'{n}.npz').read_bytes()).hexdigest() for n in models})
    for split,count in (('validation',32),('test',64)):
        rows={k:[] for k in ('x','mask','y','truth','group','family','after_change')}
        families=DEVELOPMENT if split=='validation' else FAMILIES
        for family in families:
            for i in range(count):
                player=profile(split,family,i); rng=random_stream(split,family,i,1); history=()
                group=SPLITS[split]*100000+FAMILIES.index(family)*1000+i
                for game in range(2):
                    s=initial(eq.config); exploration=float(rng.choice([0.,.5,1.]))
                    while True:
                        ac,ah=actions(s); p=eq.query(s)[1]; p=(1-exploration)*p+exploration/len(p)
                        hp=player.probabilities(s,history)
                        rows['x'].append(features(s,history,eq)); rows['mask'].append(dense(np.ones(len(ah)),ah))
                        rows['truth'].append(dense(hp,ah)); rows['group'].append(group); rows['family'].append(FAMILIES.index(family))
                        rows['after_change'].append(s.turn-player.change_turn if family=='changing' and s.phase=='play' else -1000)
                        a=ac[int(rng.choice(len(ac),p=p))]; b=ah[int(rng.choice(len(ah),p=hp))]; rows['y'].append(b)
                        ns,u,meta=transition(s,a,b,eq.config); history=remember(history,event(s,a,b,meta,ns is None))
                        if ns is None: break
                        s=ns
            print('phase3 data',split,family,len(rows['y']),flush=True)
        arr={k:np.asarray(v,dtype=float if k in ('x','mask','truth') else np.int64) for k,v in rows.items()}
        for name,model in models.items(): arr[name]=model.probabilities(arr['x'],arr['mask'])
        del arr['x']
        np.savez_compressed(directory/f'{split}.npz',**arr)
        manifest['sequences'][split]=dict(profiles=len(np.unique(arr['group'])),observations=len(arr['y']))
    (directory/'data.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    return manifest
