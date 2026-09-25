'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { actions } = require('./rules');

function features(s, history, equilibrium) {
  const x = new Float64Array(203), legal = actions(s)[1], eq = equilibrium.query(s);
  x.set([Number(s.phase === 'pick'),s.round/5,s.turn/100,s.mc/100,s.mh/100,
    s.pc/2,s.ph/2,s.bc/10,s.bh/10,s.last_result]);
  for (let a = 0; a < 3; a++) { x[10+a] = Number(s.previous[0] === a); x[13+a] = Number(s.previous[1] === a); }
  legal.forEach((a,j) => { x[16+a] = eq.human[j]; });
  for (let j = 0; j < Math.min(8,history.length); j++) x.set(history[history.length-1-j],19+11*j);
  if (!history.length) return x;
  const segment = []; let round = 0;
  for (const token of history) { round += token[1]; segment.push(round); }
  let offset = 107;
  for (let lag = 1; lag <= 4; lag++) for (const source of [2,5]) {
    const counts = new Float64Array(9);
    for (let j = lag; j < history.length; j++) {
      const old = history[j-lag], current = history[j];
      if (segment[j] !== segment[j-lag] || old[1] || current[1]) continue;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) counts[a*3+b] += old[source+a]*current[5+b];
    }
    for (let a = 0; a < 3; a++) {
      const total = counts[a*3]+counts[a*3+1]+counts[a*3+2];
      for (let b = 0; b < 3; b++) x[offset+a*3+b] = (counts[a*3+b]+1)/(total+3);
      x[offset+9+a] = total/(total+3);
    }
    offset += 12;
  }
  return x;
}

class BehaviorModel {
  constructor(directory) {
    this.manifest = JSON.parse(fs.readFileSync(path.join(directory,'policy.json'),'utf8'));
    if (this.manifest.id !== 'full-temporal3-v1' || this.manifest.inputs !== 203 || this.manifest.hidden !== 96 || this.manifest.depth !== 3)
      throw new Error('Unsupported fixed policy');
    const bytes = fs.readFileSync(path.join(directory,'weights.bin'));
    if (bytes.length !== 19875*8 || crypto.createHash('sha256').update(bytes).digest('hex') !== this.manifest.weightsSha256)
      throw new Error('Corrupt behavior model');
    const weights = new Float64Array(19875);
    for (let i = 0; i < weights.length; i++) {
      weights[i] = bytes.readDoubleLE(i*8);
      if (!Number.isFinite(weights[i])) throw new Error('Nonfinite model weight');
    }
    this.w0 = weights.subarray(0,19488); this.b0 = weights.subarray(19488,19584);
    this.w1 = weights.subarray(19584,19872); this.b1 = weights.subarray(19872);
  }
  predict(s, history, equilibrium) {
    const x = features(s,history,equilibrium), hidden = new Float64Array(96);
    for (let i = 0; i < 203; i++) if (x[i] !== 0) for (let j = 0; j < 96; j++) hidden[j] += x[i]*this.w0[i*96+j];
    for (let j = 0; j < 96; j++) hidden[j] = Math.tanh(hidden[j]+this.b0[j]);
    const logits = Array(3).fill(0);
    for (let j = 0; j < 96; j++) for (let a = 0; a < 3; a++) logits[a] += hidden[j]*this.w1[j*3+a];
    for (let a = 0; a < 3; a++) logits[a] += this.b1[a];
    const legal = actions(s)[1], max = Math.max(...legal.map(a => logits[a])), p = [0,0,0];
    let sum = 0;
    for (const a of legal) { p[a] = Math.exp(logits[a]-max); sum += p[a]; }
    return p.map(x => x/sum);
  }
}
module.exports = { BehaviorModel, features };
