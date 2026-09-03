/* 西部牛仔 · 一局筹码结算引擎（浏览器 <script> 与 Node require 通用，UMD）
 *
 * "一局" = 最多 5 轮对决。每轮开始双方同时保密选初始子弹 i/j ∈ {0,1,2}，
 * 轮开始时公开，该轮从 (i,j) 开局。规则（用户拍板）：
 *  - 平局轮（双 10 或步数封顶）：双方各 -5×自身所选初始子弹；
 *  - 非平局：末动作特殊规则算轮末子弹（开枪方 -1 恒执行、被打中的装弹 +1 不执行、
 *    胜者装弹 +1 执行、对方若也装弹 +1 执行）；A = 子弹多者，x = |差|；
 *    x=0 不结算（轮次照耗）；y=(i+1)(j+1)x：A 胜 A±y，劣势方(B)胜 ±2y；
 *  - 任一方筹码 ≤0（含双方同时）整局立即结束，钱多者胜、相等平局；5 轮后同。
 *
 * 与 Game.step 的关键差异仅在瞬间胜负（开枪打中装弹）：step 返回子弹不变，
 * 此处开枪方 -1 恒执行——一局结算的 x 必须用本模块 finalBullets。
 *
 * 状态约定同 game.js：b1 = 座位 0（房主），b2 = 座位 1（加入者）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./game.js'));
  else root.Match = factory(root.Game);
})(typeof self !== 'undefined' ? self : this, function (Game) {
  'use strict';

  var MATCH_ROUNDS = 5;    // 一局共 5 轮
  var START_MONEY = 50;    // 初始筹码
  var MAX_PICK = 2;        // 初始子弹可选 0/1/2
  var PICK_PENALTY = 5;    // 平局每颗自选子弹扣款倍数

  /* 末动作特殊规则下的轮末子弹（仅结算用）。
   * b1/b2 = 行动前子弹；a1/a2 = 动作序号；winner: 1|2|0（-1 传 0 仅作防御性退化）。
   * 开枪方 -1 恒执行；装弹 +1 执行条件：胜者恒执行 / 平局双方都执行 / 败者仅当未被开枪击中。
   */
  function finalBullets(b1, b2, a1, a2, winner) {
    var nb1 = b1, nb2 = b2;
    if (a1 === Game.ACT_U) nb1--;
    if (a2 === Game.ACT_U) nb2--;
    if (a1 === Game.ACT_O && (winner === 1 || winner === 0 || a2 !== Game.ACT_U)) nb1++;
    if (a2 === Game.ACT_O && (winner === 2 || winner === 0 || a1 !== Game.ACT_U)) nb2++;
    return { b1: nb1, b2: nb2 };
  }

  /* 单轮筹码结算。
   * winner: 1|2 按子弹差结算；0 平局（双方各 -5×自身所选初始子弹）。
   * fb1/fb2 = finalBullets 结果（仅 winner 1|2 使用）。
   * 返回 { money1, money2, x, y, A, double, transfer, settled }
   *   A = 1|2 子弹多者（winner 0 时为 0）；double = 劣势方胜（±2y）；
   *   settled = false 仅 x=0（不结算，轮次照耗）。
   */
  function settleRoundMoney(money1, money2, pick1, pick2, winner, fb1, fb2) {
    if (winner === 0) {
      return {
        money1: money1 - PICK_PENALTY * pick1,
        money2: money2 - PICK_PENALTY * pick2,
        x: 0, y: 0, A: 0, double: false, transfer: 0, settled: true
      };
    }
    var x = Math.abs(fb1 - fb2);
    if (x === 0) {
      return {
        money1: money1, money2: money2,
        x: 0, y: 0, A: 0, double: false, transfer: 0, settled: false
      };
    }
    var A = fb1 > fb2 ? 1 : 2;
    var y = (pick1 + 1) * (pick2 + 1) * x;
    var double = winner !== A;
    var transfer = double ? 2 * y : y;
    var m1 = money1, m2 = money2;
    if (winner === 1) { m1 += transfer; m2 -= transfer; }
    else { m2 += transfer; m1 -= transfer; }
    return {
      money1: m1, money2: m2,
      x: x, y: y, A: A, double: double, transfer: transfer, settled: true
    };
  }

  /* 整局结束判定（每轮结算后调用；也用于 5 轮自然结束）。
   * 任一方 ≤0（含双方同时）→ 立即结束，钱多者胜、相等平局（winner=0）；
   * 5 轮且双方 >0 → 结束同判。返回 { over, winner }（winner 1|2|0）。
   */
  function checkMatchOver(money1, money2, matchRound) {
    if (money1 <= 0 || money2 <= 0) {
      return { over: true, winner: money1 === money2 ? 0 : (money1 > money2 ? 1 : 2) };
    }
    if (matchRound >= MATCH_ROUNDS) {
      return { over: true, winner: money1 === money2 ? 0 : (money1 > money2 ? 1 : 2) };
    }
    return { over: false, winner: 0 };
  }

  return {
    MATCH_ROUNDS: MATCH_ROUNDS,
    START_MONEY: START_MONEY,
    MAX_PICK: MAX_PICK,
    PICK_PENALTY: PICK_PENALTY,
    finalBullets: finalBullets,
    settleRoundMoney: settleRoundMoney,
    checkMatchOver: checkMatchOver
  };
});
