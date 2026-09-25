import io
import json
import tempfile
import unittest
from pathlib import Path
import research.match_ai
import numpy as np
from research.match_ai.rules import Config,initial,actions,transition,State
from research.match_ai.equilibrium import build
from research.match_ai.matrix import DELTA
from research.match_ai.phase2.network import Predictor
from research.match_ai.phase2.data import remember,event
from research.match_ai.phase3.data import FAMILIES,DEVELOPMENT,profile,random_stream
from research.match_ai.phase3.reliability import Evidence,Forecast,calibrate,replay,select
from research.match_ai.phase3.study import ReliabilityPlanner,play,decision_probe


class PhaseThreeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory(); cls.path=Path(cls.tmp.name)
        cls.eq=build(cls.path/'tiny',Config(rounds=1,cap=2,money=10))
        Predictor(4).save(cls.path/'neural.npz'); Predictor(0).save(cls.path/'linear.npz')
        (cls.path/'selection.json').write_text(json.dumps(dict(share=.05,temperatures={'neural':1.5,'linear':1.},static_weights=[.5,.4,.1])))
        cls.forecast=Forecast(cls.path)

    @classmethod
    def tearDownClass(cls):
        cls.eq._query.cache_clear()
        for arr in cls.eq.values+cls.eq.picks: arr._mmap.close()
        cls.tmp.cleanup()

    def test_evidence_update_and_recovery(self):
        p=np.array([[.99,.005,.005],[.005,.99,.005],[1/3,1/3,1/3]])
        e=Evidence(); updated=e.update(p,0,.05,1)
        np.testing.assert_allclose(updated.weights,.95*p[:,0]/p[:,0].sum()+.05/3)
        self.assertEqual(e.observations,0)
        with self.assertRaises(ValueError): updated.update(p,0,.05,1)
        slow=fast=Evidence()
        for i in range(50):
            slow=slow.update(p,0,0.,i+1); fast=fast.update(p,0,.05,i+1)
        for i in range(6):
            slow=slow.update(p,1,0.,51+i); fast=fast.update(p,1,.05,51+i)
        self.assertGreater(fast.weights[1],.5); self.assertLess(slow.weights[1],.5)
        self.assertTrue(np.all(np.isfinite(slow.log_weights)))

    def test_zero_share_logloss_bound(self):
        rng=np.random.default_rng(4); e=Evidence(); total=0.; per_expert=np.zeros(3)
        for i in range(500):
            experts=rng.dirichlet([.2,.5,.7],size=3); y=int(rng.integers(3))
            total-=np.log((e.weights@experts)[y]); per_expert-=np.log(experts[:,y])
            e=e.update(experts,y,0.,i+1)
        self.assertLessEqual(total,min(per_expert)+np.log(3)+1e-9)

    def test_calibration_masks_and_replay_causality(self):
        p=np.array([[.9,.1,0],[0,.2,.8]])
        np.testing.assert_allclose(calibrate(p,1),p)
        softened=calibrate(p,2); self.assertEqual(softened[0,2],0); self.assertLess(softened[0,0],.9)
        experts=np.tile(np.array([[.8,.1,.1],[.1,.8,.1],[1/3]*3]),(8,1,1))
        y=np.array([0,0,1,0,1,1,0,1]); groups=np.array([1]*6+[2]*2)
        pred,weights=replay(experts,y,groups,.05)
        changed=y.copy(); changed[3:]=2
        other,_=replay(experts,changed,groups,.05)
        np.testing.assert_array_equal(pred[:4],other[:4])
        np.testing.assert_allclose(weights[6],np.ones(3)/3)

    def test_prediction_parameters_and_branch_evidence_are_immutable(self):
        s=initial(self.eq.config); ns,_,meta=transition(s,1,1,self.eq.config)
        history=remember((),event(s,1,1,meta,False)); evidence=Evidence(observations=1)
        snapshot=[x.copy() for x in self.forecast.neural.params]
        for kind in ('neural','calibrated','static','adaptive','frozen'):
            planner=ReliabilityPlanner(self.eq,self.forecast,kind)
            p,_=planner.decision(s,(),Evidence()); np.testing.assert_array_equal(p,self.eq.query(s)[1])
            p,d=planner.decision(ns,history,evidence); v,_,_,q=self.eq.query(ns)
            self.assertGreaterEqual(min(p@q),v-DELTA-1e-11); self.assertGreater(d['nodes'],1)
            self.assertEqual(evidence.observations,1); self.assertEqual(len(history),1)
        for a,b in zip(snapshot,self.forecast.neural.params): np.testing.assert_array_equal(a,b)

    def test_adaptive_full_best_response_and_observation_count(self):
        planner=ReliabilityPlanner(self.eq,self.forecast,'adaptive')
        def worst(s,h,e):
            p,d=planner.decision(s,h,e); ac,ah=actions(s); outcomes=[]
            for b in ah:
                ne=e.update(d['experts'],b,self.forecast.selection['share'],e.observations+1); total=0.
                for i,a in enumerate(ac):
                    if p[i]==0: continue
                    ns,u,meta=transition(s,a,b,self.eq.config)
                    total+=p[i]*(u if ns is None else worst(ns,remember(h,event(s,a,b,meta,False)),ne))
                outcomes.append(total)
            return min(outcomes)
        s=initial(self.eq.config)
        self.assertGreaterEqual(worst(s,(),Evidence()),self.eq.value(s)-self.eq.config.horizon*DELTA-1e-9)
        for kind in ('adaptive','frozen'):
            planner=ReliabilityPlanner(self.eq,self.forecast,kind); trace=io.StringIO()
            _,stats=play(self.eq,planner,profile('games','changing',1),random_stream('games','changing',1,1),trace)
            events=[json.loads(line) for line in trace.getvalue().splitlines()]
            self.assertEqual([e['event_id'] for e in events],list(range(1,stats['decisions']+1)))
            np.testing.assert_allclose(events[1]['weights_before'],events[0]['weights_after'])

    def test_selection_uses_validation_only(self):
        path=self.path/'selection_test'; path.mkdir(exist_ok=True)
        y=np.array([0,1,0,1,0,1]); groups=np.repeat([1,2,3],2)
        np.savez(path/'validation.npz',y=y,group=groups,mask=np.ones((6,3)),
                 neural=np.tile([.7,.2,.1],(6,1)),linear=np.tile([.3,.6,.1],(6,1)))
        result=select(path)  # No test file exists; it must never be requested.
        self.assertAlmostEqual(sum(result['static_weights']),1.)
        self.assertGreaterEqual(min(result['static_weights']),0)

    def test_new_profiles_and_seed_spaces(self):
        self.assertFalse(set(FAMILIES[-2:])&set(DEVELOPMENT))
        draws=[random_stream(split,'fixed',i).random() for split in ('validation','test','games') for i in range(10)]
        self.assertEqual(len(draws),len(set(draws)))
        for family in FAMILIES:
            p=profile('test',family,2).probabilities(State('play',1,3,50,50,0,0,0,0),())
            self.assertEqual(len(p),2); self.assertAlmostEqual(sum(p),1.)

    def test_matched_state_probe_serializes_complete_causal_traces(self):
        planner=ReliabilityPlanner(self.eq,self.forecast,'neural')
        for family in FAMILIES:
            trace=io.StringIO()
            play(self.eq,planner,profile('games',family,0),random_stream('games',family,0,1),trace)
            (self.path/f'{family}_example.jsonl').write_text(trace.getvalue(),encoding='utf-8')
        result=decision_probe(self.eq,self.path)
        loaded=json.loads((self.path/'decisions.json').read_text(encoding='utf-8'))
        self.assertEqual(loaded['states'],result['states'])
        self.assertGreaterEqual(result['states'],len(FAMILIES))
        self.assertEqual({row['family'] for row in result['rows']},set(FAMILIES))
        self.assertTrue(all(cost>=0 for row in result['rows'] for cost in row['opportunity_cost'].values()))


if __name__=='__main__': unittest.main()
