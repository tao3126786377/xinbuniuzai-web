import json
import tempfile
import unittest
from pathlib import Path
import research.match_ai
import numpy as np
from scipy.optimize import linprog
from research.match_ai.rules import Config, initial, actions, transition
from research.match_ai.equilibrium import build
from research.match_ai.matrix import DELTA, SAFETY_TOLERANCE
from research.match_ai.phase2.network import Predictor
from research.match_ai.phase2.data import event, remember, features
from research.match_ai.phase3.reliability import Forecast, Evidence
from research.match_ai.phase4.study import (profile, random_stream, advance, matched_histories,
                                          evaluate, history_value, trajectory, safety_check)
from research.match_ai.phase4.endgame import terminal_oracle, terminal_policy


class PhaseFourTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(); cls.path = Path(cls.tmp.name)
        cls.eq = build(cls.path / 'tiny', Config(rounds=1, cap=2, money=10))
        cls.loops = build(cls.path / 'loops', Config(rounds=1, cap=7, money=10))
        Predictor(4).save(cls.path / 'neural.npz'); Predictor(0).save(cls.path / 'linear.npz')
        (cls.path / 'selection.json').write_text(json.dumps(dict(share=.005,
            temperatures={'neural':1.5, 'linear':1.}, static_weights=[.8,.2,0.])))
        cls.forecast = Forecast(cls.path)

    @classmethod
    def tearDownClass(cls):
        for eq in (cls.eq, cls.loops):
            eq._query.cache_clear()
            for arr in eq.values + eq.picks: arr._mmap.close()
        cls.tmp.cleanup()

    def test_matched_histories_replay_and_identical_state(self):
        groups = matched_histories(self.loops, self.forecast)
        self.assertEqual(len(groups), 9)
        for cases in groups:
            current = []
            for expected_s, expected_h, expected_e, path in cases:
                s = initial(self.loops.config); h = (); e = Evidence()
                for a, b in path:
                    s, h, e, _, _ = advance(self.loops, self.forecast, s, h, e, a, b)
                self.assertEqual((s, h, e), (expected_s, expected_h, expected_e))
                self.assertEqual(s, cases[0][0]); self.assertEqual(e.observations, 6)
                current.append(features(s, h, self.loops)[:19])
            np.testing.assert_array_equal(current, np.tile(current[0], (len(cases), 1)))
            self.assertGreater(len({h for _, h, _, _ in cases}), 1)

    def test_reference_matches_independent_terminal_tree_and_lp(self):
        eq = self.eq; player = profile('delayed', 19)
        s, h, e, _, _ = advance(eq, self.forecast, initial(eq.config), (), Evidence(), 1, 1)
        def exact(state, history):
            v, peq, _, q = eq.query(state); ac, ah = actions(state)
            hp = player.probabilities(state, history); scores = np.zeros(len(ac))
            for i, a in enumerate(ac):
                for j, b in enumerate(ah):
                    ns, u, meta = transition(state, a, b, eq.config)
                    nh = remember(history, event(state, a, b, meta, ns is None))
                    scores[i] += hp[j] * (u if ns is None else exact(ns, nh)[0])
            fit = linprog(-scores, A_ub=-q.T, b_ub=np.full(q.shape[1], -v + DELTA),
                          A_eq=np.ones((1, len(ac))), b_eq=[1.], bounds=(0., 1.), method='highs')
            self.assertTrue(fit.success)
            return float(fit.x @ scores), scores
        expected, scores = exact(s, h)
        row = evaluate(eq, self.forecast, player, s, h, e)
        np.testing.assert_allclose(row['references']['3']['scores'], scores, atol=1e-10)
        self.assertAlmostEqual(expected, row['references']['3']['value'], places=9)
        self.assertLessEqual(row['max_local_loss'], DELTA + SAFETY_TOLERANCE)
        self.assertLess(row['references']['3']['unrestricted_root_gap'], 1.01)
        json.dumps(row)

    def test_history_value_distinguishes_information_and_action_ties(self):
        class Toy:
            def query(self, s): return 0., np.ones(2)/2, np.ones(2)/2, np.zeros((2,2))
        state = initial()
        def row(scores):
            return dict(references={'3':dict(scores=scores, value=max(scores))},
                        candidates={k:dict(reference_value=max(scores)) for k in ('neural2','neural3','adaptive3')})
        useful = history_value(Toy(), state, [row([1., 0.]), row([0., 1.])])
        self.assertAlmostEqual(useful['root_history_value'], .5)
        irrelevant = history_value(Toy(), state, [row([1., 1.]), row([.7, .7])])
        self.assertAlmostEqual(irrelevant['root_history_value'], 0.)
        same_preference = history_value(Toy(), state, [row([1., .2]), row([.8, 0.])])
        self.assertAlmostEqual(same_preference['root_history_value'], 0.)

    def test_temporal_negative_and_positive_controls(self):
        cases = matched_histories(self.loops, self.forecast)[-1]
        for family in ('fixed', 'reactive', 'bankroll', 'cycle', 'switch'):
            player = profile(family, 1000000)
            predictions = [player.probabilities(s, h) for s, h, _, _ in cases]
            np.testing.assert_array_equal(predictions, np.tile(predictions[0], (len(cases), 1)))
        player = profile('delayed', 1000000)
        predictions = np.asarray([player.probabilities(s, h) for s, h, _, _ in cases])
        self.assertGreater(np.ptp(predictions, axis=0).max(), .5)

    def test_causal_snapshots_replay_and_frozen_network(self):
        before = [p.copy() for p in self.forecast.neural.params]
        samples, trace = trajectory(self.eq, self.forecast, profile('mimic', 1), random_stream('mimic', 1, 1))
        s = initial(self.eq.config); h = (); e = Evidence()
        for i, item in enumerate(trace):
            if i: self.assertEqual((s, h, e), samples[i - 1])
            s, h, e, _, _ = advance(self.eq, self.forecast, s, h, e, item['computer'], item['human'])
        state, history, evidence = samples[0]
        expected = evaluate(self.eq, self.forecast, profile('mimic', 1), state, history, evidence)
        trace[-1]['human'] = 999  # Future labels cannot change a pre-reveal snapshot.
        actual = evaluate(self.eq, self.forecast, profile('mimic', 1), *samples[0])
        self.assertEqual(expected['candidates'], actual['candidates'])
        for a, b in zip(before, self.forecast.neural.params): np.testing.assert_array_equal(a, b)
        self.assertEqual(evidence.observations, 1)
        self.assertNotEqual(profile('mimic', 1), profile('mimic', 2))

    def test_safety_acceptance_rejects_bad_distribution(self):
        class Toy:
            def query(self, s): return .5, np.ones(2)/2, np.ones(2)/2, np.eye(2)
        with self.assertRaises(ArithmeticError):
            safety_check(Toy(), initial(), np.array([1., 0.]), dict(max_local_loss=0., fallbacks=0))

    def test_exact_endgame_with_full_and_compressed_history(self):
        from research.match_ai.phase2.study import Lookahead
        from research.match_ai.belief import Belief
        eq = self.eq; player = profile('mimic', 19)
        s, h, e, _, _ = advance(eq, self.forecast, initial(eq.config), (), Evidence(), 1, 1)
        oracle = terminal_oracle(eq, player, s, h)
        p, d = Lookahead(eq, 'oracle', player=player, depth=3).decision(s, h, Belief.initial())
        np.testing.assert_allclose(oracle['scores'], d['scores'], atol=1e-10)
        actual = terminal_policy(eq, self.forecast, player, s, h, e, 'oracle', 3)
        self.assertAlmostEqual(actual['score'], oracle['value'], places=10)
        self.assertAlmostEqual(actual['loss'] + actual['draw'] + actual['win'], 1.)
        # A longer legal prefix exercises compression of genuinely older events.
        cases = matched_histories(self.loops, self.forecast)[-1]
        for s, h, e, _ in (cases[0], cases[-1]):
            oracle = terminal_oracle(self.loops, player, s, h)
            p, d = Lookahead(self.loops, 'oracle', player=player, depth=3).decision(s, h, Belief.initial())
            np.testing.assert_allclose(oracle['scores'], d['scores'], atol=1e-10)


if __name__ == '__main__': unittest.main()
