/* 西部牛仔 · 自适应 AI 管线（浏览器 <script> 与 Node require 通用，UMD）
 *
 * C++ Game_XiBuNiuZai.cpp 的自适应层移植（纯函数，无 DOM / localStorage）：
 *   loadAndProcessLog    → 日志解析/整局缓冲/按局数降权/随机检测降权
 *   buildPoolStats       → 子弹差桶 × 支撑类型合并统计
 *   buildPosterior       → Dirichlet 后验（κ 先验 + Laplace +1，仅可行支撑）
 *   computeBestResponse  → 完整最佳响应（Jacobi 值迭代 ≤20000 次，δ<1e-7）
 *   computeFinalStrategy → 混合决策（w_bayes=w/(w+N0)，ε 门槛）
 *   sampleAction         → 累积采样
 *
 * 权重方案（2026-09-03 用户拍板）：按对局数量降权替代时间衰减——最新一局权重 1，
 * 每往前一局 ×0.95（半衰期 ≈13.5 局），只保留最近 90 局（权重 <1%）。
 * C++ 控制台版仍为时间衰减（保持不动）。随机检测参数为 2026-09-02 放宽后的值：
 * JS 阈值 0.03（原 0.05）、样本门槛 20（原 10）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./game.js'));
  } else {
    root.AI = factory(root.Game);
  }
})(typeof self !== 'undefined' ? self : this, function (Game) {
  'use strict';

  var MB = Game.MAX_BULLET;   // 10
  var NA = 3;

  // 常量（GAMMA 与 C++ 一致；随机检测为放宽后的阈值；权重按局数降权）
  var GAMMA = 0.999;
  var GAME_DECAY_LAMBDA = 0.95;   // 每往前一局权重 ×0.95（半衰期 ≈13.5 局）
  var MAX_KEEP_GAMES = 90;        // 只保留最近 90 局（第 90 局权重 <1%）
  var RANDOM_JS_THRESHOLD = 0.03;
  var RANDOM_DOWNWEIGHT = 0.3;
  var MIN_SAMPLES_FOR_RANDOM_CHECK = 20.0;
  var DIRICHLET_KAPPA = 5.0;
  var N0 = 10.0;
  var EV_ADVANTAGE_EPSILON = 0.05;
  var MAX_ROUNDS_BUFFER = 512;

  function zeros2() {
    var t = [];
    for (var i = 0; i <= MB; i++) t.push(new Array(MB + 1).fill(0));
    return t;
  }
  function zeros3() {
    var t = [];
    for (var i = 0; i <= MB; i++) {
      var r = [];
      for (var j = 0; j <= MB; j++) r.push([0, 0, 0]);
      t.push(r);
    }
    return t;
  }

  /* 玩家经验分布（可行支撑上）与可行支撑均匀分布的 JS 散度 */
  function jsDivergenceToUniform(counts, total, feas) {
    var n = feas.length;
    var p = [0, 0, 0], m = [0, 0, 0];
    for (var k = 0; k < n; k++) {
      var a = feas[k];
      p[a] = counts[a] / total;
      m[a] = 0.5 * (p[a] + 1.0 / n);
    }
    var kl_pm = 0.0, kl_um = 0.0;
    for (k = 0; k < n; k++) {
      var a2 = feas[k];
      if (p[a2] > 1e-12) kl_pm += p[a2] * Math.log(p[a2] / m[a2]);
      kl_um += (1.0 / n) * Math.log((1.0 / n) / m[a2]);
    }
    return 0.5 * (kl_pm + kl_um);
  }

  /* 日志加载（权重按对局数量降权：最新一局权重 1，每往前一局 ×0.95）。
   * logText: 完整日志文本。nowSec 参数仅保留兼容（不再参与计算）。
   * 返回 { rawCount, rawTotal, weightedCount, totalWeight, prunedText, changed, fired }
   *  - 只计入 GAME_END NORMAL 的对局，最多保留最近 90 局（超量旧局裁掉）；
   *  - 中止/无结尾/杂行被裁掉，changed=true 时应将 prunedText 写回存储；
   *  - 只学习玩家动作（电脑动作仅随日志原样保留）。
   */
  function loadAndProcessLog(logText, nowSec) {
    var rawCount = zeros3();
    var rawTotal = zeros2();

    var rounds = [];        // 当前局的回合缓冲
    var inGame = false;
    var gameStartT = 0;
    var games = [];         // 正常结束的完整对局（顺序收集：{startT, endT, rounds}）
    var changed = false;

    var lines = logText.split('\n');
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);  // \r 剥离

      if (line.indexOf('GAME_START') === 0) {
        inGame = true;
        rounds.length = 0;
        gameStartT = parseInt(line.slice(10), 10) || 0;
      } else if (line.indexOf('GAME_END') === 0) {
        var normal = line.indexOf('NORMAL') !== -1;
        var mEnd = line.match(/^GAME_END\s+\S+\s+(\d+)/);
        var endT = mEnd ? parseInt(mEnd[1], 10) : 0;
        if (inGame && normal) {
          games.push({ startT: gameStartT, endT: endT, rounds: rounds.slice() });
        } else {
          changed = true;   // 中止对局/无 START 的 END 行：裁掉
        }
        inGame = false;
      } else if (inGame) {
        // 回合行：b1 b2 pa ca ts
        var m = line.match(/^(\d+)\s+(\d+)\s+(\S)\s+(\S)\s+(\d+)$/);
        if (m && rounds.length < MAX_ROUNDS_BUFFER) {
          rounds.push({ b1: +m[1], b2: +m[2], pa: m[3], ca: m[4], t: +m[5] });
        } else {
          changed = true;   // 局内无法解析的行或超出缓冲
        }
      } else if (line.length > 0) {
        changed = true;     // 游戏之外的杂行：裁掉
      }
    }
    if (inGame) changed = true;   // 文件尾仍处于游戏中：该局丢弃

    // 按对局数量降权：gamesAgo = 距最新一局的局数，tw = 0.95^gamesAgo；
    // 最多保留最近 MAX_KEEP_GAMES 局（超量旧局裁掉，changed 置位以触发写回）
    var keepStart = games.length > MAX_KEEP_GAMES ? games.length - MAX_KEEP_GAMES : 0;
    if (keepStart > 0) changed = true;
    var out = [];           // 裁剪后保留的行（原样时间戳）
    for (var g = keepStart; g < games.length; g++) {
      var gm = games[g];
      var tw = Math.pow(GAME_DECAY_LAMBDA, games.length - 1 - g);
      for (var i = 0; i < gm.rounds.length; i++) {
        var r = gm.rounds[i];
        if (r.b1 < 0 || r.b1 > MB || r.b2 < 0 || r.b2 > MB) continue;
        var pi = Game.charToAction(r.pa);
        if (pi < 0) continue;
        rawCount[r.b1][r.b2][pi] += tw;
        rawTotal[r.b1][r.b2] += tw;
      }
      // 重新序列化保留在裁剪后的日志中
      out.push('GAME_START ' + gm.startT);
      for (var j = 0; j < gm.rounds.length; j++) {
        var rr = gm.rounds[j];
        out.push(rr.b1 + ' ' + rr.b2 + ' ' + rr.pa + ' ' + rr.ca + ' ' + rr.t);
      }
      out.push('GAME_END NORMAL ' + gm.endT);
    }

    // 随机行为检测与降权（在原始加权计数上统一处理）
    var weightedCount = zeros3();
    var totalWeight = zeros2();
    var fired = [];
    for (var b1 = 0; b1 <= MB; b1++) {
      for (var b2 = 0; b2 <= MB; b2++) {
        var total = rawTotal[b1][b2];
        if (total < 1e-9) continue;
        var downweight = 1.0;
        if (total >= MIN_SAMPLES_FOR_RANDOM_CHECK && !Game.isTerminal(b1, b2)) {
          var feas = Game.feasible(b1);
          if (feas.length >= 2) {
            var js = jsDivergenceToUniform(rawCount[b1][b2], total, feas);
            if (js < RANDOM_JS_THRESHOLD) {
              downweight = RANDOM_DOWNWEIGHT;
              fired.push([b1, b2, js]);
            }
          }
        }
        for (var a = 0; a < NA; a++) weightedCount[b1][b2][a] = rawCount[b1][b2][a] * downweight;
        totalWeight[b1][b2] = total * downweight;
      }
    }

    return {
      rawCount: rawCount,
      rawTotal: rawTotal,
      weightedCount: weightedCount,
      totalWeight: totalWeight,
      prunedText: out.length ? out.join('\n') + '\n' : '',
      changed: changed,
      fired: fired
    };
  }

  /* 子弹差桶：d = b2 - b1 → ≤-3, -2, -1, 0, +1, +2, ≥+3 共 7 桶 */
  function diffBucket(b1, b2) {
    var d = b2 - b1;
    if (d <= -3) return 0;
    if (d === -2) return 1;
    if (d === -1) return 2;
    if (d === 0) return 3;
    if (d === 1) return 4;
    if (d === 2) return 5;
    return 6;
  }

  /* 支撑类型：b1==0 时玩家不能开枪（可行动作支撑不同，需分开统计） */
  function supportType(b1) {
    return b1 === 0 ? 0 : 1;
  }

  /* 差桶合并统计（对全部非终态求和） */
  function buildPoolStats(weightedCount, totalWeight) {
    var poolCount = [], poolTotal = [];
    for (var bk = 0; bk < 7; bk++) {
      poolCount.push([[0, 0, 0], [0, 0, 0]]);
      poolTotal.push([0, 0]);
    }
    for (var b1 = 0; b1 <= MB; b1++) {
      for (var b2 = 0; b2 <= MB; b2++) {
        if (Game.isTerminal(b1, b2)) continue;
        var bk = diffBucket(b1, b2), ty = supportType(b1);
        for (var a = 0; a < NA; a++) poolCount[bk][ty][a] += weightedCount[b1][b2][a];
        poolTotal[bk][ty] += totalWeight[b1][b2];
      }
    }
    return { poolCount: poolCount, poolTotal: poolTotal };
  }

  /* Dirichlet 后验（仅可行支撑上有质量）：
   * alpha[h] = κ · eq_player[h] + 1（Laplace +1 内嵌）
   * post[h] = (cnt[h] + alpha[h]) / (w + α_sum)，w = 差桶总量
   */
  function buildPosterior(poolCount, poolTotal, eqPlayer) {
    var post = zeros3();
    for (var b1 = 0; b1 <= MB; b1++) {
      for (var b2 = 0; b2 <= MB; b2++) {
        if (Game.isTerminal(b1, b2)) continue;
        var feas = Game.feasible(b1);
        var alpha = [0, 0, 0], alphaSum = 0.0;
        for (var k = 0; k < feas.length; k++) {
          var h = feas[k];
          alpha[h] = DIRICHLET_KAPPA * eqPlayer[b1][b2][h] + 1.0;
          alphaSum += alpha[h];
        }
        var bk = diffBucket(b1, b2), ty = supportType(b1);
        var w = poolTotal[bk][ty];
        var cnt = poolCount[bk][ty];
        for (k = 0; k < feas.length; k++) {
          var h2 = feas[k];
          post[b1][b2][h2] = (cnt[h2] + alpha[h2]) / (w + alphaSum);
        }
      }
    }
    return post;
  }

  /* 完整最佳响应（C++ compute_best_response 逐行移植，Jacobi 值迭代）：
   *  - V_br / V_eq_vs_model 初始化为均衡值 V_values（终态保持 0）；
   *  - ≤20000 次同步迭代，两表同扫，delta < 1e-7 早退；
   *  - 收敛后贪婪提取最佳响应行动（严格 >，平局取可行序 [i,u,o] 最早）。
   */
  function computeBestResponse(post, eqComp, Vvalues) {
    var Vbr = zeros2(), Veq = zeros2();
    var brPolicy = zeros2int();
    for (var b1 = 0; b1 <= MB; b1++) {
      for (var b2 = 0; b2 <= MB; b2++) {
        if (Game.isTerminal(b1, b2)) continue;
        Vbr[b1][b2] = Vvalues[b1][b2];
        Veq[b1][b2] = Vvalues[b1][b2];
      }
    }

    var tmpBr = zeros2(), tmpEq = zeros2();
    for (var iter = 0; iter < 20000; iter++) {
      var delta = 0.0;
      for (var b1 = 0; b1 <= MB; b1++) {
        for (var b2 = 0; b2 <= MB; b2++) {
          if (Game.isTerminal(b1, b2)) continue;
          var feasC = Game.feasible(b2);
          var feasP = Game.feasible(b1);

          var best = -1e18;
          for (var ki = 0; ki < feasC.length; ki++) {
            var c = feasC[ki];
            var ev = 0.0;
            for (var kj = 0; kj < feasP.length; kj++) {
              ev += post[b1][b2][feasP[kj]] * Game.stepValue(b1, b2, c, feasP[kj], Vbr, GAMMA);
            }
            if (ev > best) best = ev;
          }
          tmpBr[b1][b2] = best;
          delta = Math.max(delta, Math.abs(best - Vbr[b1][b2]));

          var evEq = 0.0;
          for (ki = 0; ki < feasC.length; ki++) {
            var c2 = feasC[ki];
            var pc = eqComp[b1][b2][c2];
            if (pc <= 0.0) continue;
            var ev2 = 0.0;
            for (var kj = 0; kj < feasP.length; kj++) {
              ev2 += post[b1][b2][feasP[kj]] * Game.stepValue(b1, b2, c2, feasP[kj], Veq, GAMMA);
            }
            evEq += pc * ev2;
          }
          tmpEq[b1][b2] = evEq;
          delta = Math.max(delta, Math.abs(evEq - Veq[b1][b2]));
        }
      }
      // Jacobi 同步更新（整体拷贝）
      for (var b1 = 0; b1 <= MB; b1++) {
        for (var b2 = 0; b2 <= MB; b2++) {
          if (Game.isTerminal(b1, b2)) continue;
          Vbr[b1][b2] = tmpBr[b1][b2];
          Veq[b1][b2] = tmpEq[b1][b2];
        }
      }
      if (delta < 1e-7) break;
    }

    // 由收敛后的值表提取每个状态的最佳响应行动
    for (var b1 = 0; b1 <= MB; b1++) {
      for (var b2 = 0; b2 <= MB; b2++) {
        if (Game.isTerminal(b1, b2)) continue;
        var feasC2 = Game.feasible(b2);
        var feasP2 = Game.feasible(b1);
        var best2 = -1e18, bestc = feasC2[0];
        for (var ki = 0; ki < feasC2.length; ki++) {
          var c3 = feasC2[ki];
          var ev3 = 0.0;
          for (var kj = 0; kj < feasP2.length; kj++) {
            ev3 += post[b1][b2][feasP2[kj]] * Game.stepValue(b1, b2, c3, feasP2[kj], Vbr, GAMMA);
          }
          if (ev3 > best2) { best2 = ev3; bestc = c3; }
        }
        brPolicy[b1][b2] = bestc;
        Vbr[b1][b2] = best2;
      }
    }

    return { Vbr: Vbr, Veq: Veq, brPolicy: brPolicy };
  }

  function zeros2int() {
    var t = [];
    for (var i = 0; i <= MB; i++) t.push(new Array(MB + 1).fill(0));
    return t;
  }

  /* 混合决策（C++ compute_final_strategy 逐行移植）：
   *  - w = 差桶总量（玩家侧桶），w_bayes = w / (w + N0)；
   *  - 模型优势 V_br - V_eq_vs_model ≤ ε 时不启用利用（w_bayes = 0）；
   *  - final = (1-w_bayes)·eq_comp + w_bayes·onehot(br)，负值钳 0，全 3 动作重归一。
   */
  function computeFinalStrategy(session, b1, b2) {
    var feasible = Game.feasible(b2);   // 电脑自己的可行动作
    var w = session.poolTotal[diffBucket(b1, b2)][supportType(b1)];
    var wBayes = w / (w + N0);

    var advantage = session.Vbr[b1][b2] - session.Veq[b1][b2];
    if (advantage <= EV_ADVANTAGE_EPSILON) wBayes = 0.0;

    var finalProb = [0, 0, 0];
    for (var fi = 0; fi < feasible.length; fi++) {
      var a = feasible[fi];
      var eqProb = session.eqComp[b1][b2][a];
      if (eqProb < 0.0) eqProb = 0.0;   // -0.0 等数值伪影
      var brProb = (a === session.brPolicy[b1][b2]) ? 1.0 : 0.0;
      finalProb[a] = (1.0 - wBayes) * eqProb + wBayes * brProb;
    }

    var sum = finalProb[0] + finalProb[1] + finalProb[2];
    if (sum > 1e-12) {
      finalProb[0] /= sum;
      finalProb[1] /= sum;
      finalProb[2] /= sum;
    } else {
      for (fi = 0; fi < feasible.length; fi++) finalProb[feasible[fi]] = 1.0 / feasible.length;
    }
    return finalProb;
  }

  /* 累积采样（C++ sample_action 逐行移植），兜底装弹 */
  function sampleAction(prob) {
    var r = Math.random();
    var cum = 0.0;
    for (var i = 0; i < NA; i++) {
      cum += prob[i];
      if (r <= cum) return i;
    }
    return Game.ACT_O;
  }

  /* 页面加载时的一次性管线（C++ main 启动序列）：
   * 载入日志 → 差桶统计 → 后验 → 完整最佳响应 → 打包会话
   */
  function buildAiSession(logText, strategies) {
    var loaded = loadAndProcessLog(logText);
    var pool = buildPoolStats(loaded.weightedCount, loaded.totalWeight);
    var post = buildPosterior(pool.poolCount, pool.poolTotal, strategies.eq_policy_player);
    var br = computeBestResponse(post, strategies.eq_policy_comp, strategies.V_values);
    return {
      post: post,
      Vbr: br.Vbr,
      Veq: br.Veq,
      brPolicy: br.brPolicy,
      poolTotal: pool.poolTotal,
      eqComp: strategies.eq_policy_comp,
      eqPlayer: strategies.eq_policy_player,
      loaded: loaded
    };
  }

  return {
    // 常量（供验证与调试读取）
    GAMMA: GAMMA,
    GAME_DECAY_LAMBDA: GAME_DECAY_LAMBDA,
    MAX_KEEP_GAMES: MAX_KEEP_GAMES,
    RANDOM_JS_THRESHOLD: RANDOM_JS_THRESHOLD,
    RANDOM_DOWNWEIGHT: RANDOM_DOWNWEIGHT,
    MIN_SAMPLES_FOR_RANDOM_CHECK: MIN_SAMPLES_FOR_RANDOM_CHECK,
    DIRICHLET_KAPPA: DIRICHLET_KAPPA,
    N0: N0,
    EV_ADVANTAGE_EPSILON: EV_ADVANTAGE_EPSILON,
    MAX_ROUNDS_BUFFER: MAX_ROUNDS_BUFFER,
    // 函数
    jsDivergenceToUniform: jsDivergenceToUniform,
    loadAndProcessLog: loadAndProcessLog,
    diffBucket: diffBucket,
    supportType: supportType,
    buildPoolStats: buildPoolStats,
    buildPosterior: buildPosterior,
    computeBestResponse: computeBestResponse,
    computeFinalStrategy: computeFinalStrategy,
    sampleAction: sampleAction,
    buildAiSession: buildAiSession
  };
});
