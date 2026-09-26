'use strict';
const DELTA = 0.0199 / 505;
const TOLERANCE = 1e-11;
function dot(a, b) { let result = 0; for (let i = 0; i < a.length; i++) result += a[i] * b[i]; return result; }
function minimum(p, matrix) {
  let result = Infinity;
  for (let j = 0; j < matrix[0].length; j++) {
    let value = 0; for (let i = 0; i < p.length; i++) value += p[i] * matrix[i][j];
    result = Math.min(result, value);
  }
  return result;
}
function rowGame(a) {
  const n = a.length, m = a[0].length;
  let best = -Infinity, p = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const value = Math.min(...a[i]);
    if (value > best) { best = value; p = Array(n).fill(0); p[i] = 1; }
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    for (let c = 0; c < m; c++) for (let d = c + 1; d < m; d++) {
      const den = a[i][c] - a[j][c] - a[i][d] + a[j][d];
      if (Math.abs(den) < 1e-15) continue;
      let x = (a[j][d] - a[j][c]) / den;
      if (x < -1e-12 || x > 1 + 1e-12) continue;
      x = Math.max(0, Math.min(1, x));
      const candidate = Array(n).fill(0); candidate[i] = x; candidate[j] = 1 - x;
      const value = minimum(candidate, a);
      if (value > best) { best = value; p = candidate; }
    }
  }
  if (n === 3 && m === 3) {
    const u = a.map(row => row[1] - row[0]), w = a.map(row => row[2] - row[0]);
    const cross = [u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]];
    const den = cross.reduce((x, y) => x + y, 0);
    if (Math.abs(den) > 1e-15) {
      let candidate = cross.map(x => x / den);
      if (Math.min(...candidate) >= -1e-12) {
        candidate = candidate.map(x => Math.max(0, x)); const sum = candidate.reduce((x,y) => x+y, 0);
        candidate = candidate.map(x => x / sum); const value = minimum(candidate, a);
        if (value > best) { best = value; p = candidate; }
      }
    }
  }
  return { value: best, probabilities: p };
}
function solveGame(a) {
  const lower = rowGame(a), upper = rowGame(a[0].map((_, j) => a.map(row => -row[j])));
  return { value: (lower.value - upper.value) / 2, computer: lower.probabilities,
    human: upper.probabilities, gap: Math.max(0, -upper.value - lower.value), matrix: a };
}
function safeVertices(q, value, delta = DELTA) {
  const n = q.length;
  if (n === 1) return [[1]];
  const a = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Number(i === j)));
  const rhs = Array(n).fill(0);
  for (let j = 0; j < q[0].length; j++) { a.push(q.map(row => row[j])); rhs.push(value - delta); }
  const vertices = [];
  for (let i = 0; i < a.length; i++) for (let j = n === 3 ? i + 1 : 0; j < (n === 3 ? a.length : 1); j++) {
    let p;
    if (n === 2) {
      const den = a[i][0] - a[i][1]; if (Math.abs(den) < 1e-15) continue;
      const x = (rhs[i] - a[i][1]) / den; p = [x, 1 - x];
    } else {
      const u = a[i][0]-a[i][2], v = a[i][1]-a[i][2], z = rhs[i]-a[i][2];
      const u2 = a[j][0]-a[j][2], v2 = a[j][1]-a[j][2], z2 = rhs[j]-a[j][2], den = u*v2-u2*v;
      if (Math.abs(den) < 1e-15) continue;
      const x = (z*v2-z2*v)/den, y = (u*z2-u2*z)/den; p = [x, y, 1-x-y];
    }
    if (a.some((row, k) => dot(row, p) - rhs[k] < -TOLERANCE)) continue;
    p = p.map(x => Math.max(0, x)); const sum = p.reduce((x,y) => x+y, 0); p = p.map(x => x/sum);
    if (!vertices.some(v => v.every((x,k) => Math.abs(x-p[k]) < 1e-10))) vertices.push(p);
  }
  return vertices;
}
function safeChoice(scores, eq, delta = DELTA) {
  let p = eq.computer.slice(), best = dot(p, scores), fallback = false;
  if (scores.every(Number.isFinite)) {
    for (const candidate of safeVertices(eq.matrix, eq.value, delta)) {
      const value = dot(candidate, scores); if (value > best) { p = candidate; best = value; }
    }
  } else fallback = true;
  if (p.some(x => !Number.isFinite(x) || x < 0) || Math.abs(p.reduce((x,y) => x+y, 0)-1) >= 1e-10 ||
      minimum(p, eq.matrix) < eq.value-delta-TOLERANCE) fallback = true;
  if (fallback) p = eq.computer.slice();
  return { probabilities: p, fallback, loss: eq.value-minimum(p, eq.matrix) };
}
module.exports = { DELTA, TOLERANCE, dot, minimum, solveGame, safeChoice, safeVertices };
