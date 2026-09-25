"""Small deterministic port fixtures from the selected Python controller."""
import json
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import research.match_ai
import numpy as np
from research.match_ai.rules import Config,State,initial,actions,transition
from research.match_ai.equilibrium import Equilibrium
from research.match_ai.matrix import solve_game,safe_distribution
from research.match_ai.phase2.data import event
from research.match_ai.phase5.data import TEST_FAMILIES,profile,rng_for
from research.match_ai.phase5.model import temporal_features,remember
from research.match_ai.phase5.run import controller


def main():
    eq = Equilibrium(ROOT/'research/artifacts/full')
    agent = controller(eq,ROOT/'research/match_ai/phase5/results','temporal3')
    fixtures = dict(states=[],matrices=[],transitions=[]); rng = np.random.default_rng(60723)
    def save(s,h):
        p,d = agent.decision(s,h); v,pc,ph,q = eq.query(s)
        fixtures['states'].append(dict(state=s.to_dict(),history=h,features=temporal_features(s,h,eq).tolist(),
            prediction=agent.prediction(s,h).tolist(),value=v,computer=pc.tolist(),human=ph.tolist(),matrix=q.tolist(),
            probabilities=p.tolist(),scores=d['scores']))
    save(initial(),())
    for family in TEST_FAMILIES:
        s = initial(); h = (); player = profile('test',family,73); rg = rng_for('test',family,73,17); samples = []
        while True:
            samples.append((s,h)); ac,ah = actions(s); hp = player.probabilities(s,h)
            a = ac[int(rg.choice(len(ac),p=eq.query(s)[1]))]; b = ah[int(rg.choice(len(ah),p=hp))]
            ns,u,meta = transition(s,a,b); h = remember(h,event(s,a,b,meta,ns is None))
            if ns is None: break
            s = ns
        for i in np.unique(np.linspace(0,len(samples)-1,8,dtype=int)): save(*samples[i])
    for n in (1,2,3):
        for m in (1,2,3):
            for i in range(30):
                q = rng.random((n,m)) if i%3 else rng.integers(0,3,(n,m))/2
                v,p,h,gap = solve_game(q); scores = rng.random(n); chosen,d = safe_distribution(scores,q,v,p,temperature=0.)
                fixtures['matrices'].append(dict(matrix=q.tolist(),value=v,scores=scores.tolist(),optimum=float(chosen@scores)))
    for bc in range(11):
        for bh in range(11):
            for pc,ph,rd,turn,mc,mh in ((0,0,1,1,50,50),(1,2,3,100,50,20),(2,2,5,100,10,10),(2,1,2,99,1,99)):
                s = State('play',rd,turn,mc,mh,pc,ph,bc,bh)
                for a in actions(s)[0]:
                    for b in actions(s)[1]:
                        ns,u,meta = transition(s,a,b)
                        fixtures['transitions'].append(dict(state=s.to_dict(),computer=a,human=b,
                            expected=dict(state=ns.to_dict() if ns else None,score=u,settlement=meta)))
    for a in range(3):
        for b in range(3):
            s=initial(); ns,u,meta=transition(s,a,b)
            fixtures['transitions'].append(dict(state=s.to_dict(),computer=a,human=b,
                expected=dict(state=ns.to_dict(),score=u,settlement=meta)))
    output=ROOT/'research/artifacts/runtime-reference.json'
    output.write_text(json.dumps(fixtures),encoding='utf-8')
    print('Generated',len(fixtures['states']),'policy states,',len(fixtures['matrices']),'matrices,',len(fixtures['transitions']),'transitions')


if __name__ == '__main__': main()
