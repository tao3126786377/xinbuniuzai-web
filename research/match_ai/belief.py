"""Finite, auditable Bayesian opponent model (729 hypotheses)."""
from dataclasses import dataclass
from functools import lru_cache
import itertools
import numpy as np
from .rules import SHOOT, DEFEND, RELOAD, actions

PARAMETERS = np.array(list(itertools.product((-2.,0.,2.), repeat=6)))
PRIOR = np.prod(np.where(PARAMETERS == 0, .8, .1), axis=1)
PRIOR /= PRIOR.sum()
PRIOR.flags.writeable = False


@dataclass(frozen=True)
class Belief:
    weights: np.ndarray
    observations: int = 0

    @classmethod
    def initial(cls):
        return cls(PRIOR.copy())

    def forget(self):
        return Belief(.95*self.weights + .05*PRIOR, self.observations)

    def observe(self, likelihood, event_id):
        if event_id != self.observations + 1:
            raise ValueError('Observation must be applied exactly once, in order')
        w = self.weights * likelihood
        if not np.isfinite(w.sum()) or w.sum() <= 0:
            raise ValueError('Invalid likelihood')
        return Belief(w / w.sum(), event_id)


class OpponentModel:
    def __init__(self, equilibrium):
        self.eq = equilibrium

    @lru_cache(maxsize=4096)
    def probabilities(self, s):
        _, _, eqh, _ = self.eq.query(s)
        ah = actions(s)[1]
        base = .98*eqh + .02/len(ah)
        feature = np.zeros((6,len(ah)))
        deficit = (s.mc-s.mh) / (s.mc+s.mh)
        for j,b in enumerate(ah):
            if s.phase == 'pick':
                feature[3,j] = deficit*b
                feature[4,j] = s.last_result*b
                feature[5,j] = b
            else:
                feature[0,j] = b == SHOOT
                feature[1,j] = b == RELOAD
                feature[2,j] = b == DEFEND and s.previous[0] == SHOOT
                feature[3,j] = deficit*(b != DEFEND)
                feature[4,j] = s.last_result*(b != DEFEND)
        logits = PARAMETERS @ feature + np.log(base)
        logits -= np.max(logits,axis=1,keepdims=True)
        probs = np.exp(logits)
        probs /= probs.sum(axis=1,keepdims=True)
        probs.flags.writeable = False
        return probs

    def prediction(self, s, belief):
        return belief.weights @ self.probabilities(s)

    def update(self, s, belief, ah, round_end=False, event_id=None):
        index = actions(s)[1].index(ah)
        updated = belief.observe(self.probabilities(s)[:,index],
                                 belief.observations+1 if event_id is None else event_id)
        return updated.forget() if round_end else updated
