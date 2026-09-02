/* 西部牛仔 · 共享对局引擎（浏览器 <script> 与 Node require 通用，UMD）
 *
 * 规则与 C++ Game_XiBuNiuZai.cpp 主循环逐行一致：
 *  - 瞬间胜负（一方开枪、另一方装弹）优先判定，且子弹数不变；
 *  - 否则执行子弹增减（开枪 -1、装弹 +1），再查终局；
 *  - 双方都到 10：平局；一方 ≥5 且严格大于对方：该方胜；
 *  - 可行动作顺序恒为 [i, u, o]（最佳响应平局决胜依赖此顺序）；
 *  - 单回合上限由调用方检查（MAX_ROUNDS，非终止结算后检查）。
 *
 * 状态约定：b1 = 座位 0（PvP 房主 / AI 模式玩家）子弹，b2 = 座位 1（加入者 / 电脑）子弹。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Game = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_BULLET = 10;
  var MAX_ROUNDS = 100;

  var ACT_U = 0, ACT_I = 1, ACT_O = 2;
  var ACT_CHARS = ['u', 'i', 'o'];

  function charToAction(ch) {
    if (ch === 'u') return ACT_U;
    if (ch === 'i') return ACT_I;
    if (ch === 'o') return ACT_O;
    return -1;
  }

  function isTerminal(b1, b2) {
    if (b1 >= MAX_BULLET && b2 >= MAX_BULLET) return true;  // 双方都到10：平局
    if (b1 >= 5 && b1 > b2) return true;                    // b1 方胜
    if (b2 >= 5 && b2 > b1) return true;                    // b2 方胜
    return false;
  }

  function isDraw(b1, b2) {
    return b1 >= MAX_BULLET && b2 >= MAX_BULLET;
  }

  /* 可行动作，恒为 [i, u, o] 顺序（平局决胜依赖此顺序） */
  function feasible(bullets) {
    var acts = [ACT_I];
    if (bullets > 0) acts.push(ACT_U);
    if (bullets < MAX_BULLET) acts.push(ACT_O);
    return acts;
  }

  function isFeasible(bullets, a) {
    if (a === ACT_I) return true;
    if (a === ACT_U) return bullets > 0;
    if (a === ACT_O) return bullets < MAX_BULLET;
    return false;
  }

  /* 一回合结算（中性视角）。
   * 返回 { winner, b1, b2, instant }
   *   winner: 1 = b1 方胜，2 = b2 方胜，0 = 平局，-1 = 继续
   *   b1/b2: 结算后子弹数（瞬间胜负时不变，与 C++ 一致）
   *   instant: 是否瞬间胜负（开枪打中装弹）
   */
  function step(b1, b2, a1, a2) {
    if (a1 === ACT_U && a2 === ACT_O) return { winner: 1, b1: b1, b2: b2, instant: true };
    if (a1 === ACT_O && a2 === ACT_U) return { winner: 2, b1: b1, b2: b2, instant: true };

    var nb1 = b1, nb2 = b2;
    if (a1 === ACT_U) nb1--;
    if (a2 === ACT_U) nb2--;
    if (a1 === ACT_O) nb1++;
    if (a2 === ACT_O) nb2++;

    if (nb1 >= MAX_BULLET && nb2 >= MAX_BULLET) return { winner: 0, b1: nb1, b2: nb2, instant: false };
    if (nb1 >= 5 && nb1 > nb2) return { winner: 1, b1: nb1, b2: nb2, instant: false };
    if (nb2 >= 5 && nb2 > nb1) return { winner: 2, b1: nb1, b2: nb2, instant: false };
    return { winner: -1, b1: nb1, b2: nb2, instant: false };
  }

  /* 单步期望值（电脑视角，供 AI 管线使用）。c = 电脑动作（电脑持有 b2），h = 玩家动作（玩家持有 b1）。
   * 返回电脑收益：胜 1.0 / 负 0.0 / 平 0.5 / 继续 GAMMA * V[nb1][nb2]
   */
  function stepValue(b1, b2, c, h, V, gamma) {
    if (c === ACT_U && h === ACT_O) return 1.0;  // 电脑开枪打中装弹玩家
    if (h === ACT_U && c === ACT_O) return 0.0;  // 玩家开枪打中装弹电脑

    var nb1 = b1, nb2 = b2;
    if (h === ACT_U) nb1--;
    else if (h === ACT_O) nb1++;
    if (c === ACT_U) nb2--;
    else if (c === ACT_O) nb2++;

    if (nb1 >= MAX_BULLET && nb2 >= MAX_BULLET) return 0.5;  // 平局
    if (nb1 >= 5 && nb1 > nb2) return 0.0;                    // 玩家胜
    if (nb2 >= 5 && nb2 > nb1) return 1.0;                    // 电脑胜
    return gamma * V[nb1][nb2];
  }

  return {
    MAX_BULLET: MAX_BULLET,
    MAX_ROUNDS: MAX_ROUNDS,
    ACT_U: ACT_U,
    ACT_I: ACT_I,
    ACT_O: ACT_O,
    ACT_CHARS: ACT_CHARS,
    charToAction: charToAction,
    isTerminal: isTerminal,
    isDraw: isDraw,
    feasible: feasible,
    isFeasible: isFeasible,
    step: step,
    stepValue: stepValue
  };
});
