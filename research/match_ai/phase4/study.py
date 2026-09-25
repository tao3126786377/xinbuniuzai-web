"""Fresh trajectories and legal matched-state histories; no model fitting."""
from dataclasses import asdict
from itertools import product
from pathlib import Path
import hashlib
import json
import time
import numpy as np
from ..rules import initial, actions, transition, DEFEND
from ..belief import Belief
from ..matrix import DELTA, SAFETY_TOLERANCE, safe_distribution
from ..phase2.data import Profile, FAMILIES as OLD_FAMILIES, event, remember
from ..phase2.study import Lookahead, paired_bootstrap
from ..phase3.data import Scenario, FAMILIES
from ..phase3.reliability import Evidence, Forecast
from ..phase3.study import ReliabilityPlanner

VALUE_TOLERANCE = 1e-10
KINDS = ('neural2', 'neural3', 'adaptive3')


def random_stream(family, index, stream=0):
    return np.random.default_rng(np.random.SeedSequence([20260925, 4, FAMILIES.index(family), index, stream]))


def profile(family, index):
    rng = random_stream(family, index)
    def one(name):
        return Profile(name, float(rng.uniform(.08, .30)), int(rng.integers(3)),
                       int(rng.integers(2, 5)), tuple(int(i) for i in rng.permutation(3)), int(rng.integers(3)))
    if family == 'changing':
        first = one('streak'); second = one('reactive' if rng.random() < .5 else 'cycle')
    else:
        first = one(family if family in OLD_FAMILIES else 'fixed'); second = first
    return Scenario(family, first, second, int(rng.integers(6, 13)))


def advance(eq, forecast, s, history, evidence, a, b):
    """Update using pre-reveal likelihoods exactly once after a public action pair."""
    experts, _ = forecast.experts(s, history, eq)
    ns, u, meta = transition(s, a, b, eq.config)
    ne = evidence.update(experts, b, forecast.selection['share'], evidence.observations + 1)
    nh = remember(history, event(s, a, b, meta, ns is None))
    return ns, nh, ne, u, meta


def trajectory(eq, forecast, player, rng):
    s = initial(eq.config); h = (); e = Evidence(); samples = []; trace = []
    while True:
        if e.observations: samples.append((s, h, e))
        ac, ah = actions(s); p = eq.query(s)[1]; hp = player.probabilities(s, h)
        a = ac[int(rng.choice(len(ac), p=p))]; b = ah[int(rng.choice(len(ah), p=hp))]
        ns, nh, ne, u, meta = advance(eq, forecast, s, h, e, a, b)
        trace.append(dict(state=s.to_dict(), computer=a, human=b, event_id=ne.observations,
                          settlement=meta, terminal_score=u))
        if ns is None: return samples, trace
        s, h, e = ns, nh, ne


def matched_histories(eq, forecast):
    """Exhaustive synchronized four-move loops followed by defend/defend.

    All histories are replayed from the genuine initial state. Within each group,
    the FULL current state, including previous actions and last round result, is
    identical. Equal weighting is a controlled intervention, not natural frequency.
    """
    groups = []
    for pc, ph in product(range(3), repeat=2):
        cases = []
        for moves in product(range(3), repeat=4):
            s = initial(eq.config); h = (); e = Evidence()
            path = [(pc, ph)] + [(a, a) for a in moves] + [(DEFEND, DEFEND)]
            for a, b in path:
                ac, ah = actions(s)
                if a not in ac or b not in ah: break
                ns, nh, ne, _, meta = advance(eq, forecast, s, h, e, a, b)
                if ns is None or (s.phase == 'play' and meta.get('round_end')): break
                s, h, e = ns, nh, ne
            else:
                if s.bc == pc and s.bh == ph:
                    cases.append((s, h, e, path))
        if cases:
            assert all(c[0] == cases[0][0] for c in cases)
            groups.append(cases)
    return groups


def safety_check(eq, s, p, diagnostic):
    v, _, _, q = eq.query(s)
    if not np.all(np.isfinite(p)) or min(p) < -1e-12 or abs(sum(p) - 1.) > 1e-10:
        raise ArithmeticError('Invalid decision distribution')
    root_loss = float(v - min(p @ q))
    maximum = max(root_loss, diagnostic['max_local_loss'])
    if not np.isfinite(diagnostic['max_local_loss']) or maximum > DELTA + SAFETY_TOLERANCE or diagnostic['fallbacks']:
        raise ArithmeticError('Decision failed phase-four safety acceptance')
    return maximum


def evaluate(eq, forecast, player, s, h, e):
    references = {}; maximum = 0.; nodes = 0; seconds = {}; fallbacks = 0
    v, peq, _, qeq = eq.query(s)
    for depth in (1, 2, 3):
        p, d = Lookahead(eq, 'oracle', player=player, depth=depth).decision(s, h, Belief.initial())
        maximum = max(maximum, safety_check(eq, s, p, d)); nodes += d['nodes']; fallbacks += d['fallbacks']
        scores = np.asarray(d['scores']); worst, _ = safe_distribution(-scores, qeq, v, peq, temperature=0.)
        references[str(depth)] = dict(scores=scores.tolist(), distribution=p.tolist(),
            value=float(p @ scores), root_gain=float((p - peq) @ scores),
            safe_value_span=float((p - worst) @ scores),
            unrestricted_root_gap=float(max(scores) - p @ scores))
        seconds['oracle' + str(depth)] = d['seconds']
    scores = np.asarray(references['3']['scores']); optimum = references['3']['value']
    candidates = {}
    for name in KINDS:
        kind, depth = ('adaptive', 3) if name == 'adaptive3' else ('neural', int(name[-1]))
        p, d = ReliabilityPlanner(eq, forecast, kind, depth).decision(s, h, e)
        maximum = max(maximum, safety_check(eq, s, p, d)); nodes += d['nodes']; fallbacks += d['fallbacks']
        truth = player.probabilities(s, h); pred = d['prediction'][list(actions(s)[1])]
        candidates[name] = dict(distribution=p.tolist(), reference_value=float(p @ scores),
            opportunity_cost=float(max(0., optimum - p @ scores)),
            conditional_kl=float(truth @ (np.log(truth) - np.log(np.maximum(pred, 1e-300)))))
        seconds[name] = d['seconds']
    p2 = np.asarray(candidates['neural2']['distribution']); p3 = np.asarray(candidates['neural3']['distribution'])
    return dict(state=s.to_dict(), history=h, evidence=asdict(e), references=references, candidates=candidates,
                depth_tv=float(abs(p2 - p3).sum() / 2), seconds=seconds, nodes=nodes,
                max_local_loss=maximum, fallbacks=fallbacks)


def history_value(eq, state, rows):
    """Value of adapting THIS root action to history; future oracle sees history."""
    v, peq, _, qeq = eq.query(state)
    scores = np.asarray([r['references']['3']['scores'] for r in rows]); mean = scores.mean(axis=0)
    common, d = safe_distribution(mean, qeq, v, peq, temperature=0.)
    if d['fallback'] or d['local_loss'] > DELTA + SAFETY_TOLERANCE:
        raise ArithmeticError('Unsafe shared-history reference')
    informed = np.mean([r['references']['3']['value'] for r in rows])
    return dict(histories=len(rows), state=state.to_dict(), shared_distribution=common.tolist(),
        informed_value=float(informed), shared_value=float(common @ mean),
        root_history_value=float(max(0., informed - common @ mean)),
        network_minus_shared={k:float(np.mean([r['candidates'][k]['reference_value'] for r in rows]) - common @ mean) for k in KINDS})


def family_study(baseline, source, output, family, count):
    from ..equilibrium import Equilibrium
    eq = Equilibrium(baseline); forecast = Forecast(source); output = Path(output)
    start = time.perf_counter(); natural = []; controlled = []; groups = []
    with (output / f'{family}_trajectories.jsonl').open('w', encoding='utf-8') as trace:
        for i in range(count):
            player = profile(family, i)
            samples, public = trajectory(eq, forecast, player, random_stream(family, i, 1))
            selected = int(random_stream(family, i, 2).integers(len(samples)))
            s, h, e = samples[selected]
            trace.write(json.dumps(dict(source='synthetic', profile=i, player=asdict(player),
                                        selected_event_id=e.observations + 1, events=public)) + '\n')
            row = evaluate(eq, forecast, player, s, h, e); row['profile'] = i; natural.append(row)
            if (i + 1) % 32 == 0: print(f'phase4 {family}: {i + 1}/{count} natural states', flush=True)
    # Separate profile namespace: never chosen for a large observed history benefit.
    player = profile(family, 1000000)
    for cases in matched_histories(eq, forecast):
        rows = []
        for s, h, e, path in cases:
            row = evaluate(eq, forecast, player, s, h, e); row['path'] = path; rows.append(row)
        groups.append(history_value(eq, cases[0][0], rows)); controlled.extend(rows)
    result = dict(source='synthetic', family=family, natural=natural, controlled=controlled,
                  history_groups=groups, controlled_player=asdict(player), seconds=time.perf_counter() - start)
    (output / f'{family}.json').write_text(json.dumps(result), encoding='utf-8')
    print(f'phase4 {family}: complete, {len(controlled)} controlled states, {result["seconds"]:.1f}s', flush=True)
    return family


def run(baseline, source, output, count=128, workers=4):
    from concurrent.futures import ProcessPoolExecutor, as_completed
    from ..equilibrium import Equilibrium
    output = Path(output); output.mkdir(parents=True, exist_ok=True)
    eq = Equilibrium(baseline)
    if eq.config.rounds != 5 or eq.config.cap != 100 or eq.config.money != 50:
        raise ValueError('This study requires the full production baseline')
    hashes = {name:hashlib.sha256((Path(source) / name).read_bytes()).hexdigest()
              for name in ('neural.npz', 'linear.npz', 'selection.json')}
    protocol = dict(source='synthetic', seed_prefix=[20260925, 4], profiles_per_family=count,
        families=FAMILIES, natural_collection='equilibrium policy; one uniformly selected post-observation state per independent full match',
        controlled='all legal four synchronous moves returning to initial ammo, then defend/defend; equal history weights',
        depths=[1, 2, 3], candidates=KINDS, value_tolerance=VALUE_TOLERANCE,
        tuning='none; all networks and phase-three hyperparameters frozen', hashes=hashes,
        baseline_error=eq.manifest['accumulated_error_bound'], config=eq.manifest['config'], workers=workers)
    # Persist the protocol before observing new results.
    (output / 'protocol.json').write_text(json.dumps(protocol, indent=2), encoding='utf-8')
    start = time.perf_counter()
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(family_study, str(baseline), str(source), str(output), family, count) for family in FAMILIES]
        for task in as_completed(futures): task.result()
    for name, digest in hashes.items():
        if hashlib.sha256((Path(source) / name).read_bytes()).hexdigest() != digest:
            raise ArithmeticError('Frozen source changed during study')
    (output / 'runtime.json').write_text(json.dumps(dict(seconds=time.perf_counter() - start)), encoding='utf-8')


def aggregate(rows):
    values = lambda fn: np.asarray([fn(r) for r in rows])
    means = {k:float(values(lambda r:r['candidates'][k]['opportunity_cost']).mean()) for k in KINDS}
    extra = values(lambda r:r['candidates']['neural3']['reference_value'] - r['candidates']['neural2']['reference_value'])
    adaptive = values(lambda r:r['candidates']['adaptive3']['reference_value'] - r['candidates']['neural3']['reference_value'])
    return dict(states=len(rows), mean_opportunity_cost=means,
        root_gain_by_depth={str(d):float(values(lambda r:r['references'][str(d)]['root_gain']).mean()) for d in (1, 2, 3)},
        mean_safe_span=float(values(lambda r:r['references']['3']['safe_value_span']).mean()),
        mean_unrestricted_root_gap=float(values(lambda r:r['references']['3']['unrestricted_root_gap']).mean()),
        positive_safe_span=int(sum(r['references']['3']['safe_value_span'] > VALUE_TOLERANCE for r in rows)),
        flat2_nonflat3=int(sum(np.ptp(r['references']['2']['scores']) <= VALUE_TOLERANCE and
                              np.ptp(r['references']['3']['scores']) > VALUE_TOLERANCE for r in rows)),
        changed_depth=int(sum(r['depth_tv'] > .01 for r in rows)),
        depth_gain=dict(mean=float(extra.mean()), ci95=paired_bootstrap(extra)),
        adaptive_gain=dict(mean=float(adaptive.mean()), ci95=paired_bootstrap(adaptive)))
