/* AI 移植正确性验证（Node 运行，无需浏览器）：node test/verify_ai.js
 *
 * 第 1 层：日志无关检查
 *   1a. V(0,0) = 0.49483569（1e-12）
 *   1b. 均衡策略：非终态行和 = 1 且不可行动作为 0（comp / player 两表）
 *   1c. 空日志不变量：所有状态最终策略 == 电脑均衡策略（精确）
 *   1d. 值迭代机制：以后验=玩家均衡策略（零样本精确版）跑值迭代 → V_br 复现 V_values（1e-3 内，
 *       零和博弈纳什均衡处最佳响应值 == 均衡值，容差吸收 LP 求解误差）
 *
 * 第 2 层：日志相关检查（用户现有 game_log.txt）
 *   差桶样本量、随机检测触发状态、已知开枪率（2026-09-03 按局数降权后重校准：
 *   (1,1) 6.6% / (2,2) 59.6% / (4,4) 73.2%，日志持续增长允许 ±3pp 漂移）
 *
 * 第 3 层：最强对照（需先运行 python tools/gen_reference.py 生成 reference.json）
 *   最终策略概率逐状态 diff < 1e-6；br_policy 差异状态数应为 0
 */
'use strict';

const fs = require('fs');
const path = require('path');

const Game = require('../public/js/game.js');
const Strategies = require('../public/strategies.js');
const AI = require('../public/js/ai.js');

const MB = Game.MAX_BULLET;
const LOG_PATH = process.env.LOG_PATH ||
  path.join(__dirname, '..', '..', 'Game_XiBuNiuZai', 'game_log.txt');
const REF_PATH = path.join(__dirname, 'reference.json');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  [通过] ' + msg);
  else { console.error('  [失败] ' + msg); failures++; }
}

// ================= 第 1 层：日志无关 =================
console.log('== 第 1 层：日志无关检查 ==');

check(Math.abs(Strategies.V_values[0][0] - 0.49483569) < 1e-12, '1a. V(0,0) = 0.49483569');

let rowOk = true;
for (let b1 = 0; b1 <= MB; b1++) {
  for (let b2 = 0; b2 <= MB; b2++) {
    if (Game.isTerminal(b1, b2)) continue;
    // 不可行动作按各表自身的行动方子弹判断：comp 表按 b2，player 表按 b1
    const feasComp = Game.feasible(b2);
    const feasCompSet = {};
    feasComp.forEach(a => { feasCompSet[a] = true; });
    const feasPlayer = Game.feasible(b1);
    const feasPlayerSet = {};
    feasPlayer.forEach(a => { feasPlayerSet[a] = true; });
    for (const item of [
      { table: Strategies.eq_policy_comp, set: feasCompSet, name: 'comp' },
      { table: Strategies.eq_policy_player, set: feasPlayerSet, name: 'player' }
    ]) {
      let s = 0;
      for (let a = 0; a < 3; a++) {
        const v = item.table[b1][b2][a];
        if (!item.set[a] && Math.abs(v) > 1e-9) rowOk = false;
        s += v;
      }
      if (Math.abs(s - 1.0) > 1e-6) rowOk = false;
    }
  }
}
check(rowOk, '1b. 均衡策略：非终态行和 = 1 且不可行动作为 0（comp 按 b2、player 按 b1 判可行性）');

// 空日志不变量：w=0 → w_bayes=0 → 最终策略不混入任何 BR 质量。
// （C++ 原样行为：最终输出经全 3 动作重归一，LP 解 %.8f 打印使行和 ≈1±1e-8，
//   重归一引入 ~1e-8 扰动——容差取 1e-6 即可捕获任何实质性的 BR 混入。）
const emptySession = AI.buildAiSession('', Strategies);
let eqInvariant = true, eqMaxDiff = 0;
for (let b1 = 0; b1 <= MB; b1++) {
  for (let b2 = 0; b2 <= MB; b2++) {
    if (Game.isTerminal(b1, b2)) continue;
    const p = AI.computeFinalStrategy(emptySession, b1, b2);
    for (let a = 0; a < 3; a++) {
      eqMaxDiff = Math.max(eqMaxDiff, Math.abs(p[a] - Strategies.eq_policy_comp[b1][b2][a]));
      if (Math.abs(p[a] - Strategies.eq_policy_comp[b1][b2][a]) > 1e-6) eqInvariant = false;
    }
  }
}
check(eqInvariant, '1c. 空日志不变量：最终策略 == 电脑均衡策略（最大差 ' + eqMaxDiff.toExponential(2) + '，仅重归一致）');

// 值迭代机制：post := eq_player（零样本精确版，无 Laplace 扰动）
const exactPost = [];
for (let b1 = 0; b1 <= MB; b1++) {
  exactPost[b1] = [];
  for (let b2 = 0; b2 <= MB; b2++) {
    exactPost[b1][b2] = [0, 0, 0];
    if (Game.isTerminal(b1, b2)) continue;
    const feas = Game.feasible(b1);
    let s = 0;
    feas.forEach(h => { s += Strategies.eq_policy_player[b1][b2][h]; });
    feas.forEach(h => { exactPost[b1][b2][h] = Strategies.eq_policy_player[b1][b2][h] / s; });
  }
}
const brExact = AI.computeBestResponse(exactPost, Strategies.eq_policy_comp, Strategies.V_values);
let vIterOk = true, maxVErr = 0;
for (let b1 = 0; b1 <= MB; b1++) {
  for (let b2 = 0; b2 <= MB; b2++) {
    if (Game.isTerminal(b1, b2)) continue;
    maxVErr = Math.max(maxVErr, Math.abs(brExact.Vbr[b1][b2] - Strategies.V_values[b1][b2]));
    if (Math.abs(brExact.Vbr[b1][b2] - Strategies.V_values[b1][b2]) > 1e-3) vIterOk = false;
  }
}
check(vIterOk, '1d. 值迭代机制：BR(均衡玩家) 的 V_br 复现 V_values（最大误差 ' + maxVErr.toExponential(2) + ' < 1e-3）');

// 记忆管线：空日志不变量（记忆模型 = 均衡 → 无切换，所有记忆单元输出生产策略 = 均衡）
let memInvariant = true, memMaxDiff = 0;
for (let b1 = 0; b1 <= MB; b1++) {
  for (let b2 = 0; b2 <= MB; b2++) {
    if (Game.isTerminal(b1, b2)) continue;
    for (let mi = 0; mi < 10; mi++) {
      const p = AI.computeFinalStrategyMem(emptySession, b1, b2, mi);
      for (let a = 0; a < 3; a++) {
        memMaxDiff = Math.max(memMaxDiff, Math.abs(p[a] - Strategies.eq_policy_comp[b1][b2][a]));
        if (Math.abs(p[a] - Strategies.eq_policy_comp[b1][b2][a]) > 1e-6) memInvariant = false;
      }
    }
  }
}
check(memInvariant, '1e. 空日志不变量（记忆版）：全部 300 增广状态最终策略 == 电脑均衡策略（最大差 ' + memMaxDiff.toExponential(2) + '）');

// 增广求解器自检：均衡策略 vs 均衡玩家 → V(0,0,start) ≈ 0.49483569
// （均衡表 8 位小数截断经 γ=0.999 放大 ~1e-5，容差取 1e-4）
const eqAugComp = [], eqAugPlayer = [];
for (let b1 = 0; b1 <= MB; b1++) {
  eqAugComp[b1] = [];
  eqAugPlayer[b1] = [];
  for (let b2 = 0; b2 <= MB; b2++) {
    eqAugComp[b1][b2] = [];
    eqAugPlayer[b1][b2] = [];
    for (let mi = 0; mi < 10; mi++) {
      eqAugComp[b1][b2][mi] = Strategies.eq_policy_comp[b1][b2].slice();
      eqAugPlayer[b1][b2][mi] = Strategies.eq_policy_player[b1][b2].slice();
    }
  }
}
const VaugEq = AI.evaluateAug(eqAugComp, eqAugPlayer, AI.GAMMA);
const vStart = VaugEq[AI.AUG_IDX[0][0][0]];
check(Math.abs(vStart - 0.49483569) < 1e-4, '1f. 增广求解器自检：均衡 vs 均衡 V(0,0,start) = ' + vStart.toFixed(8) + '（容差 1e-4）');

// ================= 第 2 层：日志相关 =================
console.log('== 第 2 层：日志相关检查（' + LOG_PATH + '）==');
if (fs.existsSync(LOG_PATH)) {
  const logText = fs.readFileSync(LOG_PATH, 'utf8');
  const session = AI.buildAiSession(logText, Strategies);

  console.log('  差桶样本量（桶 d≤-3..≥+3 × 支撑 [0弹, 非0弹]）：');
  for (let bk = 0; bk < 7; bk++) {
    console.log('    桶' + bk + ': [' + session.poolTotal[bk][0].toFixed(2) + ', ' + session.poolTotal[bk][1].toFixed(2) + ']');
  }
  console.log('  随机检测触发状态（b1,b2,JS）：' + JSON.stringify(session.loaded.fired));
  // 按局数降权后（2026-09-03）：(1,1) 权重 6.60 仍触发（JS=0.0236）；
  // (3,1) 等旧样本权重已低于门槛 20，不再检查——符合局数降权预期。
  const firedFlat = session.loaded.fired.map(f => f[0] + ',' + f[1]).sort().join(' ');
  const b11Weight = session.loaded.totalWeight[1][1];
  console.log('  (1,1) 降权后权重 = ' + b11Weight.toFixed(2) + '（原始 ' + session.loaded.rawTotal[1][1].toFixed(2) + '）');
  check(firedFlat.indexOf('1,1') !== -1, '2a. 随机检测触发状态包含 (1,1)（实际：' + (firedFlat || '无') + '）');
  const allFiredBelowThreshold = session.loaded.fired.every(f => f[2] < AI.RANDOM_JS_THRESHOLD);
  check(allFiredBelowThreshold, '2a\'. 所有触发状态 JS < 0.03（阈值一致性）');

  const known = { '1,1': 0.066, '2,2': 0.596, '4,4': 0.732 };
  for (const key of Object.keys(known)) {
    const b1 = +key.split(',')[0], b2 = +key.split(',')[1];
    const p = AI.computeFinalStrategy(session, b1, b2);
    const shoot = p[Game.ACT_U];
    console.log('  (' + key + ') 开枪率 = ' + (shoot * 100).toFixed(1) + '%（基准 ' + (known[key] * 100).toFixed(1) + '%）');
    check(Math.abs(shoot - known[key]) <= 0.03, '2b. (' + key + ') 开枪率与基准差 ≤3pp');
  }
} else {
  console.log('  日志不存在，跳过第 2 层');
}

// ================= 第 3 层：最强对照 =================
console.log('== 第 3 层：与 evaluation.py 参照 diff ==');
if (fs.existsSync(REF_PATH) && fs.existsSync(LOG_PATH)) {
  const ref = JSON.parse(fs.readFileSync(REF_PATH, 'utf8'));
  const logText = fs.readFileSync(LOG_PATH, 'utf8');
  // 权重按对局数量降权（与时间无关），参照数据可直接逐状态对比
  const session = AI.buildAiSession(logText, Strategies);
  let maxDiff = 0, brDiff = 0, states = 0;
  let maxVbrDiff = 0, maxVeqDiff = 0, gateMismatch = 0;
  const brDiffStates = [], gateMismatchStates = [];
  for (let b1 = 0; b1 <= MB; b1++) {
    for (let b2 = 0; b2 <= MB; b2++) {
      if (Game.isTerminal(b1, b2)) continue;
      states++;
      // 值表差异（精确线性解 vs δ<1e-7 值迭代）
      maxVbrDiff = Math.max(maxVbrDiff, Math.abs(session.Vbr[b1][b2] - ref.V_br[b1][b2]));
      maxVeqDiff = Math.max(maxVeqDiff, Math.abs(session.Veq[b1][b2] - ref.V_eqm[b1][b2]));
      // ε 门槛一致性（门槛附近微小值差可能翻转门槛，单独统计）
      const gateJS = session.Vbr[b1][b2] - session.Veq[b1][b2] > AI.EV_ADVANTAGE_EPSILON;
      const gatePY = ref.V_br[b1][b2] - ref.V_eqm[b1][b2] > AI.EV_ADVANTAGE_EPSILON;
      if (gateJS !== gatePY) { gateMismatch++; gateMismatchStates.push('(' + b1 + ',' + b2 + ')'); }
      // 策略概率（仅比较门槛一致的状体；若门槛全一致则覆盖全部）
      if (gateJS === gatePY) {
        const p = AI.computeFinalStrategy(session, b1, b2);
        for (let a = 0; a < 3; a++) {
          maxDiff = Math.max(maxDiff, Math.abs(p[a] - ref.comp[b1][b2][a]));
        }
      }
      if (ref.br[b1][b2] !== session.brPolicy[b1][b2]) {
        brDiff++;
        brDiffStates.push('(' + b1 + ',' + b2 + ')');
      }
    }
  }
  check(states === 30, '3a. 非终态状态数 30（实际 ' + states + '）');
  check(maxVbrDiff < 1e-4, '3b. V_br 最大差 ' + maxVbrDiff.toExponential(2) + ' < 1e-4（值迭代 vs 精确解）');
  check(maxVeqDiff < 1e-4, '3c. V_eq 最大差 ' + maxVeqDiff.toExponential(2) + ' < 1e-4');
  check(gateMismatch === 0, '3d. ε 门槛一致（差异 ' + gateMismatch + ' 个' + (gateMismatch ? '：' + gateMismatchStates.join(' ') : '') + '）');
  check(maxDiff < 1e-6, '3e. 最终策略概率最大差 ' + maxDiff.toExponential(3) + ' < 1e-6');
  check(brDiff === 0, '3f. br_policy 全状态一致（差异 ' + brDiff + ' 个' + (brDiff ? '：' + brDiffStates.join(' ') + '（近似平局处，需人工核对）' : '') + '）');

  // ---- 记忆-1 增广管线 diff（2026-09-05，升级式设计） ----
  if (ref.br_mem) {
    let brMemDiff = 0, maxVbrMemDiff = 0, maxVblMemDiff = 0, memSwitchDiff = 0, maxCompMemDiff = 0;
    let cells = 0;
    const memSwitchDiffCells = [];
    for (let b1 = 0; b1 <= MB; b1++) {
      for (let b2 = 0; b2 <= MB; b2++) {
        if (Game.isTerminal(b1, b2)) continue;
        for (let mi = 0; mi < 10; mi++) {
          cells++;
          if (session.brMem[b1][b2][mi] !== ref.br_mem[b1][b2][mi]) brMemDiff++;
          maxVbrMemDiff = Math.max(maxVbrMemDiff, Math.abs(session.VbrMem[b1][b2][mi] - ref.V_br_mem[b1][b2][mi]));
          maxVblMemDiff = Math.max(maxVblMemDiff, Math.abs(session.VblMem[b1][b2][mi] - ref.V_bl_mem[b1][b2][mi]));
          const swJS = session.memAction[b1][b2][mi] >= 0;
          const swPY = ref.V_br_mem[b1][b2][mi] - ref.V_bl_mem[b1][b2][mi] > AI.EV_UPGRADE_EPSILON &&
            ref.bucket_total[AI.diffBucket(b1, b2)][AI.supportType(b1)] >= 1e-9;
          if (swJS !== swPY) { memSwitchDiff++; memSwitchDiffCells.push('(' + b1 + ',' + b2 + ',' + mi + ')'); }
          if (swJS === swPY) {
            const p = AI.computeFinalStrategyMem(session, b1, b2, mi);
            for (let a = 0; a < 3; a++) {
              maxCompMemDiff = Math.max(maxCompMemDiff, Math.abs(p[a] - ref.comp_mem[b1][b2][mi][a]));
            }
          }
        }
      }
    }
    check(cells === 300, '3g. 增广状态数 300（实际 ' + cells + '）');
    check(brMemDiff === 0, '3h. br_mem 全单元一致（差异 ' + brMemDiff + ' 个）');
    check(maxVbrMemDiff < 1e-6, '3i. V_br_mem 最大差 ' + maxVbrMemDiff.toExponential(2) + ' < 1e-6（高斯消元 vs numpy）');
    check(maxVblMemDiff < 1e-6, '3j. V_bl_mem 最大差 ' + maxVblMemDiff.toExponential(2) + ' < 1e-6（高斯消元 vs numpy）');
    check(memSwitchDiff === 0, '3k. 升级式切换决策一致（差异 ' + memSwitchDiff + ' 个' + (memSwitchDiff ? '：' + memSwitchDiffCells.join(' ') : '') + '）');
    check(maxCompMemDiff < 1e-6, '3l. 记忆版最终策略概率最大差 ' + maxCompMemDiff.toExponential(3) + ' < 1e-6');
    let maxPoolDiff = 0;
    for (let bk = 0; bk < 7; bk++) {
      for (let ty = 0; ty < 2; ty++) {
        maxPoolDiff = Math.max(maxPoolDiff, Math.abs(session.poolTotal[bk][ty] - ref.bucket_total[bk][ty]));
      }
    }
    check(maxPoolDiff < 1e-9, '3m. 桶总量与参照一致（最大差 ' + maxPoolDiff.toExponential(2) + '）');
  }
} else {
  console.log('  参照文件 reference.json 或日志不存在，跳过（先运行：python web/tools/gen_reference.py）');
}

console.log(failures === 0 ? '\n全部检查通过 ✔' : '\n有 ' + failures + ' 项检查失败 ✘');
process.exit(failures === 0 ? 0 : 1);
