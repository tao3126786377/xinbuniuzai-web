/* 西部牛仔 · 人机对战模式（完全客户端运行，无需服务器）
 *
 * AI 管线（含记忆-1 升级式）由 AI.buildAiSession 在每局开始前用最新日志统一构建，
 * 局内复用；AI 在玩家出招前采样（保持同时性与"不偷看"性质）；
 * 日志存 localStorage，格式与 C++ game_log.txt 完全一致。
 *
 * 对局归属纪律（2026-09-05 修复）：出招后的揭示/结算定时器全部捕获本回合的
 * 对局对象 g，回调时校验 module 级 game 仍指向 g——防止"揭示 1.5 秒内离开并
 * 重开新局"时旧定时器污染新对局（曾导致空对局 GAME_START+END 与记录错位）。
 */
(function () {
  'use strict';

  var LOG_KEY = 'xnz_log_v1';

  var session = null;   // AI 会话（后验/BR/桶总量/记忆管线）
  var logText = '';     // 当前日志文本（内存镜像，追加后写回）
  var game = null;      // 当前对局状态
  var loading = false; // 防止模型构建前重复开局

  function nowSec() { return Math.floor(Date.now() / 1000); }

  function saveLog() {
    try {
      localStorage.setItem(LOG_KEY, logText);
    } catch (e) {
      // 配额不足/隐私模式：清空重来，AI 退回纯均衡
      logText = '';
      try { localStorage.setItem(LOG_KEY, ''); } catch (e2) { /* 忽略 */ }
      App.toast('AI 记忆存储失败，已重置（游戏不受影响）');
    }
  }

  /* 刷新主菜单统计脚注（分模式对局数与胜率，见 stats.js） */
  function refreshMemoryNote() {
    Stats.refresh();
  }

  /* 构建 AI 会话（与 C++ main 启动序列一致：日志 → 桶 → 后验 → 最佳响应 → 记忆管线） */
  function buildSession() {
    try { logText = localStorage.getItem(LOG_KEY) || ''; } catch (e) { logText = ''; }
    session = AI.buildAiSession(logText, Strategies);
    if (session.loaded.changed) {
      logText = session.loaded.prunedText;   // 裁剪后写回（等价 C++ 的 dropped_any 重写）
      saveLog();
    }
    refreshMemoryNote();
  }

  /* 菜单进入与再来一局共用开局流程 */
  function enter() {
    startGame();
  }

  /* 每局开始前读取最新日志重建模型，加载期间先让遮罩绘制 */
  function startGame() {
    if (loading) return;
    loading = true;
    game = null;   // 立即使上一局尚未执行的揭示/结算回调失效
    App.setActiveMode('ai');
    App.show('loading-overlay');
    setTimeout(function () {
      try {
        buildSession();
        beginGame();
      } finally {
        loading = false;
        App.hide('loading-overlay');
      }
    }, 50);
  }

  function beginGame() {
    App.setActiveMode('ai');
    game = {
      b1: 0,
      b2: 0,
      round: 1,
      compAction: -1,
      playerActed: false,
      over: false,
      mem: 0,   // 局内记忆单元（0=开局；1..9=上一回合动作对，供记忆-1 升级式决策）
      logLines: ['GAME_START ' + nowSec()]
    };
    App.setText('game-mode-label', '人机对战');
    App.setText('opponent-name', '电脑');
    App.setText('btn-leave-game', '返回主菜单（本局作废）');
    App.clearHistory();
    // 清除一局模式残留的 UI（筹码行 / 选弹面板 / 隐藏的动作区）
    App.hide('my-money-row');
    App.hide('opp-money-row');
    App.hide('pick-area');
    App.show('actions');
    App.showScreen('game');
    startRound(game);
  }

  function startRound(g) {
    g = g || game;
    g.playerActed = false;
    g.compAction = -1;
    App.setText('round-label', '回合 ' + g.round + '/' + Game.MAX_ROUNDS);
    App.updateBullets('my-bullets-num', 'my-bullets-icons', g.b1);
    App.updateBullets('opp-bullets-num', 'opp-bullets-icons', g.b2);
    App.hide('my-action');
    App.hide('opp-action');
    App.setText('my-status', '');
    App.setText('opp-status', '');
    App.hide('banner');
    App.hide('countdown');
    App.setActionButtons({ u: g.b1 > 0, i: true, o: g.b1 < Game.MAX_BULLET });

    // AI 在玩家出招前采样（与 C++ 一致：玩家看不到也影响不了本次 AI 行动）；
    // 记忆-1 升级式：按 (状态, 上一回合动作对) 决策
    var probs = AI.computeFinalStrategyMem(session, g.b1, g.b2, g.mem);
    g.compAction = AI.sampleAction(probs);
  }

  function onAction(a) {
    if (!game || game.over || game.playerActed) return;
    if (!Game.isFeasible(game.b1, a)) return;

    var g = game;   // 本回合归属的对局：揭示/结算定时器期间 game 可能已被替换或置空
    g.playerActed = true;
    var pch = Game.ACT_CHARS[a];
    var cch = Game.ACT_CHARS[g.compAction];

    // 更新局内记忆（下一回合的决策依据）
    g.mem = AI.memIndex(pch, cch);

    // 日志先行（C++ 顺序：结算前写回合行，瞬间胜负回合也写）
    g.logLines.push(g.b1 + ' ' + g.b2 + ' ' + pch + ' ' + cch + ' ' + nowSec());

    App.lockActionButtons();
    App.setText('my-status', '已出招');
    App.showBadge('my-action', '已出招：' + App.actionName(pch), App.actionBadgeClass(pch));
    App.setText('opp-status', '电脑出招中…');

    setTimeout(function () {
      if (game !== g || g.over) return;   // 期间已离开/新开局：放弃陈旧回调

      App.setText('opp-status', '');
      App.showBadge('opp-action', '出招：' + App.actionName(cch), App.actionBadgeClass(cch));

      var r = Game.step(g.b1, g.b2, a, g.compAction);
      var outcome = r.winner === 1 ? 'win' : r.winner === 2 ? 'lose' : r.winner === 0 ? 'draw' : 'continue';
      g.b1 = r.b1;
      g.b2 = r.b2;
      App.updateBullets('my-bullets-num', 'my-bullets-icons', g.b1);
      App.updateBullets('opp-bullets-num', 'opp-bullets-icons', g.b2);

      if (outcome === 'continue') {
        App.addHistoryChip(App.actionName(pch) + '/' + App.actionName(cch), '');
        if (g.round >= Game.MAX_ROUNDS) {
          // 回合上限平局（C++ 语义：非终止结算后检查）
          g.over = true;
          endGame(g, 'draw', '回合数达到 ' + Game.MAX_ROUNDS + ' 上限，平局！');
          return;
        }
        g.round++;
        App.showBanner('对手出招：' + App.actionName(cch) + '！');
        setTimeout(function () {
          if (game !== g) return;   // 揭示期间离开：下一回合不再开始
          startRound(g);
        }, 1500);
      } else {
        g.over = true;
        var cls = outcome === 'win' ? 'win' : outcome === 'lose' ? 'lose' : 'draw';
        App.addHistoryChip(pch + '/' + cch, cls);
        // 结束原因区分：瞬间胜负（开枪打中装弹）vs 子弹数先到 5
        var reason;
        if (outcome === 'win') {
          reason = r.instant ? '你打中了装弹的对手！' : '你的子弹率先攒到了 5 颗！';
        } else if (outcome === 'lose') {
          reason = r.instant ? '对手打中了正在装弹的你！' : '对手的子弹率先攒到了 5 颗！';
        } else {
          reason = '双方子弹都达到了 10 颗。';
        }
        // 终局日志先行写入：若用户在揭示期间离开/重开，本局记录不丢失也不错位
        g.logLines.push('GAME_END NORMAL ' + nowSec());
        logText += g.logLines.join('\n') + '\n';
        saveLog();
        refreshMemoryNote();
        App.showBanner('对手出招：' + App.actionName(cch) + '！');
        setTimeout(function () {
          if (game !== g) return;   // 揭示期间离开/新开局：结果页不再打扰
          App.showResult(outcome, reason);
        }, 1500);
      }
    }, 1500);
  }

  function endGame(g, outcome, reason) {
    g.logLines.push('GAME_END NORMAL ' + nowSec());
    logText += g.logLines.join('\n') + '\n';
    saveLog();
    refreshMemoryNote();
    App.showResult(outcome, reason);
  }

  /* 对局中返回主菜单：写 GAME_END ABORT（下次加载时裁掉，等价 C++ 的 q 退出） */
  function abortToMenu() {
    if (game && !game.over) {
      game.logLines.push('GAME_END ABORT ' + nowSec());
      logText += game.logLines.join('\n') + '\n';
      saveLog();
    }
    game = null;
    refreshMemoryNote();
    App.showScreen('menu');
  }

  function toMenu() {
    game = null;
    refreshMemoryNote();
    App.showScreen('menu');
  }

  window.ModeAI = {
    enter: enter,
    startGame: startGame,
    onAction: onAction,
    abortToMenu: abortToMenu,
    toMenu: toMenu
  };
})();
