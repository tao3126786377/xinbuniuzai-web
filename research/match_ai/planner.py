"""Safe entropy policy, finite belief-tree reference, and Bayesian tree search.

Search is an approximation, not a certificate of Bayes optimality. The local
safety constraint is independently checked against the exact physical baseline.
"""
from dataclasses import dataclass
import time
import numpy as np
from .rules import actions, transition
from .belief import OpponentModel
from .matrix import safe_distribution, safe_vertices, DELTA, SAFETY_TOLERANCE
from .rollout import Rollout


@dataclass
class Decision:
    actions: tuple
    probabilities: np.ndarray
    scores: np.ndarray
    diagnostics: dict

    def sample(self, rng):
        return self.actions[int(rng.choice(len(self.actions),p=self.probabilities))]

    def to_dict(self):
        return dict(actions=self.actions, probabilities=self.probabilities.tolist(),
                    scores=self.scores.tolist(), diagnostics=self.diagnostics)


class Node:
    def __init__(self, s, belief, planner):
        self.state, self.belief = s, belief
        self.value,self.eqc,_,self.qeq = planner.eq.query(s)
        self.ac,self.ah = actions(s)
        self.prediction = planner.model.prediction(s,belief)
        self.vertices = safe_vertices(self.qeq,self.value)
        self.counts = np.zeros(len(self.ac),dtype=int)
        self.sums = np.zeros(len(self.ac))
        self.initial = self.qeq @ self.prediction
        self.policy = self.eqc.copy()
        self.children = {}
        self.visits = 0

    def scores(self):
        return np.divide(self.sums,self.counts,out=self.initial.copy(),where=self.counts>0)


class Planner:
    def __init__(self, equilibrium, kind='belief', temperature=.005):
        if kind not in ('equilibrium','frozen','belief'):
            raise ValueError(kind)
        if not equilibrium.manifest['certified']:
            raise ValueError('Uncertified equilibrium: safety guarantee unavailable')
        if equilibrium.manifest['accumulated_error_bound'] + 505*(DELTA+SAFETY_TOLERANCE) > .02:
            raise ValueError('Baseline error and probability tolerance exceed the match safety budget')
        self.eq,self.kind,self.temperature = equilibrium,kind,temperature
        self.model = OpponentModel(equilibrium)
        if not hasattr(equilibrium, '_rollout'):
            equilibrium._rollout = Rollout(equilibrium)
        self.rollout = equilibrium._rollout

    def decision(self, s, belief, simulations=32, seconds=None, seed=0):
        start = time.perf_counter()
        v,p,q,a = self.eq.query(s)
        if self.kind == 'equilibrium' or belief.observations == 0:
            return Decision(actions(s)[0],p.copy(),a @ self.model.prediction(s,belief),
                            dict(simulations=0,seconds=time.perf_counter()-start,
                                 reason='equilibrium' if self.kind=='equilibrium' else 'no_observations',
                                 local_loss=float(v-min(p @ a)),fallback=False))
        root = Node(s,belief,self)
        rng = np.random.default_rng(seed)
        deadline = float('inf') if seconds is None else start+seconds
        iterations = 0
        while iterations < simulations and time.perf_counter() < deadline:
            self._simulate(root,rng)
            iterations += 1
        scores = root.scores()
        p,diag = safe_distribution(scores,a,v,root.eqc,self.temperature,vertices=root.vertices)
        diag.update(simulations=iterations,seconds=time.perf_counter()-start,
                    visits=root.counts.tolist(),kind=self.kind,temperature=self.temperature,
                    safety_budget=.02,delta=DELTA,
                    safety_limited=bool(min(self._softmax(scores) @ a)<v-DELTA))
        return Decision(root.ac,p,scores,diag)

    def _softmax(self,scores):
        if self.temperature == 0:
            p=np.zeros(len(scores)); p[np.argmax(scores)]=1; return p
        p=np.exp((scores-max(scores))/self.temperature)
        return p/p.sum()

    def _next_belief(self,s,belief,b,meta):
        return self.model.update(s,belief,b,bool(meta.get('round_end'))) if self.kind=='belief' else belief

    def _rollout(self,s,belief,rng):
        return self.rollout.run(s,belief,self.kind=='belief',int(rng.integers(2**31)))

    def _simulate(self,root,rng):
        node=root
        path=[]
        while True:
            # UCB is used only to allocate search samples. Sampling distributions
            # also obey the equilibrium continuation floor, including deeper nodes.
            if node.visits == 0 or node.visits & (node.visits-1) == 0:
                optimistic = node.scores()+np.sqrt(2*np.log(node.visits+2)/(node.counts+1))
                node.policy,_=safe_distribution(optimistic,node.qeq,node.value,node.eqc,
                                                self.temperature,vertices=node.vertices)
            ai=int(rng.choice(len(node.ac),p=node.policy))
            bi=int(rng.choice(len(node.ah),p=node.prediction))
            a,b=node.ac[ai],node.ah[bi]
            path.append((node,ai))
            ns,u,meta=transition(node.state,a,b,self.eq.config)
            if ns is None:
                reward=u; break
            key=(ai,bi)
            if key not in node.children:
                belief=self._next_belief(node.state,node.belief,b,meta)
                node.children[key]=Node(ns,belief,self)
                reward=self._rollout(ns,belief,rng)
                break
            node=node.children[key]
        for node,ai in path:
            node.visits+=1; node.counts[ai]+=1; node.sums[ai]+=reward


def exact_belief_value(eq,s,belief,kind='belief',temperature=0.,max_nodes=200000):
    """Enumerate every action/observation branch. Only for reduced horizons.

    Returns terminal expected score, not entropy-augmented value. Node limit is
    explicit: never silently substitute a heuristic for this exact reference.
    """
    model=OpponentModel(eq)
    count=0
    def visit(s,b):
        nonlocal count
        count+=1
        if count>max_nodes:
            raise RuntimeError('Exact belief-tree node budget exceeded')
        v,p,_,qeq=eq.query(s)
        ac,ah=actions(s)
        predictions=model.prediction(s,b)
        scores=np.zeros(len(ac))
        for i,a in enumerate(ac):
            for j,h in enumerate(ah):
                if predictions[j] <= 0:
                    continue
                ns,u,meta=transition(s,a,h,eq.config)
                nb=model.update(s,b,h,bool(meta.get('round_end'))) if kind=='belief' else b
                continuation=u if ns is None else visit(ns,nb)[0]
                scores[i]+=predictions[j]*continuation
        if b.observations:
            p,_=safe_distribution(scores,qeq,v,p,temperature)
        return float(p @ scores),p,scores
    result=visit(s,belief)
    return dict(value=result[0],probabilities=result[1],scores=result[2],nodes=count)
