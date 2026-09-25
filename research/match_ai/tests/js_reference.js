// Read-only reference bridge: production JS rules remain the source of truth.
const fs = require('fs');
const G = require('../../../public/js/game.js');
const M = require('../../../public/js/match.js');
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(cases.map(c => {
  const r = G.step(c.bc, c.bh, c.a, c.b);
  const capped = r.winner === -1 && c.turn >= 100;
  if (r.winner === -1 && !capped) return { win:-1, bc:r.b1, bh:r.b2 };
  const win = capped ? 0 : r.winner;
  const f = M.finalBullets(c.bc,c.bh,c.a,c.b,win);
  const s = M.settleRoundMoney(c.mc,c.mh,c.pc,c.ph,win,f.b1,f.b2);
  const over = M.checkMatchOver(s.money1,s.money2,c.round);
  return {win, final:[f.b1,f.b2], money:[s.money1,s.money2],
    transfer:win===2 ? -s.transfer : s.transfer, over:over.over,
    score:over.winner===1 ? 1 : over.winner===2 ? 0 : .5};
})));
