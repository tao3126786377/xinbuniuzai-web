'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Game = require('../../public/js/game');
const Rules = require('./rules');
const { solveGame, minimum, TOLERANCE } = require('./math');

function readAt(fd, length, offset) {
  const data = Buffer.allocUnsafe(length); let done = 0;
  while (done < length) {
    const count = fs.readSync(fd, data, done, length-done, offset+done);
    if (!count) throw new Error('Truncated equilibrium table');
    done += count;
  }
  return data;
}
function openArray(file, expectedShape) {
  const fd = fs.openSync(file, 'r');
  try {
    const prefix = readAt(fd, 12, 0), version = prefix[6];
    if (prefix.subarray(0,6).toString('hex') !== '934e554d5059' || ![1,2].includes(version)) throw new Error('Unsupported NPY file');
    const start = version === 1 ? 10 : 12, length = version === 1 ? prefix.readUInt16LE(8) : prefix.readUInt32LE(8);
    const header = readAt(fd,length,start).toString('ascii');
    const match = header.match(/'shape':\s*\(([^)]*)\)/);
    const shape = match && match[1].split(',').map(x => x.trim()).filter(Boolean).map(Number);
    if (!/'descr':\s*'<f8'/.test(header) || !/'fortran_order':\s*False/.test(header) ||
        JSON.stringify(shape) !== JSON.stringify(expectedShape)) throw new Error('Incompatible equilibrium array');
    const offset = start+length, bytes = shape.reduce((a,b) => a*b, 8);
    if (fs.fstatSync(fd).size !== offset+bytes) throw new Error('Incorrect equilibrium array size');
    return { fd, offset };
  } catch (error) { fs.closeSync(fd); throw error; }
}

class Equilibrium {
  constructor(directory, expectedManifestHash) {
    const raw = fs.readFileSync(path.join(directory,'manifest.json'));
    if (crypto.createHash('sha256').update(raw).digest('hex') !== expectedManifestHash) throw new Error('Wrong equilibrium release');
    this.manifest = JSON.parse(raw);
    if (!this.manifest.certified || this.manifest.config.rounds !== 5 || this.manifest.config.cap !== 100 || this.manifest.config.money !== 50)
      throw new Error('Full certified equilibrium required');
    this.indices = this.manifest.pairs.map(pairs => new Map(pairs.map((pair,i) => [pair.join(','),i])));
    this.bullets = new Map();
    for (let a = 0; a <= 10; a++) for (let b = 0; b <= 10; b++) if (!Game.isTerminal(a,b)) this.bullets.set(`${a},${b}`,this.bullets.size);
    this.arrays = []; this.picks = []; this.blocks = new Map(); this.queries = new Map(); this.closed = false;
    try {
      for (let round = 1; round <= 5; round++) {
        const count = this.indices[round-1].size;
        this.arrays.push(openArray(path.join(directory,`values_${round}.npy`),[count,9,100,30]));
        const pick = openArray(path.join(directory,`picks_${round}.npy`),[count]);
        try { this.picks.push(readAt(pick.fd,count*8,pick.offset)); } finally { fs.closeSync(pick.fd); }
      }
    } catch (error) { this.close(); throw error; }
  }
  value(s) {
    if (this.closed) throw new Error('Equilibrium is closed');
    const index = this.indices[s.round-1]?.get(`${s.mc},${s.mh}`);
    if (index === undefined) throw new Error('Unreachable bankroll state');
    let value;
    if (s.phase === 'pick') value = this.picks[s.round-1].readDoubleLE(index*8);
    else {
      const bullet = this.bullets.get(`${s.bc},${s.bh}`);
      if (s.phase !== 'play' || bullet === undefined || !Number.isInteger(s.turn) || s.turn < 1 || s.turn > 100 ||
          ![0,1,2].includes(s.pc) || ![0,1,2].includes(s.ph)) throw new Error('Invalid play state');
      const key = `${s.round}:${index}`, size = 9*100*30*8;
      let block = this.blocks.get(key);
      if (block) this.blocks.delete(key);
      else { const array = this.arrays[s.round-1]; block = readAt(array.fd,size,array.offset+index*size); }
      this.blocks.set(key,block);
      if (this.blocks.size > 32) this.blocks.delete(this.blocks.keys().next().value);
      value = block.readDoubleLE(((s.pc*3+s.ph)*100*30+(s.turn-1)*30+bullet)*8);
    }
    if (!Number.isFinite(value) || value < -1e-12 || value > 1+1e-12) throw new Error('Invalid or unreachable equilibrium value');
    return value;
  }
  query(s) {
    const key = [s.phase,s.round,s.turn,s.mc,s.mh,s.pc,s.ph,s.bc,s.bh].join(':');
    if (this.closed) throw new Error('Equilibrium is closed');
    if (this.queries.has(key)) return this.queries.get(key);
    this.value(s); // Reject unreachable roots rather than only checking their children.
    const [ac,ah] = Rules.actions(s);
    const matrix = ac.map(a => ah.map(b => { const result = Rules.transition(s,a,b); return result.state ? this.value(result.state) : result.score; }));
    const result = solveGame(matrix);
    if (result.gap > 1e-10 || minimum(result.computer,matrix) < result.value-TOLERANCE) throw new Error('Equilibrium solver failed numerical check');
    matrix.forEach(Object.freeze); Object.freeze(matrix); Object.freeze(result.computer); Object.freeze(result.human); Object.freeze(result);
    this.queries.set(key,result);
    if (this.queries.size > 5000) this.queries.delete(this.queries.keys().next().value);
    return result;
  }
  close() {
    if (this.closed) return;
    for (const array of this.arrays) fs.closeSync(array.fd);
    this.blocks.clear(); this.queries.clear(); this.closed = true;
  }
}
module.exports = { Equilibrium };
