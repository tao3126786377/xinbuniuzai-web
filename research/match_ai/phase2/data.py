"""Public-history features and synthetic profiles, split by complete histories."""
from dataclasses import dataclass
import json
from pathlib import Path
import numpy as np
from ..rules import actions, initial, transition, SHOOT, DEFEND, RELOAD
from ..belief import Belief, OpponentModel

FAMILIES=('fixed','reactive','bankroll','streak','cycle','switch','mimic','ambush')
TRAIN_FAMILIES=FAMILIES[:6]
SPLITS={'train':31,'validation':47,'test':61,'games':79}
WINDOW=8
INPUTS=19+WINDOW*11


def random_stream(split,family,index,stream=0):
    return np.random.default_rng(np.random.SeedSequence([20260925,SPLITS[split],FAMILIES.index(family),index,stream]))


def dense(probabilities,legal):
    p=np.zeros(3); p[list(legal)]=probabilities
    return p


def event(s,a,b,meta,terminal):
    """Only called AFTER simultaneous actions are revealed; immutable token."""
    return (1.,float(s.phase=='pick'),*(float(a==i) for i in range(3)),
            *(float(b==i) for i in range(3)),float(bool(meta.get('round_end'))),
            float(terminal),float(1 if meta.get('winner')==1 else -1 if meta.get('winner')==2 else 0))


def remember(history,token):
    return (history+(token,))[-WINDOW:]


def features(s,history,eq):
    eqh=dense(eq.query(s)[2],actions(s)[1])
    x=np.zeros(INPUTS)
    x[:19]=[float(s.phase=='pick'),s.round/5,s.turn/100,s.mc/100,s.mh/100,
            s.pc/2,s.ph/2,s.bc/10,s.bh/10,s.last_result,
            *(float(s.previous[0]==i) for i in range(3)),
            *(float(s.previous[1]==i) for i in range(3)),*eqh]
    if history:
        x[19:19+11*len(history)]=np.asarray(history[::-1]).ravel()
    return x


@dataclass(frozen=True)
class Profile:
    family: str
    noise: float
    offset: int
    threshold: int
    preference: tuple
    pick: int

    def probabilities(self,s,history):
        legal=actions(s)[1]
        plays=[]
        for e in reversed(history):
            if e[8] or e[1]: break  # current round only for synthetic memory rules
            plays.append((int(np.argmax(e[2:5])),int(np.argmax(e[5:8]))))
        if s.phase=='pick':
            choice=self.pick
            if self.family in ('bankroll','switch'):
                choice=2 if s.mh<s.mc or s.last_result>0 else 0
        elif self.family=='fixed': choice=self.preference[0]
        elif self.family=='reactive': choice=DEFEND if s.previous[0]==SHOOT else RELOAD
        elif self.family=='bankroll':
            choice=(SHOOT if s.bh else RELOAD) if s.mh<s.mc else DEFEND
        elif self.family=='streak':
            streak=0
            for _,b in plays:
                if b!=DEFEND: break
                streak+=1
            choice=RELOAD if streak>=self.threshold else DEFEND
        elif self.family=='cycle': choice=self.preference[(s.turn+self.offset)%3]
        elif self.family=='switch': choice=self.preference[(s.round+self.offset)%3]
        elif self.family=='mimic': choice=plays[1][0] if len(plays)>1 else RELOAD
        elif self.family=='ambush':
            quiet=len(plays)>=3 and all(a==DEFEND for a,_ in plays[:3])
            choice=RELOAD if quiet else (SHOOT if s.bh else DEFEND)
        else: raise ValueError(self.family)
        if choice not in legal: choice=RELOAD if RELOAD in legal else DEFEND
        p=np.full(len(legal),self.noise/len(legal)); p[legal.index(choice)]+=1-self.noise
        return p


def profile(split,family,index):
    rng=random_stream(split,family,index)
    return Profile(family,float(rng.uniform(.08,.30)),int(rng.integers(3)),
                   int(rng.integers(2,5)),tuple(int(i) for i in rng.permutation(3)),int(rng.integers(3)))


def generate(eq,directory,counts=None,games=2):
    directory=Path(directory); directory.mkdir(parents=True,exist_ok=True)
    counts=counts or dict(train=64,validation=16,test=32)
    manifest=dict(source='synthetic',split_seeds=SPLITS,profiles_per_family=counts,games_per_profile=games,
                  training_families=TRAIN_FAMILIES,unseen_families=FAMILIES[6:],window=WINDOW,inputs=INPUTS,splits={})
    model=OpponentModel(eq)
    for split,count in counts.items():
        rows={k:[] for k in ('x','mask','y','truth','bayes','group','family')}
        families=FAMILIES if split=='test' else TRAIN_FAMILIES
        for family in families:
            for i in range(count):
                player=profile(split,family,i); rng=random_stream(split,family,i,1)
                group=SPLITS[split]*100000+FAMILIES.index(family)*1000+i
                belief=Belief.initial(); history=()
                for game in range(games):
                    s=initial(eq.config)
                    exploration=float(rng.choice([0.,.5,1.]))
                    while True:
                        ac,ah=actions(s); pc=eq.query(s)[1]
                        pc=(1-exploration)*pc+exploration/len(pc)
                        hp=player.probabilities(s,history)
                        # Targets and oracle probabilities never enter feature construction.
                        rows['x'].append(features(s,history,eq)); rows['mask'].append(dense(np.ones(len(ah)),ah))
                        rows['truth'].append(dense(hp,ah)); rows['bayes'].append(dense(model.prediction(s,belief),ah))
                        a=ac[int(rng.choice(len(ac),p=pc))]; b=ah[int(rng.choice(len(ah),p=hp))]
                        rows['y'].append(b); rows['group'].append(group); rows['family'].append(FAMILIES.index(family))
                        ns,u,meta=transition(s,a,b,eq.config)
                        history=remember(history,event(s,a,b,meta,ns is None))
                        belief=model.update(s,belief,b,bool(meta.get('round_end')) and ns is not None)
                        if ns is None: break
                        s=ns
                    belief=belief.forget()
            print('data',split,family,len(rows['y']),flush=True)
        arrays={k:np.asarray(v,dtype=np.int64 if k in ('y','group','family') else np.float64) for k,v in rows.items()}
        np.savez_compressed(directory/f'{split}.npz',**arrays)
        manifest['splits'][split]=dict(observations=len(arrays['y']),profiles=len(np.unique(arrays['group'])))
    (directory/'data.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    return manifest
