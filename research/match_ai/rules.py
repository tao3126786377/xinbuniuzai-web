"""Exact full-match rules; computer is seat 0, human is seat 1."""
from dataclasses import dataclass, asdict

SHOOT, DEFEND, RELOAD = range(3)


@dataclass(frozen=True)
class Config:
    rounds: int = 5
    cap: int = 100
    money: int = 50

    def __post_init__(self):
        if not (1 <= self.rounds <= 5 and 1 <= self.cap <= 100 and 1 <= self.money <= 50):
            raise ValueError('Research config must be within the production horizon and bankroll')

    @property
    def horizon(self):
        return self.rounds * (self.cap + 1)


@dataclass(frozen=True)
class State:
    phase: str = 'pick'
    round: int = 1
    turn: int = 1
    mc: int = 50
    mh: int = 50
    pc: int = 0
    ph: int = 0
    bc: int = 0
    bh: int = 0
    previous: tuple = (-1, -1)  # computer action, human action
    last_result: int = 0       # human: loss +1, draw 0, win -1

    def to_dict(self):
        return asdict(self)


def initial(config=Config()):
    return State(mc=config.money, mh=config.money)


def feasible(b):
    return tuple(a for a in (DEFEND, SHOOT, RELOAD)
                 if a == DEFEND or (a == SHOOT and b > 0) or (a == RELOAD and b < 10))


def winner(bc, bh):
    if bc >= 10 and bh >= 10:
        return 0
    if bc >= 5 and bc > bh:
        return 1
    if bh >= 5 and bh > bc:
        return 2
    return -1


def duel(bc, bh, ac, ah):
    if ac == SHOOT and ah == RELOAD:
        return 1, bc, bh, True
    if ah == SHOOT and ac == RELOAD:
        return 2, bc, bh, True
    nc = bc + (ac == RELOAD) - (ac == SHOOT)
    nh = bh + (ah == RELOAD) - (ah == SHOOT)
    return winner(nc, nh), nc, nh, False


def final_bullets(bc, bh, ac, ah, win):
    return (bc - (ac == SHOOT) + (ac == RELOAD and (win in (0, 1) or ah != SHOOT)),
            bh - (ah == SHOOT) + (ah == RELOAD and (win in (0, 2) or ac != SHOOT)))


def settlement(mc, mh, pc, ph, win, bc, bh):
    if win == 0:
        return mc - 5 * pc, mh - 5 * ph, 0
    x = abs(bc - bh)
    amount = (pc + 1) * (ph + 1) * x
    if win != (1 if bc > bh else 2):
        amount *= 2
    transfer = amount if win == 1 else -amount
    return mc + transfer, mh - transfer, transfer


def actions(s):
    return ((0, 1, 2), (0, 1, 2)) if s.phase == 'pick' else (feasible(s.bc), feasible(s.bh))


def utility(mc, mh):
    return 1.0 if mc > mh else 0.0 if mc < mh else 0.5


def transition(s, ac, ah, config=Config()):
    """Return (next State | None, terminal score | None, settlement metadata)."""
    fc, fh = actions(s)
    if ac not in fc or ah not in fh:
        raise ValueError('Illegal simultaneous action')
    if s.phase == 'pick':
        return State('play', s.round, 1, s.mc, s.mh, ac, ah, ac, ah,
                     (-1, -1), s.last_result), None, {}
    win, nc, nh, instant = duel(s.bc, s.bh, ac, ah)
    capped = win == -1 and s.turn >= config.cap
    if win == -1 and not capped:
        return State('play', s.round, s.turn + 1, s.mc, s.mh, s.pc, s.ph,
                     nc, nh, (ac, ah), s.last_result), None, {}
    if capped:
        win = 0
    fc, fh = final_bullets(s.bc, s.bh, ac, ah, win)
    mc, mh, transfer = settlement(s.mc, s.mh, s.pc, s.ph, win, fc, fh)
    meta = dict(round_end=True, winner=win, capped=capped, instant=instant,
                final_bullets=[fc, fh], money=[mc, mh], transfer=transfer)
    if mc <= 0 or mh <= 0 or s.round >= config.rounds:
        return None, utility(mc, mh), meta
    return State('pick', s.round + 1, 1, mc, mh, last_result=1 if win == 1 else -1 if win == 2 else 0), None, meta
