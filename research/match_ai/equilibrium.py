"""Reachable-state finite-horizon DP, float64 disk arrays, numerical certificate."""
from dataclasses import asdict
from functools import lru_cache
import json
from pathlib import Path
import time
import numpy as np
from numba import njit
from .rules import Config, State, feasible, winner, duel, final_bullets, settlement, utility, actions, transition
from .matrix import solve_game

BULLETS = [(a, b) for a in range(11) for b in range(11) if winner(a, b) == -1]
BINDEX = {b: i for i, b in enumerate(BULLETS)}


def topology(config):
    active = np.zeros((9, config.cap, len(BULLETS)), dtype=np.bool_)
    nxt = np.full((30, 3, 3), -2, dtype=np.int64)
    wins = np.full_like(nxt, -2)
    dc = np.zeros((9, 30, 3, 3), dtype=np.int64)
    dh = np.zeros_like(dc)
    moves = np.full((30, 2, 3), -1, dtype=np.int64)
    lengths = np.zeros((30, 2), dtype=np.int64)
    deltas = set()
    for k, (bc, bh) in enumerate(BULLETS):
        for side, b in enumerate((bc, bh)):
            fs = feasible(b)
            lengths[k, side] = len(fs)
            moves[k, side, :len(fs)] = fs
        for a in feasible(bc):
            for b in feasible(bh):
                win, nc, nh, _ = duel(bc, bh, a, b)
                wins[k, a, b] = win
                nxt[k, a, b] = BINDEX[(nc, nh)] if win == -1 else -1
                for pick in range(9):
                    pc, ph = divmod(pick, 3)
                    fc, fh = final_bullets(bc, bh, a, b, win)
                    if win != -1:
                        dc[pick, k, a, b], dh[pick, k, a, b], _ = settlement(0, 0, pc, ph, win, fc, fh)
    for pick in range(9):
        pc, ph = divmod(pick, 3)
        active[pick, 0, BINDEX[(pc, ph)]] = True
        for t in range(config.cap):
            for k in np.flatnonzero(active[pick, t]):
                bc, bh = BULLETS[k]
                for a in feasible(bc):
                    for b in feasible(bh):
                        nk = nxt[k, a, b]
                        if nk >= 0 and t + 1 < config.cap:
                            active[pick, t+1, nk] = True
                        elif nk >= 0:
                            deltas.add((-5*pc, -5*ph))
                        else:
                            deltas.add((int(dc[pick,k,a,b]), int(dh[pick,k,a,b])))
    pairs = [[(config.money, config.money)]]
    for r in range(1, config.rounds):
        pairs.append(sorted({(mc+c, mh+h) for mc, mh in pairs[-1] for c, h in deltas
                             if mc+c > 0 and mh+h > 0}))
    return active, nxt, dc, dh, moves, lengths, pairs


@njit(cache=True)
def next_value(mc, mh, last, boundary):
    if mc <= 0 or mh <= 0 or last:
        return 1. if mc > mh else 0. if mc < mh else 0.5
    return boundary[mc, mh]


@njit(cache=True)
def solve_round(values, pick_values, pairs, active, nxt, dc, dh, moves, lengths, boundary, last):
    max_gap, count = 0., 0
    cap = active.shape[1]
    for mi in range(len(pairs)):
        mc, mh = pairs[mi]
        for pick in range(9):
            pc, ph = pick//3, pick%3
            draw_value = next_value(mc-5*pc, mh-5*ph, last, boundary)
            for t in range(cap-1, -1, -1):
                for k in range(30):
                    if not active[pick,t,k]:
                        continue
                    nc, nh = lengths[k,0], lengths[k,1]
                    q = np.empty((nc,nh))
                    for ai in range(nc):
                        a = moves[k,0,ai]
                        for bi in range(nh):
                            b = moves[k,1,bi]
                            nk = nxt[k,a,b]
                            if nk >= 0:
                                q[ai,bi] = values[mi,pick,t+1,nk] if t+1 < cap else draw_value
                            else:
                                q[ai,bi] = next_value(mc+dc[pick,k,a,b], mh+dh[pick,k,a,b], last, boundary)
                    v, p, h, gap = solve_game(q)
                    values[mi,pick,t,k] = v
                    max_gap = max(max_gap, gap)
                    count += 1
        qpick = np.empty((3,3))
        for pc in range(3):
            for ph in range(3):
                # States 0..4 are (0,0)..(0,4), then five per row up to (4,4).
                k = pc*5+ph
                qpick[pc,ph] = values[mi,pc*3+ph,0,k]
        v, p, h, gap = solve_game(qpick)
        pick_values[mi] = v
        max_gap = max(max_gap, gap)
        count += 1
    return max_gap, count


def build(directory, config=Config()):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    if (directory/'manifest.json').exists():
        previous = json.loads((directory/'manifest.json').read_text())
        if previous['config'] != asdict(config):
            raise ValueError('Use a different artifact directory for a different config')
        return Equilibrium(directory)
    start = time.perf_counter()
    active, nxt, dc, dh, moves, lengths, pairs = topology(config)
    boundary = np.full((2*config.money+1, 2*config.money+1), np.nan)
    max_gap, states = 0., 0
    for r in range(config.rounds-1, -1, -1):
        shape = (len(pairs[r]), 9, config.cap, 30)
        values = np.lib.format.open_memmap(directory/f'values_{r+1}.npy', mode='w+', dtype='float64', shape=shape)
        values[:] = np.nan
        pv = np.empty(len(pairs[r]))
        gap, count = solve_round(values, pv, np.asarray(pairs[r]), active, nxt, dc, dh,
                                 moves, lengths, boundary, r == config.rounds-1)
        values.flush()
        del values
        if not np.all(np.isfinite(pv)):
            raise ArithmeticError('Nonfinite reachable boundary value')
        np.save(directory/f'picks_{r+1}.npy', pv)
        boundary[:] = np.nan
        for i, (mc,mh) in enumerate(pairs[r]):
            boundary[mc,mh] = pv[i]
        max_gap = max(max_gap, gap)
        states += count
        print(f'round={r+1} bankrolls={len(pairs[r])} states={count} gap={gap:.3g}', flush=True)
    bound = config.horizon * (max_gap + 32*np.finfo(float).eps)
    manifest = dict(version=1, config=asdict(config), pairs=pairs, states=states,
                    max_local_duality_gap=max_gap, accumulated_error_bound=bound,
                    certified=bool(bound <= 0.0001), seconds=time.perf_counter()-start,
                    root_value=float(boundary[config.money,config.money]),
                    artifact_bytes=sum(p.stat().st_size for p in directory.glob('*.npy')))
    (directory/'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return Equilibrium(directory)


class Equilibrium:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.manifest = json.loads((self.directory/'manifest.json').read_text(encoding='utf-8'))
        self.config = Config(**self.manifest['config'])
        self.indices = [{tuple(p):i for i,p in enumerate(ps)} for ps in self.manifest['pairs']]
        self.values = [np.load(self.directory/f'values_{r+1}.npy', mmap_mode='r') for r in range(self.config.rounds)]
        self.picks = [np.load(self.directory/f'picks_{r+1}.npy', mmap_mode='r') for r in range(self.config.rounds)]

    def value(self, s):
        idx = self.indices[s.round-1][(s.mc,s.mh)]
        if s.phase == 'pick':
            return float(self.picks[s.round-1][idx])
        v = float(self.values[s.round-1][idx,s.pc*3+s.ph,s.turn-1,BINDEX[(s.bc,s.bh)]])
        if not np.isfinite(v):
            raise ValueError('State is unreachable at this turn/pick combination')
        return v

    @lru_cache(maxsize=50000)
    def _query(self, physical):
        s = State(*physical)
        ac, ah = actions(s)
        matrix = np.empty((len(ac),len(ah)))
        for i,a in enumerate(ac):
            for j,b in enumerate(ah):
                ns, u, _ = transition(s,a,b,self.config)
                matrix[i,j] = u if ns is None else self.value(ns)
        v,p,q,gap = solve_game(matrix)
        for x in (p,q,matrix):
            x.flags.writeable = False
        return v,p,q,matrix

    def query(self, s):
        # Equilibrium is physical-state Markov; opponent memory affects only belief planning.
        return self._query((s.phase,s.round,s.turn,s.mc,s.mh,s.pc,s.ph,s.bc,s.bh))
