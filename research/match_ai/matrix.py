"""Small zero-sum games and entropy maximization over the safe simplex."""
import numpy as np
from numba import njit
from scipy.optimize import linprog

DELTA = 0.0199 / 505
SAFETY_TOLERANCE = 1e-11


@njit(cache=True)
def row_game(a):
    """Enumerate vertices of the <=3 action maximin LP, including degeneracy."""
    n, m = a.shape
    best = -1e100
    p = np.zeros(n)
    for i in range(n):
        v = np.min(a[i])
        if v > best:
            best = v
            p[:] = 0
            p[i] = 1
    for i in range(n):
        for j in range(i + 1, n):
            for c in range(m):
                for d in range(c + 1, m):
                    den = a[i, c] - a[j, c] - a[i, d] + a[j, d]
                    if abs(den) < 1e-15:
                        continue
                    x = (a[j, d] - a[j, c]) / den
                    if x < -1e-12 or x > 1 + 1e-12:
                        continue
                    x = min(1., max(0., x))
                    v = np.min(x * a[i] + (1 - x) * a[j])
                    if v > best:
                        best = v
                        p[:] = 0
                        p[i], p[j] = x, 1 - x
    if n == 3 and m == 3:
        u = a[:, 1] - a[:, 0]
        w = a[:, 2] - a[:, 0]
        cross = np.array([u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]])
        den = np.sum(cross)
        if abs(den) > 1e-15:
            candidate = cross / den
            if np.min(candidate) >= -1e-12:
                candidate = np.maximum(candidate, 0.)
                candidate /= np.sum(candidate)
                v = np.min(candidate @ a)
                if v > best:
                    best, p = v, candidate
    return best, p


@njit(cache=True)
def solve_game(a):
    lower, p = row_game(a)
    neg_upper, q = row_game(-a.T.copy())
    upper = -neg_upper
    return (lower + upper) / 2, p, q, max(0., upper - lower)


def lp_game(a):
    n, m = a.shape
    result = linprog(np.r_[np.zeros(n), -1.],
                     A_ub=np.c_[-a.T, np.ones(m)], b_ub=np.zeros(m),
                     A_eq=np.array([np.r_[np.ones(n), 0.]]), b_eq=[1.],
                     bounds=[(0, None)] * n + [(None, None)], method='highs')
    if not result.success:
        raise RuntimeError(result.message)
    return result.x[-1], result.x[:-1]


@njit(cache=True)
def safe_vertices(qeq, value, delta=DELTA):
    """All vertices of {p>=0,sum p=1,p Qeq >= value-delta}."""
    n = qeq.shape[0]
    rows=n+qeq.shape[1]
    a=np.zeros((rows,n)); rhs=np.zeros(rows)
    for i in range(n): a[i,i]=1
    for j in range(qeq.shape[1]):
        a[n+j]=qeq[:,j]; rhs[n+j]=value-delta
    vertices=np.empty((rows*rows,n)); count=0
    for i in range(rows):
        for j in range(i+1,rows) if n==3 else range(1):
            p=np.ones(n)
            if n==2:
                den=a[i,0]-a[i,1]
                if abs(den)<1e-15: continue
                p[0]=(rhs[i]-a[i,1])/den; p[1]=1-p[0]
            elif n==3:
                u=a[i,0]-a[i,2]; v=a[i,1]-a[i,2]; z=rhs[i]-a[i,2]
                u2=a[j,0]-a[j,2]; v2=a[j,1]-a[j,2]; z2=rhs[j]-a[j,2]
                den=u*v2-u2*v
                if abs(den)<1e-15: continue
                p[0]=(z*v2-z2*v)/den; p[1]=(u*z2-u2*z)/den; p[2]=1-p[0]-p[1]
            if np.min(a@p-rhs)>=-1e-11:
                p=np.maximum(p,0); p/=p.sum(); duplicate=False
                for k in range(count):
                    if np.max(np.abs(p-vertices[k]))<1e-10: duplicate=True; break
                if not duplicate: vertices[count]=p; count+=1
    return vertices[:count]


@njit(cache=True)
def entropy(p):
    return -float(np.sum(p[p > 0] * np.log(p[p > 0])))


@njit(cache=True)
def entropy_choice(scores,vertices,eq,temperature):
    p=eq.copy(); best=p@scores+temperature*entropy(p)
    for i in range(len(vertices)):
        x=vertices[i]; v=x@scores+temperature*entropy(x)
        if v>best: best=v; p=x.copy()
        if temperature<=0: continue
        for j in range(i):
            y=vertices[j]; d=x-y; left=0.; right=1.
            # Derivative is monotone, including singular endpoint derivatives.
            for iteration in range(40):
                t=(left+right)/2; candidate=y+t*d
                gradient=d@scores
                for k in range(len(d)):
                    gradient-=temperature*d[k]*(np.log(max(candidate[k],1e-300))+1)
                if gradient>0: left=t
                else: right=t
            candidate=y+(left+right)/2*d
            v=candidate@scores+temperature*entropy(candidate)
            if v>best: best=v; p=candidate.copy()
    return p


def safe_distribution(scores, qeq, value, eq, temperature=0.005, delta=DELTA, vertices=None):
    """Exact simplex/edge search in <=3 dimensions; audit and equilibrium fallback."""
    scores = np.asarray(scores, dtype=float)
    if not np.all(np.isfinite(scores)):
        return eq.copy(), dict(fallback=True, reason='nonfinite_scores')
    verts = safe_vertices(qeq, value, delta) if vertices is None else vertices
    p = entropy_choice(scores,verts,eq,temperature)
    if temperature > 0:
        ex = np.exp((scores - max(scores)) / temperature)
        soft = ex / ex.sum()
        if min(soft @ qeq) >= value - delta - 1e-12:
            p = soft
    floor = float(min(p @ qeq))
    fallback = not (np.all(np.isfinite(p)) and min(p) >= 0 and
                    abs(p.sum()-1) < 1e-10 and floor >= value-delta-SAFETY_TOLERANCE)
    if fallback:
        p = eq.copy()
    return p, dict(fallback=fallback, worst_continuation=float(min(p @ qeq)),
                   local_loss=float(value-min(p @ qeq)), entropy=entropy(p))
