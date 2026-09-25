import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
import research.match_ai
import numpy as np
from scipy.optimize import linprog
from research.match_ai.rules import Config, initial, actions, transition, State
from research.match_ai.equilibrium import build
from research.match_ai.belief import Belief
from research.match_ai.matrix import DELTA
from research.match_ai.phase2.data import features,event,remember,INPUTS,WINDOW,profile,FAMILIES,random_stream
from research.match_ai.phase2.network import Predictor,fit
from research.match_ai.phase2.study import Lookahead,oracle_values,paired_bootstrap


class PhaseTwoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory()
        cls.eq=build(Path(cls.tmp.name)/'tiny',Config(rounds=1,cap=2,money=10))

    @classmethod
    def tearDownClass(cls):
        cls.eq._query.cache_clear()
        for arr in cls.eq.values+cls.eq.picks: arr._mmap.close()
        cls.tmp.cleanup()

    def test_network_gradients_and_mask(self):
        rng=np.random.default_rng(12); x=rng.normal(size=(5,INPUTS)); mask=np.ones((5,3)); mask[:,2]=0
        y=np.array([0,1,0,1,1])
        for hidden in (0,4):
            net=Predictor(hidden); loss,grads=net.gradients(x,mask,y)
            p=net.probabilities(x,mask)
            np.testing.assert_array_equal(p[:,2],0); np.testing.assert_allclose(p.sum(axis=1),1)
            for param,grad in zip(net.params,grads):
                for flat in (0,param.size//2,param.size-1):
                    old=param.flat[flat]; eps=1e-5
                    param.flat[flat]=old+eps; plus=net.gradients(x,mask,y)[0]
                    param.flat[flat]=old-eps; minus=net.gradients(x,mask,y)[0]
                    param.flat[flat]=old
                    self.assertAlmostEqual(grad.flat[flat],(plus-minus)/(2*eps),places=6)

    def test_training_can_learn_nonlinear_fixture_and_save(self):
        x=np.zeros((128,INPUTS)); x[:,:2]=np.tile([[0,0],[0,1],[1,0],[1,1]],(32,1))
        data=dict(x=x,y=np.tile([0,1,1,0],32),mask=np.tile([1,1,0],(128,1)),group=np.arange(128))
        net=Predictor(16); result=fit(net,data,data,epochs=80,batch=32,learning_rate=.02)
        self.assertLess(result['validation_nll'],.1)
        path=Path(self.tmp.name)/'network.npz'; net.save(path)
        np.testing.assert_array_equal(net.probabilities(x,data['mask']),Predictor.load(path).probabilities(x,data['mask']))

    def test_public_history_causality_and_boundaries(self):
        s=initial(self.eq.config); before=features(s,(),self.eq)
        self.assertEqual(len(before),INPUTS)
        ns,_,meta=transition(s,0,2,self.eq.config)
        history=remember((),event(s,0,2,meta,False))
        np.testing.assert_array_equal(features(s,(),self.eq),before)
        self.assertFalse(np.array_equal(features(ns,history,self.eq),features(ns,(),self.eq)))
        for _ in range(20): history=remember(history,event(ns,1,1,{'round_end':True,'winner':0},True))
        self.assertEqual(len(history),WINDOW)
        self.assertEqual(history[-1][8:10],(1.,1.))
        self.assertEqual(features(initial(self.eq.config),history,self.eq)[19+9],1.)

    def test_profile_splits_and_legal_predictions(self):
        draws=[random_stream(split,'fixed',i).random() for split in ('train','validation','test','games') for i in range(32)]
        self.assertEqual(len(set(draws)),len(draws))
        for family in FAMILIES:
            player=profile('test',family,1)
            for s in (initial(),State('play',1,1,50,50,0,0,0,0)):
                p=player.probabilities(s,()); self.assertEqual(len(p),len(actions(s)[1]))
                self.assertGreaterEqual(min(p),0); self.assertAlmostEqual(p.sum(),1)

    def test_predictor_swap_preserves_safety_and_no_data(self):
        s=initial(self.eq.config); net=Predictor(4); player=profile('test','reactive',1)
        for kind in ('bayes','linear','neural','oracle'):
            planner=Lookahead(self.eq,kind,net,player)
            p,_=planner.decision(s,(),Belief.initial())
            np.testing.assert_array_equal(p,self.eq.query(s)[1])
            ns,_,meta=transition(s,1,1,self.eq.config)
            h=remember((),event(s,1,1,meta,False)); b=planner.model.update(s,Belief.initial(),1)
            snapshot=[x.copy() for x in net.params]
            p,d=planner.decision(ns,h,b); v,_,_,q=self.eq.query(ns)
            self.assertGreaterEqual(min(p@q),v-DELTA-1e-11)
            self.assertGreater(d['nodes'],1)
            self.assertEqual(b.observations,1); self.assertEqual(len(h),1)
            for a,z in zip(snapshot,net.params): np.testing.assert_array_equal(a,z)
            if kind!='oracle':
                with patch.object(type(player),'probabilities',side_effect=AssertionError('oracle information leak')):
                    planner.decision(ns,h,b)

    def test_exact_oracle_against_independent_lp_and_best_response(self):
        from functools import lru_cache
        from research.match_ai.experiments import opponent_policy
        @lru_cache(None)
        def reference(s):
            v,p,_,q=self.eq.query(s); ac,ah=actions(s); hp=opponent_policy('reactive',s,self.eq,p)
            scores=np.zeros(len(ac))
            for i,a in enumerate(ac):
                for j,b in enumerate(ah):
                    ns,u,_=transition(s,a,b,self.eq.config)
                    scores[i]+=hp[j]*(u if ns is None else reference(ns))
            result=linprog(-scores,A_ub=-q.T,b_ub=np.full(len(ah),-v+DELTA),
                           A_eq=np.ones((1,len(ac))),b_eq=[1],bounds=(0,None),method='highs')
            self.assertTrue(result.success)
            return -result.fun
        result=oracle_values(self.eq,'reactive',True)
        self.assertAlmostEqual(result['safe_oracle'],reference(initial(self.eq.config)),places=7)
        self.assertGreaterEqual(result['safe_oracle'],result['equilibrium']-1e-10)
        self.assertGreaterEqual(result['unconstrained_diagnostic'],result['safe_oracle']-1e-10)

    def test_profile_bootstrap_is_reproducible(self):
        x=[.1,.2,-.2,.4]
        self.assertEqual(paired_bootstrap(x),paired_bootstrap(x))


if __name__=='__main__': unittest.main()
