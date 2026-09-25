"""Post-hoc terminal audit of the largest sampled late mimic discrepancy."""
from dataclasses import asdict
from functools import lru_cache
import json
import time
import numpy as np
from ..rules import State, actions, transition
from ..matrix import safe_distribution
from ..belief import Belief
from ..phase2.data import event, remember
from ..phase2.study import Lookahead
from ..phase3.reliability import Forecast, Evidence
from ..phase3.study import ReliabilityPlanner
from .study import profile, safety_check


def terminal_oracle(eq, player, state, history):
    """Mimic depends on at most two current-round events; exact finite suffix DP."""
    if player.family != 'mimic' or state.round != eq.config.rounds or state.phase != 'play':
        raise ValueError('Terminal audit requires a last-round mimic state')
    maximum = 0.
    @lru_cache(None)
    def visit(s, h):
        nonlocal maximum
        v, peq, _, q = eq.query(s); ac, ah = actions(s); scores = np.zeros(len(ac))
        hp = player.probabilities(s, h)
        for i, a in enumerate(ac):
            for j, b in enumerate(ah):
                ns, u, meta = transition(s, a, b, eq.config)
                nh = remember(h, event(s, a, b, meta, ns is None))[-2:]
                scores[i] += hp[j] * (u if ns is None else visit(ns, nh)[0])
        p, d = safe_distribution(scores, q, v, peq, temperature=0.)
        maximum = max(maximum, safety_check(eq, s, p, dict(max_local_loss=d['local_loss'], fallbacks=int(d['fallback']))))
        return float(p @ scores), tuple(p), tuple(scores)
    value, p, scores = visit(state, tuple(history[-2:]))
    return dict(value=value, distribution=p, scores=scores, nodes=visit.cache_info().currsize, max_local_loss=maximum)


def terminal_policy(eq, forecast, player, state, history, evidence, kind, depth):
    """Exact outcome probabilities of a fixed controller for the remaining game.

    Keep the full network history and evidence; only skip exactly zero mass.
    No equilibrium leaf evaluations are used for outcome evaluation.
    """
    planner = (Lookahead(eq, 'oracle', player=player, depth=depth) if kind == 'oracle'
               else ReliabilityPlanner(eq, forecast, kind, depth))
    nodes = 0; maximum = 0.
    def visit(s, h, e):
        nonlocal nodes, maximum
        nodes += 1; p, d = planner.decision(s, h, Belief.initial() if kind == 'oracle' else e)
        maximum = max(maximum, safety_check(eq, s, p, d)); ac, ah = actions(s)
        hp = player.probabilities(s, h); result = np.zeros(3)  # loss, draw, win
        for i, a in enumerate(ac):
            if p[i] == 0.: continue
            for j, b in enumerate(ah):
                mass = p[i] * hp[j]
                if mass == 0.: continue
                ns, u, meta = transition(s, a, b, eq.config)
                if ns is None:
                    result[int(2 * u)] += mass
                else:
                    nh = remember(h, event(s, a, b, meta, False))
                    ne = (e.update(d['experts'], b, forecast.selection['share'], e.observations + 1)
                          if kind == 'adaptive' else Evidence(e.log_weights, e.observations + 1))
                    result += mass * visit(ns, nh, ne)
        return result
    start = time.perf_counter(); probabilities = visit(state, history, evidence)
    if abs(probabilities.sum() - 1.) > 1e-10: raise ArithmeticError('Outcome probabilities do not sum to one')
    return dict(score=float(probabilities @ [0., .5, 1.]), loss=float(probabilities[0]),
                draw=float(probabilities[1]), win=float(probabilities[2]), nodes=nodes,
                max_local_loss=maximum, seconds=time.perf_counter() - start)


def audit(baseline, source, output):
    from pathlib import Path
    from ..equilibrium import Equilibrium
    eq = Equilibrium(baseline); forecast = Forecast(source); output = Path(output)
    rows = json.loads((output / 'mimic.json').read_text(encoding='utf-8'))['natural']
    eligible = [r for r in rows if r['state']['phase'] == 'play' and r['state']['round'] == eq.config.rounds
                and eq.config.cap - r['state']['turn'] + 1 <= 7]
    if not eligible: raise ValueError('No sampled last-seven-turn mimic states')
    row = max(eligible, key=lambda r:r['candidates']['neural3']['opportunity_cost'])
    state = State(**{**row['state'], 'previous':tuple(row['state']['previous'])})
    history = tuple(tuple(x) for x in row['history']); evidence = Evidence(**row['evidence'])
    player = profile('mimic', row['profile']); start = time.perf_counter()
    oracle = terminal_oracle(eq, player, state, history); policies = {}
    for name, kind, depth in (('neural2','neural',2), ('neural3','neural',3), ('adaptive3','adaptive',3),
                              ('oracle2','oracle',2), ('oracle3','oracle',3), ('equilibrium','equilibrium',1)):
        policies[name] = terminal_policy(eq, forecast, player, state, history, evidence, kind, depth)
        print('endgame', name, policies[name]['score'], policies[name]['seconds'], flush=True)
    result = dict(source='synthetic', post_hoc=True,
        selection='maximum neural3 opportunity cost among sampled mimic last-round states with at most seven turns left',
        state=state.to_dict(), history=history, evidence=asdict(evidence), profile=row['profile'],
        oracle=oracle, policies=policies, seconds=time.perf_counter()-start,
        root_only_values={k:float(np.asarray(row['candidates'][k]['distribution']) @ oracle['scores']) for k in row['candidates']})
    (output / 'endgame.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    return result
