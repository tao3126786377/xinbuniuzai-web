import tempfile
import unittest
from pathlib import Path
import research.match_ai
import numpy as np
from research.match_ai.rules import Config, initial, actions, transition
from research.match_ai.equilibrium import build
from research.match_ai.matrix import DELTA, SAFETY_TOLERANCE
from research.match_ai.belief import Belief
from research.match_ai.phase2.data import event, dense
from research.match_ai.phase2.network import Predictor
from research.match_ai.phase2.study import Lookahead
from research.match_ai.phase5.model import TemporalPredictor, Controller, temporal_features, remember
from research.match_ai.phase5.data import TEST_FAMILIES, profile, rng_for
from research.match_ai.phase5.run import play


class PhaseFiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(); cls.path = Path(cls.tmp.name)
        cls.eq = build(cls.path/'tiny',Config(rounds=2,cap=2,money=10))

    @classmethod
    def tearDownClass(cls):
        cls.eq._query.cache_clear()
        for arr in cls.eq.values+cls.eq.picks: arr._mmap.close()
        cls.tmp.cleanup()

    def test_temporal_network_gradient_mask_and_roundtrip(self):
        model = TemporalPredictor(7); rng = np.random.default_rng(75)
        x = rng.normal(size=(5,203)); mask = np.ones((5,3)); mask[:,0] = 0; y = np.array([1,2,1,2,1])
        _,grad = model.gradients(x,mask,y)
        old = model.params[0][151,2]; eps = 1e-6
        model.params[0][151,2] = old+eps; plus = model.gradients(x,mask,y)[0]
        model.params[0][151,2] = old-eps; minus = model.gradients(x,mask,y)[0]
        model.params[0][151,2] = old
        self.assertAlmostEqual((plus-minus)/(2*eps),grad[0][151,2],places=7)
        p = model.probabilities(x,mask); self.assertTrue(np.all(p[:,0] == 0))
        model.save(self.path/'temporal.npz')
        np.testing.assert_array_equal(p,TemporalPredictor.load(self.path/'temporal.npz').probabilities(x,mask))

    def test_lag_statistics_keep_round_boundaries_and_retain_past_learning(self):
        s = initial(self.eq.config)
        def token(a,b,pick=False):
            return (1.,float(pick),*(float(a==j) for j in range(3)),*(float(b==j) for j in range(3)),0.,0.,0.)
        # A shoot is followed one turn later by human defend, within a round.
        h = (token(0,2),token(1,1))
        x = temporal_features(s,h,self.eq); table = x[107:116].reshape(3,3)
        self.assertAlmostEqual(table[0,1],.5)
        separated = (token(0,2),token(1,1,True),token(1,1))
        np.testing.assert_allclose(temporal_features(s,separated,self.eq)[107:116],np.ones(9)/3)
        # A new round preserves older valid response counts, without creating a cross-round pair.
        longer = h+(token(1,1,True),token(2,0))
        np.testing.assert_allclose(temporal_features(s,longer,self.eq)[107:116],x[107:116])
        original = h; remember(h,token(2,2)); self.assertEqual(h,original)
        self.assertEqual(len(remember(h*40,token(2,2))),64)

    def test_old_controller_matches_existing_planner(self):
        model = Predictor(7); s = initial(self.eq.config)
        ns,_,meta = transition(s,1,1,self.eq.config); h = (event(s,1,1,meta,False),)
        for depth in (2,3):
            p,d = Controller(self.eq,model,depth).decision(ns,h)
            expected,reference = Lookahead(self.eq,'neural',network=model,depth=depth).decision(ns,h,Belief.initial())
            np.testing.assert_allclose(p,expected,atol=1e-12)
            np.testing.assert_allclose(d['scores'],reference['scores'],atol=1e-12)

    def test_cold_start_and_complete_games_preserve_safety_and_weights(self):
        model = TemporalPredictor(7); planner = Controller(self.eq,model,3,True)
        before = [p.copy() for p in model.params]
        p,_ = planner.decision(initial(self.eq.config),())
        np.testing.assert_array_equal(p,self.eq.query(initial(self.eq.config))[1])
        for family in TEST_FAMILIES:
            player = profile('test',family,0)
            u,d = play(self.eq,planner,player,rng_for('test',family,0,1))
            self.assertIn(u,(0.,.5,1.)); self.assertLessEqual(d['max_local_loss'],DELTA+SAFETY_TOLERANCE)
        for a,b in zip(before,model.params): np.testing.assert_array_equal(a,b)
        self.assertNotEqual(profile('train','mimic',0),profile('test','mimic',0))


if __name__ == '__main__': unittest.main()
