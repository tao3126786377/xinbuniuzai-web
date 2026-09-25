import json
import subprocess
import tempfile
import unittest
from dataclasses import replace
from functools import lru_cache
from pathlib import Path
from unittest.mock import patch
import research.match_ai  # activate optional project-local dependencies first
import numpy as np
from scipy.optimize import minimize
from research.match_ai.rules import *
from research.match_ai.matrix import *
from research.match_ai.equilibrium import build, BULLETS
from research.match_ai.belief import Belief, OpponentModel, PRIOR, PARAMETERS
from research.match_ai.planner import Planner, exact_belief_value


class ResearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory()
        cls.eq=build(Path(cls.tmp.name)/'tiny',Config(rounds=1,cap=2,money=10))
        cls.two=build(Path(cls.tmp.name)/'two',Config(rounds=2,cap=2,money=10))

    @classmethod
    def tearDownClass(cls):
        # Release mmap handles before Windows removes temporary directories.
        for eq in (cls.eq,cls.two):
            eq._query.cache_clear()
            for arr in eq.values+eq.picks:
                arr._mmap.close()
        cls.tmp.cleanup()

    def test_js_rules_exhaustive(self):
        cases=[]
        for bc,bh in BULLETS:
            for a in feasible(bc):
                for b in feasible(bh):
                    for pc in range(3):
                        for ph in range(3):
                            for round,turn,mc,mh in ((1,1,50,50),(5,100,50,50),(2,100,5,5)):
                                cases.append(dict(bc=bc,bh=bh,a=a,b=b,pc=pc,ph=ph,
                                                  round=round,turn=turn,mc=mc,mh=mh))
        bridge=Path(__file__).with_name('js_reference.js')
        result=subprocess.run(['node',str(bridge)],input=json.dumps(cases),text=True,
                              capture_output=True,check=True)
        refs=json.loads(result.stdout)
        for c,r in zip(cases,refs):
            s=State('play',c['round'],c['turn'],c['mc'],c['mh'],c['pc'],c['ph'],c['bc'],c['bh'])
            ns,u,m=transition(s,c['a'],c['b'])
            if r['win']==-1:
                self.assertEqual((ns.bc,ns.bh),(r['bc'],r['bh']))
            else:
                self.assertEqual(m['winner'],r['win'])
                self.assertEqual(m['final_bullets'],r['final'])
                self.assertEqual(m['money'],r['money'])
                self.assertEqual(m['transfer'],r['transfer'])
                self.assertEqual(ns is None,r['over'])
                if ns is None: self.assertEqual(u,r['score'])
        print('JS rule comparisons:',len(cases))

    def test_small_matrix_lp(self):
        rng=np.random.default_rng(1001)
        worst=0.
        for n in (1,2,3):
            for m in (1,2,3):
                for k in range(80):
                    a=rng.random((n,m)) if k%3 else rng.integers(0,3,(n,m))/2
                    v,p,q,gap=solve_game(a)
                    lv,_=lp_game(a)
                    worst=max(worst,abs(v-lv),gap)
                    self.assertLess(abs(v-lv),1e-8)
                    self.assertLess(gap,1e-8)
                    self.assertGreaterEqual(min(p),0)
                    self.assertGreaterEqual(min(q),0)
        print('Matrix LP comparisons: 720; maximum error',worst)

    def test_backward_induction_independent_lp(self):
        @lru_cache(None)
        def reference(s):
            ac,ah=actions(s)
            q=np.zeros((len(ac),len(ah)))
            for i,a in enumerate(ac):
                for j,b in enumerate(ah):
                    ns,u,_=transition(s,a,b,self.two.config)
                    q[i,j]=u if ns is None else reference(ns)
            val,_=lp_game(q)
            self.assertAlmostEqual(val,self.two.value(s),places=8)
            return val
        self.assertAlmostEqual(reference(initial(self.two.config)),.5,places=8)
        self.assertTrue(self.two.manifest['certified'])

    def test_entropy_and_safety(self):
        rng=np.random.default_rng(42)
        for _ in range(40):
            q=rng.random((3,3)); v,p,_,_=solve_game(q); scores=rng.random(3)
            chosen,d=safe_distribution(scores,q,v,p,.01)
            self.assertGreaterEqual(min(chosen@q),v-DELTA-1e-10)
            self.assertAlmostEqual(chosen.sum(),1.)
            # Independent general constrained optimizer checks polygon/edge search.
            opt=minimize(lambda x: -x@scores-.01*entropy(x),p,method='SLSQP',
                         bounds=[(0,1)]*3,constraints=[
                             dict(type='eq',fun=lambda x:x.sum()-1),
                             dict(type='ineq',fun=lambda x:x@q-v+DELTA)],
                         options={'ftol':1e-12,'maxiter':200})
            if opt.success:
                self.assertGreaterEqual(chosen@scores+.01*entropy(chosen),-opt.fun-1e-7)
        q=np.full((3,3),.5); p=np.ones(3)/3
        chosen,_=safe_distribution(np.array([.1,.2,.3]),q,.5,p,.1)
        self.assertTrue(chosen[2]>chosen[1]>chosen[0])
        fallback,d=safe_distribution(np.array([np.nan,0,0]),q,.5,p)
        np.testing.assert_array_equal(fallback,p); self.assertTrue(d['fallback'])

    def test_belief_boundaries_and_no_leak(self):
        m=OpponentModel(self.two); s=initial(self.two.config); b=Belief.initial()
        self.assertEqual(len(PARAMETERS),729)
        probs=m.probabilities(s)
        np.testing.assert_allclose(probs.sum(axis=1),1)
        b1=m.update(s,b,2,event_id=1)
        np.testing.assert_allclose(b1.weights,PRIOR*probs[:,2]/(PRIOR@probs[:,2]))
        with self.assertRaises(ValueError): b1.observe(probs[:,2],1)
        self.assertEqual(b.observations,0)
        # Only the public human action updates likelihood, not the computer action.
        ns,_,_=transition(s,0,2,self.two.config)
        n2,_,_=transition(s,2,2,self.two.config)
        np.testing.assert_array_equal(m.update(s,b,2).weights,b1.weights)
        self.assertNotEqual(ns.bc,n2.bc)
        ns=replace(ns,turn=2,ph=1,bh=1,previous=(SHOOT,RELOAD))
        after,_,meta=transition(ns,DEFEND,DEFEND,self.two.config)
        self.assertEqual(after.previous,(-1,-1))
        updated=m.update(ns,b1,DEFEND,True)
        direct=m.update(ns,b1,DEFEND)
        np.testing.assert_allclose(updated.weights,.95*direct.weights+.05*PRIOR)
        self.assertEqual(updated.observations,2)

    def test_planner_safety_and_no_data(self):
        s=initial(self.eq.config); b=Belief.initial(); p=Planner(self.eq)
        d=p.decision(s,b,seed=6)
        np.testing.assert_array_equal(d.probabilities,self.eq.query(s)[1])
        self.assertEqual(d.diagnostics['simulations'],0)
        b=Belief(PRIOR.copy(),1)
        d1=p.decision(s,b,simulations=64,seed=9)
        d2=p.decision(s,b,simulations=64,seed=9)
        np.testing.assert_array_equal(d1.probabilities,d2.probabilities)
        v,_,_,q=self.eq.query(s)
        self.assertGreaterEqual(min(d1.probabilities@q),v-DELTA-1e-10)
        self.assertEqual(b.observations,1)
        certified=self.eq.manifest['certified']
        self.eq.manifest['certified']=False
        try:
            with self.assertRaises(ValueError): Planner(self.eq)
        finally:
            self.eq.manifest['certified']=certified
        error=self.eq.manifest['accumulated_error_bound']
        self.eq.manifest['accumulated_error_bound']=.0001
        try:
            with self.assertRaises(ValueError): Planner(self.eq)
        finally:
            self.eq.manifest['accumulated_error_bound']=error

    def test_exact_tree_reference(self):
        s=State('play',1,2,10,10,1,1,1,1)
        b=Belief(PRIOR.copy(),1)
        exact=exact_belief_value(self.eq,s,b)
        p=Planner(self.eq,temperature=0)
        pred=p.model.prediction(s,b)
        ac,ah=actions(s); scores=np.zeros(len(ac))
        for i,a in enumerate(ac):
            for j,h in enumerate(ah):
                _,u,_=transition(s,a,h,self.eq.config)
                scores[i]+=pred[j]*u
        np.testing.assert_allclose(exact['scores'],scores)
        d=p.decision(s,b,simulations=4096,seed=18)
        self.assertLess(abs(float(d.probabilities@scores)-exact['value']),.02)

    def test_information_value_fixture(self):
        # Exercise the real exact planner on an analytically solvable two-type
        # diagnostic game, retaining the same tight safety floor.
        class Fixture:
            config=Config(rounds=1,cap=1)
            def query(self,s):
                q=np.array([[.5,.5]]) if s=='observe' else np.eye(2)
                return .5,np.ones(q.shape[0])/q.shape[0],np.ones(2)/2,q
        def fixture_actions(s):
            return ((0,) if s=='observe' else (0,1)),(0,1)
        def fixture_transition(s,a,b,config):
            return ('guess',None,{}) if s=='observe' else (None,float(a==b),{})
        b=Belief(np.array([.5,.5]),1)
        for informative in (True,False):
            def probabilities(model,s):
                return np.eye(2) if s=='guess' or informative else np.full((2,2),.5)
            with patch('research.match_ai.planner.actions',fixture_actions), \
                 patch('research.match_ai.belief.actions',fixture_actions), \
                 patch('research.match_ai.planner.transition',fixture_transition), \
                 patch.object(OpponentModel,'probabilities',probabilities):
                learned=exact_belief_value(Fixture(),'observe',b)['value']
                frozen=exact_belief_value(Fixture(),'observe',b,kind='frozen')['value']
            self.assertAlmostEqual(frozen,.5)
            self.assertAlmostEqual(learned,.5+DELTA if informative else .5)

    def test_compiled_tail_matches_exact_predictive_tree(self):
        model=OpponentModel(self.two)
        s=State('play',1,2,10,10,1,1,1,1)
        belief=model.update(s,Belief.initial(),2)
        for adaptive in (False,True):
            def expected(s,b):
                p=self.two.query(s)[1]; ac,ah=actions(s); prediction=model.prediction(s,b)
                value=0.
                for i,a in enumerate(ac):
                    if p[i]==0: continue
                    for j,h in enumerate(ah):
                        ns,u,meta=transition(s,a,h,self.two.config)
                        nb=model.update(s,b,h,bool(meta.get('round_end'))) if adaptive else b
                        value+=p[i]*prediction[j]*(u if ns is None else expected(ns,nb))
                return value
            reference=expected(s,belief)
            rollout=Planner(self.two).rollout
            samples=[rollout.run(s,belief,adaptive,i+20000) for i in range(10000)]
            self.assertLess(abs(np.mean(samples)-reference),.015)

    def test_safety_budget_against_full_best_response(self):
        @lru_cache(None)
        def worst(s):
            v,p,_,q=self.two.query(s)
            prediction=np.arange(1,q.shape[1]+1,dtype=float); prediction/=prediction.sum()
            p,_=safe_distribution(q@prediction,q,v,p,0.)
            ac,ah=actions(s); outcomes=[]
            for b in ah:
                value=0.
                for i,a in enumerate(ac):
                    if p[i]==0: continue
                    ns,u,_=transition(s,a,b,self.two.config)
                    value+=p[i]*(u if ns is None else worst(ns))
                outcomes.append(value)
            return min(outcomes)
        s=initial(self.two.config)
        self.assertGreaterEqual(worst(s),self.two.value(s)-self.two.config.horizon*DELTA-1e-9)

    def test_trial_seeds_and_intervals(self):
        from research.match_ai.experiments import trial_seed,interval
        seeds=[trial_seed(split,op,trial) for split in ('train','validation','test')
               for op in range(8) for trial in range(128)]
        self.assertEqual(len(seeds),len(set(seeds)))
        self.assertLess(interval([1.]*128,bounds=(0,1))[0],1.)


if __name__=='__main__': unittest.main(verbosity=2)
