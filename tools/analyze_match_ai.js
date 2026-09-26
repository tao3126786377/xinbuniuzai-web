'use strict';
const fs = require('fs');
function analyse(log) {
  if (log.schema !== 'xnz-match-diagnostics-v1' || !Array.isArray(log.games)) throw Error('Expected full-match diagnostic export');
  let totalEvents = 0, count = 0, nll = 0, brier = 0, uniformNll = 0, limited = 0, fallback = 0, invalid = 0;
  const rows = [], modes = {}, byPhase = {}, policyCounts = {}, sources = {};
  for (const game of log.games) {
    sources[game.source || 'unknown'] = (sources[game.source || 'unknown'] || 0)+1;
    policyCounts[game.policy || 'unknown'] = (policyCounts[game.policy || 'unknown'] || 0)+1;
    for (const [i,event] of game.events.entries()) {
      totalEvents++;
      const d = event.decision?.diagnostics, p = d?.humanPrediction;
      if (!d) continue; // Older saved games have no forecasts: never fabricate them.
      modes[d.mode] = (modes[d.mode] || 0)+1;
      fallback += Number(Boolean(d.fallbackReason) || d.numericalFallbacks > 0);
      if (!p) continue;
      const h = event.human;
      if (!Array.isArray(p) || p.length !== 3 || ![0,1,2].includes(h) || p.some(x=>!Number.isFinite(x)||x<0) || Math.abs(p.reduce((a,b)=>a+b,0)-1)>1e-8) { invalid++; continue; }
      // Recompute against the actual public action; do not trust saved summary metrics.
      const loss = -Math.log(Math.max(p[h],1e-12)), bs = p.reduce((s,v,a)=>s+(v-Number(a===h))**2,0);
      const legalCount = event.before.phase === 'pick' ? 3 : 1+Number(event.before.bh>0)+Number(event.before.bh<10);
      nll += loss; brier += bs; uniformNll += Math.log(legalCount); count++; limited += Number(d.safetyLimited);
      const phase = event.before.phase, bucket = byPhase[phase] || (byPhase[phase] = {n:0,nll:0}); bucket.n++; bucket.nll += loss;
      rows.push({game:game.id,event:i+1,round:event.before.round,turn:event.before.turn,phase,human:h,
        observedProbability:p[h],nll:loss,actionScoreRange:d.actionScoreRange,
        distanceFromEquilibrium:d.distanceFromEquilibrium,safetyLimited:d.safetyLimited,
        estimatedGainOverEquilibrium:d.estimatedGainOverEquilibrium});
    }
  }
  for (const group of Object.values(byPhase)) group.nll /= group.n;
  rows.sort((a,b)=>b.nll-a.nll);
  return {schema:'xnz-match-analysis-v1',games:log.games.length,sources,policies:policyCounts,totalEvents,
    forecasts:count,invalidForecasts:invalid,meanNll:count ? nll/count : null,meanBrier:count ? brier/count : null,
    uniformMeanNll:count ? uniformNll/count : null,safetyLimited:limited,fallbackDecisions:fallback,modes,byPhase,
    largestPredictionMisses:rows.slice(0,20),
    interpretation:'Descriptive diagnostics only. High surprise plus changed action distribution is a review lead, not causal proof or a match-score loss. Old events without forecasts are excluded. No independent-event confidence intervals.'};
}
module.exports = {analyse};
if (require.main === module) {
  if (!process.argv[2]) { console.error('Usage: node tools/analyze_match_ai.js xnz_match_diagnostics.json'); process.exitCode = 1; }
  else console.log(JSON.stringify(analyse(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))),null,2));
}
