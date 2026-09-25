"""Small behavior network with public lag statistics; rules stay exact."""
import numpy as np
from ..rules import actions, transition
from ..matrix import safe_distribution, DELTA, SAFETY_TOLERANCE
from ..phase2.data import features, dense, event
from ..phase2.network import Predictor

WINDOW = 64
INPUTS = 203  # original 107 + 8 conditional 3x3 tables and their row counts


def remember(history, token):
    return (history + (token,))[-WINDOW:]


def temporal_features(s, history, eq):
    x = np.zeros(INPUTS); x[:107] = features(s, history[-8:], eq)
    if not history: return x
    z = np.asarray(history); segment = np.cumsum(z[:,1]); offset = 107
    for lag in range(1, 5):
        valid = (segment[:-lag] == segment[lag:]) & (z[:-lag,1] == 0) & (z[lag:,1] == 0)
        for source in (2, 5):  # human response to earlier computer / human action
            counts = z[:-lag,source:source+3].T @ (z[lag:,5:8] * valid[:,None])
            totals = counts.sum(axis=1)
            x[offset:offset+9] = ((counts+1)/(totals[:,None]+3)).ravel()
            x[offset+9:offset+12] = totals/(totals+3)
            offset += 12
    return x


class TemporalPredictor(Predictor):
    def __init__(self, hidden=96, seed=20260925):
        super().__init__(hidden, seed)
        self.params[0] = np.random.default_rng(seed).normal(0, 1/np.sqrt(INPUTS), (INPUTS,hidden))


class Controller:
    """Identical safety-constrained lookahead, with a replaceable behavior model."""
    def __init__(self, eq, model, depth=2, temporal=False):
        if not eq.manifest['certified'] or eq.manifest['accumulated_error_bound']+505*(DELTA+SAFETY_TOLERANCE) > .02:
            raise ValueError('Uncertified baseline')
        self.eq, self.model, self.depth, self.temporal = eq, model, depth, temporal

    def prediction(self, s, h):
        legal = actions(s)[1]
        x = temporal_features(s,h,self.eq) if self.temporal else features(s,h[-8:],self.eq)
        return self.model.probabilities(x, dense(np.ones(len(legal)),legal))[list(legal)]

    def decision(self, s, history):
        import time
        start = time.perf_counter(); nodes = 0; maximum = 0.; fallbacks = 0
        def visit(state, h, depth):
            nonlocal nodes, maximum, fallbacks
            nodes += 1; v, peq, _, qeq = self.eq.query(state)
            ac, ah = actions(state); hp = self.prediction(state,h); scores = np.zeros(len(ac))
            for i,a in enumerate(ac):
                for j,b in enumerate(ah):
                    ns,u,meta = transition(state,a,b,self.eq.config)
                    if ns is None: value = u
                    elif depth == 1: value = self.eq.value(ns)
                    else: value = visit(ns,remember(h,event(state,a,b,meta,False)),depth-1)[0]
                    scores[i] += hp[j]*value
            p,d = safe_distribution(scores,qeq,v,peq,temperature=0.)
            maximum = max(maximum,d['local_loss']); fallbacks += int(d['fallback'])
            return float(p@scores),p,scores
        if not history:
            v,p,_,q = self.eq.query(s); scores = q@self.prediction(s,history)
        else: _,p,scores = visit(s,history,self.depth)
        return p,dict(scores=scores.tolist(),nodes=nodes,max_local_loss=maximum,
                      fallbacks=fallbacks,seconds=time.perf_counter()-start)
