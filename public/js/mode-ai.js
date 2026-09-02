/* 西部牛仔 · 人机对战模式（完全客户端运行，无需服务器）
 *
 * AI 管线忠实移植自 C++：页面加载（首次进入）时构建模型一次，之后每局复用；
 * AI 在玩家出招前采样（保持同时性与"不偷看"性质）；
 * 日志存 localStorage，格式与 C++ game_log.txt 完全一致。
 */
(function () {
  'use strict';

  var LOG_KEY = 'xnz_log_v1';

  var session = null;   // AI 会话（后验/BR/桶总量）
  var logText = '';     // 当前日志文本（内存镜像，追加后写回）
  var game = null;      // 当前对局状态

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

  /* 刷新主菜单记忆脚注：只统计正常结束（GAME_END NORMAL）的对局 */
  function refreshMemoryNote() {
    var games = (logText.match(/^GAME_END NORMAL/gm) || []).length;
    App.setText('ai-memory-note', games > 0 ? '电脑已记住你的 ' + games + ' 局历史对局' : '电脑还未记录你的对局');
  }

  /* 构建 AI 会话（与 C++ main 启动序列一致：日志 → 桶 → 后验 → 最佳响应） */
  function buildSession() {
    try { logText = localStorage.getItem(LOG_KEY) || ''; } catch (e) { logText = ''; }
    var loaded = AI.loadAndProcessLog(logText, nowSec());
    if (loaded.changed) {
      logText = loaded.prunedText;   // 裁剪后写回（等价 C++ 的 dropped_any 重写）
      saveLog();
    }
    var pool = AI.buildPoolStats(loaded.weightedCount, loaded.totalWeight);
    var post = AI.buildPosterior(pool.poolCount, pool.poolTotal, Strategies.eq_policy_player);
    var br = AI.computeBestResponse(post, Strategies.eq_policy_comp, Strategies.V_values);
    session = {
      post: post,
      Vbr: br.Vbr,
      Veq: br.Veq,
      brPolicy: br.brPolicy,
      poolTotal: pool.poolTotal,
      eqComp: Strategies.eq_policy_comp,
      eqPlayer: Strategies.eq_policy_player
    };
    // 刷新菜单脚注
    refreshMemoryNote();
  }

  /* 进入人机对战：首次构建模型（带加载遮罩），随后开局 */
  function enter() {
    App.setActiveMode('ai');
    if (!session) {
      App.show('loading-overlay');
      setTimeout(function () {
        buildSession();
        App.hide('loading-overlay');
        startGame();
      }, 50);   // 让遮罩先绘制
    } else {
      startGame();
    }
  }

  function startGame() {
    App.setActiveMode('ai');
    game = {
      b1: 0,
      b2: 0,
      round: 1,
      compAction: -1,
      playerActed: false,
      over: false,
      logLines: ['GAME_START ' + nowSec()]
    };
    App.setText('game-mode-label', '人机对战');
    App.setText('opponent-name', '电脑');
    App.setText('btn-leave-game', '返回主菜单（本局作废）');
    App.clearHistory();
    App.showScreen('game');
    startRound();
  }

  function startRound() {
    game.playerActed = false;
    game.compAction = -1;
    App.setText('round-label', '回合 ' + game.round + '/' + Game.MAX_ROUNDS);
    App.updateBullets('my-bullets-num', 'my-bullets-icons', game.b1);
    App.updateBullets('opp-bullets-num', 'opp-bullets-icons', game.b2);
    App.hide('my-action');
    App.hide('opp-action');
    App.setText('my-status', '');
    App.setText('opp-status', '');
    App.hide('banner');
    App.hide('countdown');
    App.setActionButtons({ u: game.b1 > 0, i: true, o: game.b1 < Game.MAX_BULLET });

    // AI 在玩家出招前采样（与 C++ 一致：玩家看不到也影响不了本次 AI 行动）
    var probs = AI.computeFinalStrategy(session, game.b1, game.b2);
    game.compAction = AI.sampleAction(probs);
  }

  function onAction(a) {
    if (!game || game.over || game.playerActed) return;
    if (!Game.isFeasible(game.b1, a)) return;

    game.playerActed = true;
    var pch = Game.ACT_CHARS[a];
    var cch = Game.ACT_CHARS[game.compAction];

    // 日志先行（C++ 顺序：结算前写回合行，瞬间胜负回合也写）
    game.logLines.push(game.b1 + ' ' + game.b2 + ' ' + pch + ' ' + cch + ' ' + nowSec());

    App.lockActionButtons();
    App.setText('my-status', '已出招');
    App.showBadge('my-action', '已出招：' + App.actionName(pch), App.actionBadgeClass(pch));
    App.setText('opp-status', '电脑出招中…');

    setTimeout(function () {
      App.setText('opp-status', '');
      App.showBadge('opp-action', '出招：' + App.actionName(cch), App.actionBadgeClass(cch));

      var r = Game.step(game.b1, game.b2, a, game.compAction);
      var outcome = r.winner === 1 ? 'win' : r.winner === 2 ? 'lose' : r.winner === 0 ? 'draw' : 'continue';
      game.b1 = r.b1;
      game.b2 = r.b2;
      App.updateBullets('my-bullets-num', 'my-bullets-icons', game.b1);
      App.updateBullets('opp-bullets-num', 'opp-bullets-icons', game.b2);

      if (outcome === 'continue') {
        App.addHistoryChip(App.actionName(pch) + '/' + App.actionName(cch), '');
        if (game.round >= Game.MAX_ROUNDS) {
          // 回合上限平局（C++ 语义：非终止结算后检查）
          game.over = true;
          endGame('draw', '回合数达到 ' + Game.MAX_ROUNDS + ' 上限，平局！');
          return;
        }
        game.round++;
        App.showBanner('对手出招：' + App.actionName(cch) + '！');
        setTimeout(startRound, 1500);
      } else {
        game.over = true;
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
        App.showBanner('对手出招：' + App.actionName(cch) + '！');
        setTimeout(function () { endGame(outcome, reason); }, 1500);
      }
    }, 1500);
  }

  function endGame(outcome, reason) {
    game.logLines.push('GAME_END NORMAL ' + nowSec());
    logText += game.logLines.join('\n') + '\n';
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
