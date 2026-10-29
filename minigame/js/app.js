import './render';

const QuickSession = require('./core/quick-session');
const MatchClient = require('./core/match-client');
const PvpClient = require('./core/pvp-client');
const MusicController = require('./core/music');
const EffectsController = require('./core/effects');
const Adaptive = require('./core/adaptive-client');
const Training = require('./core/training-client');
const Game = QuickSession.Game;
const ctx = canvas.getContext('2d');
const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
const WIDTH = windowInfo.screenWidth;
const HEIGHT = windowInfo.screenHeight;
const SAFE_TOP = windowInfo.safeArea ? windowInfo.safeArea.top : 28;

const MODES = [
  '快速 · 人机对战',
  '快速 · 玩家对决',
  '完整 · 玩家对决',
  '完整 · 人机对战',
];
const ACTION_NAMES = ['开枪', '防御', '装弹'];

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function contains(control, touch) {
  return touch.clientX >= control.x
    && touch.clientX <= control.x + control.width
    && touch.clientY >= control.y
    && touch.clientY <= control.y + control.height;
}

export default class Main {
  constructor() {
    this.screen = 'menu';
    this.controls = [];
    this.activeId = '';
    this.quick = null;
    this.busy = false;
    this.pendingAction = -1;
    this.reveal = null;
    this.result = null;
    this.resultSource = 'quick';
    this.loadingTitle = '正在构建电脑策略…';
    this.loadingDetail = '首次进入可能需要一点时间';
    this.match = null;
    this.matchBusy = false;
    this.matchReveal = null;
    this.matchEvents = [];
    this.matchStartedAt = 0;
    this.matchHistoryRound = 1;
    this.matchError = '';
    this.pvp = null;
    this.pvpMode = 'single';
    this.pvpState = null;
    this.pvpReveal = null;
    this.pvpEvents = [];
    this.pvpStatus = '';
    this.pvpRevealTimer = null;
    this.pvpReconnectTimer = null;
    this.pvpPendingGameOver = null;
    this.music = new MusicController();
    this.effects = new EffectsController();
    this.runId = 0;
    this.adaptiveState = null;
    this.adaptiveConsentPrompt = null;

    this.render();
    wx.onTouchStart(this.handleTouchStart.bind(this));
    wx.onTouchEnd(this.handleTouchEnd.bind(this));
    if (wx.onHide) wx.onHide(() => {
      this.saveFullMemory();
      this.music.pause();
      this.effects.stop();
    });
    if (wx.onShow) wx.onShow(() => this.music.resume());
    setTimeout(() => this.askAdaptiveConsent(), 150);
  }

  render() {
    this.controls = [];
    this.drawBackground();
    if (this.screen === 'menu') this.drawMenu();
    else if (this.screen === 'loading') this.drawLoading();
    else if (this.screen === 'privacy') this.drawPrivacy();
    else if (this.screen === 'quick') this.drawQuickGame();
    else if (this.screen === 'match') this.drawMatchGame();
    else if (this.screen === 'pvp-menu') this.drawPvpMenu();
    else if (this.screen === 'pvp-lobby') this.drawPvpLobby();
    else if (this.screen === 'pvp-game') this.drawPvpGame();
    else if (this.screen === 'result') this.drawResult();
  }

  drawBackground() {
    const background = ctx.createLinearGradient(WIDTH, 0, 0, HEIGHT);
    background.addColorStop(0, '#111e32');
    background.addColorStop(0.48, '#171a25');
    background.addColorStop(1, '#21130f');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const topGlow = ctx.createRadialGradient(
      WIDTH / 2, HEIGHT * 0.24, 8,
      WIDTH / 2, HEIGHT * 0.24, WIDTH * 0.72,
    );
    topGlow.addColorStop(0, 'rgba(208, 105, 47, 0.28)');
    topGlow.addColorStop(1, 'rgba(208, 105, 47, 0)');
    ctx.fillStyle = topGlow;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const bottomGlow = ctx.createRadialGradient(
      WIDTH / 2, HEIGHT * 1.12, 4,
      WIDTH / 2, HEIGHT * 1.12, HEIGHT * 0.62,
    );
    bottomGlow.addColorStop(0, 'rgba(126, 65, 30, 0.30)');
    bottomGlow.addColorStop(1, 'rgba(126, 65, 30, 0)');
    ctx.fillStyle = bottomGlow;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const vignette = ctx.createRadialGradient(
      WIDTH / 2, HEIGHT / 2, WIDTH * 0.3,
      WIDTH / 2, HEIGHT / 2, HEIGHT * 0.72,
    );
    vignette.addColorStop(0, 'rgba(3, 5, 9, 0)');
    vignette.addColorStop(1, 'rgba(3, 5, 9, 0.42)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    ctx.fillStyle = 'rgba(240, 192, 96, 0.10)';
    const dust = [
      [0.10, 0.18], [0.22, 0.11], [0.34, 0.24], [0.47, 0.14], [0.61, 0.21],
      [0.74, 0.12], [0.87, 0.25], [0.16, 0.58], [0.82, 0.53], [0.91, 0.68],
    ];
    dust.forEach((point, index) => {
      const size = index % 3 === 0 ? 2 : 1;
      ctx.fillRect(WIDTH * point[0], HEIGHT * point[1], size, size);
    });

    ctx.strokeStyle = 'rgba(194, 138, 75, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(12, SAFE_TOP + 2);
    ctx.lineTo(12, HEIGHT - 18);
    ctx.moveTo(WIDTH - 12, SAFE_TOP + 2);
    ctx.lineTo(WIDTH - 12, HEIGHT - 18);
    ctx.stroke();
  }

  drawText(text, x, y, size, color, align, weight) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${weight || 'normal'} ${size}px sans-serif`;
    ctx.fillStyle = color || '#fff2dc';
    ctx.fillText(text, x, y);
  }

  drawActionIcon(action, x, y, size, color) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.7;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (action === 0) {
      ctx.fillRect(x - size * 0.56, y - size * 0.28, size * 0.82, size * 0.25);
      ctx.fillRect(x + size * 0.18, y - size * 0.22, size * 0.42, size * 0.12);
      ctx.beginPath();
      ctx.moveTo(x - size * 0.12, y - size * 0.04);
      ctx.lineTo(x + size * 0.10, y + size * 0.48);
      ctx.lineTo(x - size * 0.20, y + size * 0.48);
      ctx.lineTo(x - size * 0.38, y - size * 0.04);
      ctx.closePath();
      ctx.fill();
      return;
    }
    if (action === 1) {
      ctx.beginPath();
      ctx.moveTo(x, y - size * 0.58);
      ctx.lineTo(x + size * 0.50, y - size * 0.34);
      ctx.lineTo(x + size * 0.40, y + size * 0.25);
      ctx.lineTo(x, y + size * 0.58);
      ctx.lineTo(x - size * 0.40, y + size * 0.25);
      ctx.lineTo(x - size * 0.50, y - size * 0.34);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y - size * 0.42);
      ctx.lineTo(x, y + size * 0.36);
      ctx.stroke();
      return;
    }
    roundedRect(ctx, x - size * 0.24, y - size * 0.58, size * 0.48, size * 1.16, size * 0.24);
    ctx.stroke();
    ctx.fillRect(x - size * 0.24, y + size * 0.18, size * 0.48, size * 0.16);
  }

  drawButton(id, label, x, y, width, height, enabled, actionIcon) {
    const active = id === this.activeId;
    const isEnabled = enabled !== false;
    const gradient = ctx.createLinearGradient(x, y, x + width, y + height);
    if (!isEnabled) {
      gradient.addColorStop(0, '#403833');
      gradient.addColorStop(1, '#2f2b29');
    } else if (active) {
      gradient.addColorStop(0, '#72442d');
      gradient.addColorStop(1, '#72442d');
    } else {
      gradient.addColorStop(0, 'rgba(101, 58, 36, 0.92)');
      gradient.addColorStop(1, 'rgba(48, 35, 29, 0.94)');
    }

    roundedRect(ctx, x, y, width, height, 15);
    ctx.shadowColor = isEnabled ? 'rgba(0, 0, 0, 0.38)' : 'transparent';
    ctx.shadowBlur = isEnabled ? 10 : 0;
    ctx.shadowOffsetY = isEnabled ? 4 : 0;
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = isEnabled ? 'rgba(194, 138, 75, 0.45)' : 'rgba(120, 105, 94, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    const color = isEnabled ? '#fff2dc' : '#8f837a';
    if (Number.isInteger(actionIcon)) {
      this.drawActionIcon(actionIcon, x + width / 2, y + 18, 13, color);
      this.drawText(label, x + width / 2, y + 43, 14, color, 'center', 'bold');
    } else {
      this.drawText(label, x + width / 2, y + height / 2 + 1, 17, color);
    }

    this.controls.push({ id, x, y, width, height, enabled: isEnabled });
  }

  drawMenuScenery() {
    const base = HEIGHT - 12;
    ctx.fillStyle = 'rgba(8, 14, 24, 0.26)';
    ctx.beginPath();
    ctx.moveTo(0, base);
    ctx.lineTo(0, HEIGHT * 0.77);
    ctx.lineTo(WIDTH * 0.18, HEIGHT * 0.69);
    ctx.lineTo(WIDTH * 0.37, HEIGHT * 0.80);
    ctx.lineTo(WIDTH * 0.60, HEIGHT * 0.66);
    ctx.lineTo(WIDTH * 0.78, HEIGHT * 0.75);
    ctx.lineTo(WIDTH, HEIGHT * 0.64);
    ctx.lineTo(WIDTH, base);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(5, 9, 16, 0.34)';
    ctx.beginPath();
    ctx.moveTo(0, base);
    ctx.lineTo(0, HEIGHT * 0.86);
    ctx.lineTo(WIDTH * 0.25, HEIGHT * 0.74);
    ctx.lineTo(WIDTH * 0.45, HEIGHT * 0.86);
    ctx.lineTo(WIDTH * 0.70, HEIGHT * 0.72);
    ctx.lineTo(WIDTH, HEIGHT * 0.84);
    ctx.lineTo(WIDTH, base);
    ctx.closePath();
    ctx.fill();
  }

  drawMenu() {
    this.drawMenuScenery();
    const titleY = Math.max(SAFE_TOP + 92, HEIGHT * 0.16);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 38px serif';
    ctx.fillStyle = '#e07f3a';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.fillText('牛仔决斗', WIDTH / 2, titleY);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    this.drawText('开枪 · 防御 · 装弹', WIDTH / 2, titleY + 43, 16, '#c6ad90');
    ctx.strokeStyle = 'rgba(224, 127, 58, 0.48)';
    ctx.beginPath();
    ctx.moveTo(WIDTH / 2 - 88, titleY + 67);
    ctx.lineTo(WIDTH / 2 - 20, titleY + 67);
    ctx.moveTo(WIDTH / 2 + 20, titleY + 67);
    ctx.lineTo(WIDTH / 2 + 88, titleY + 67);
    ctx.stroke();
    this.drawText('◆', WIDTH / 2, titleY + 67, 9, '#e07f3a');
    this.drawButton(
      'music-toggle',
      this.music.isEnabled() ? '■ 音乐' : '♫ 音乐',
      16,
      SAFE_TOP + 8,
      88,
      36,
      true,
    );

    const width = Math.min(340, WIDTH - 48);
    const height = Math.max(54, Math.min(62, HEIGHT * 0.071));
    const startY = Math.max(218, HEIGHT * 0.285);
    const x = (WIDTH - width) / 2;
    MODES.forEach((label, index) => {
      this.drawButton(`mode-${index}`, label, x, startY + index * (height + 12), width, height, true);
    });
    this.drawButton('privacy', '数据与隐私', WIDTH / 2 - 58, HEIGHT - 66, 116, 34, true);
    this.drawText('微信小游戏功能迁移版', WIDTH / 2, HEIGHT - 18, 12, 'rgba(198, 173, 144, 0.64)');
  }

  drawLoading() {
    this.drawText(this.loadingTitle, WIDTH / 2, HEIGHT * 0.46, 20, '#fff2dc', 'center', 'bold');
    this.drawText(this.loadingDetail, WIDTH / 2, HEIGHT * 0.46 + 38, 14, '#c6ad90');
  }

  drawPrivacy() {
    const top = Math.max(SAFE_TOP + 10, 36);
    this.drawButton('privacy-back', '‹ 菜单', 16, top, 76, 38, true);
    this.drawText('数据与隐私', WIDTH / 2, top + 78, 27, '#e07f3a', 'center', 'bold');
    this.drawText('两类授权互相独立，可分别开启或删除', WIDTH / 2, top + 116, 13, '#c6ad90');

    const width = Math.min(340, WIDTH - 48);
    const x = (WIDTH - width) / 2;
    const adaptiveAllowed = Adaptive.consent() === 'allow';
    const trainingAllowed = Training.consent() === 'allow';
    this.drawButton(
      'privacy-adaptive',
      `个性化强化 · ${adaptiveAllowed ? '已开启' : '未开启'}`,
      x,
      top + 160,
      width,
      64,
      true,
    );
    this.drawText('跨局策略记忆；不进入训练导出库', WIDTH / 2, top + 244, 13, '#c6ad90');
    this.drawButton(
      'privacy-training',
      `训练数据贡献 · ${trainingAllowed ? '已开启' : '未开启'}`,
      x,
      top + 286,
      width,
      64,
      true,
    );
    this.drawText('仅在单独同意后保存完整对局', WIDTH / 2, top + 370, 13, '#c6ad90');
  }

  drawPanel(title, bullets, action, x, y, width, money) {
    const height = 132;
    roundedRect(ctx, x, y, width, height, 12);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = 'rgba(30, 27, 26, 0.88)';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = 'rgba(194, 138, 75, 0.38)';
    ctx.stroke();
    ctx.fillStyle = 'rgba(224, 127, 58, 0.58)';
    ctx.fillRect(x + 14, y + 4, width - 28, 2);

    this.drawText(title, x + width / 2, y + 22, 16, '#c6ad90', 'center', 'bold');
    this.drawText(`子弹 ${bullets}`, x + width / 2, y + 53, 22, '#fff2dc', 'center', 'bold');
    if (money !== undefined) this.drawText(`筹码 ${money}`, x + width / 2, y + 79, 15, '#c6ad90');
    this.drawText(action, x + width / 2, y + 108, 15, action === '等待出招' ? '#8f837a' : '#e07f3a');
  }

  drawQuickGame() {
    const top = Math.max(SAFE_TOP + 10, 36);
    this.drawButton('quick-back', '‹ 菜单', 16, top, 76, 38, !this.busy);
    this.drawText(`回合 ${this.quick.round}`, WIDTH / 2, top + 19, 20, '#fff2dc', 'center', 'bold');

    let playerAction = '等待出招';
    let computerAction = '等待出招';
    if (this.pendingAction >= 0) playerAction = this.reveal ? ACTION_NAMES[this.pendingAction] : '已出招';
    if (this.reveal) computerAction = ACTION_NAMES[this.reveal.computerAction];
    else if (this.pendingAction >= 0) computerAction = '思考中…';

    const gap = 10;
    const panelWidth = (WIDTH - 36 - gap) / 2;
    const panelY = top + 62;
    this.drawPanel('电脑', this.quick.b2, computerAction, 18, panelY, panelWidth);
    this.drawPanel('你', this.quick.b1, playerAction, 18 + panelWidth + gap, panelY, panelWidth);

    const historyY = panelY + 150;
    roundedRect(ctx, 18, historyY, WIDTH - 36, 172, 12);
    ctx.fillStyle = 'rgba(30, 27, 26, 0.64)';
    ctx.fill();
    this.drawText('本局记录', 32, historyY + 22, 14, '#c6ad90', 'left', 'bold');

    const history = this.quick.history.slice(-5);
    if (!history.length) {
      this.drawText('尚未出招', WIDTH / 2, historyY + 92, 14, '#8f837a');
    } else {
      history.forEach((item, index) => {
        const line = `回合${item.round}　你${ACTION_NAMES[item.playerAction]}，电脑${ACTION_NAMES[item.computerAction]}`;
        const color = item.outcome === 'win' ? '#e07f3a'
          : item.outcome === 'lose' ? '#e8a0a0' : '#fff2dc';
        this.drawText(line, 32, historyY + 50 + index * 25, 14, color, 'left');
      });
    }

    const buttonGap = 8;
    const buttonWidth = (WIDTH - 36 - buttonGap * 2) / 3;
    const buttonY = HEIGHT - 96;
    const actionEnabled = !this.busy && !this.quick.over;
    this.drawButton('action-0', '开枪', 18, buttonY, buttonWidth, 58, actionEnabled && this.quick.b1 > 0, 0);
    this.drawButton('action-1', '防御', 18 + buttonWidth + buttonGap, buttonY, buttonWidth, 58, actionEnabled, 1);
    this.drawButton('action-2', '装弹', 18 + (buttonWidth + buttonGap) * 2, buttonY, buttonWidth, 58, actionEnabled && this.quick.b1 < Game.MAX_BULLET, 2);
  }

  drawMatchGame() {
    const value = this.match && this.match.data;
    if (!value) return;
    const state = value.snapshot.state;
    const revealed = this.matchReveal;
    const before = revealed ? revealed.before : state;
    const displayState = state || before;
    const pick = before.phase === 'pick';
    const settlement = revealed && revealed.settlement;
    const top = Math.max(SAFE_TOP + 10, 36);

    this.drawButton('match-back', '‹ 菜单', 16, top, 76, 38, !this.matchBusy);
    this.drawText(
      `第${before.round}/5轮　${pick ? '选择初始子弹' : `回合 ${before.turn}`}`,
      WIDTH / 2 + 32,
      top + 19,
      17,
      '#fff2dc',
      'center',
      'bold',
    );

    let computerBullets = displayState.bc;
    let playerBullets = displayState.bh;
    let computerMoney = displayState.mc;
    let playerMoney = displayState.mh;
    if (settlement && settlement.round_end) {
      computerBullets = settlement.final_bullets[0];
      playerBullets = settlement.final_bullets[1];
      computerMoney = settlement.money[0];
      playerMoney = settlement.money[1];
    }

    let playerAction = '等待选择';
    let computerAction = value.ready ? '电脑已选好' : '准备中…';
    if (revealed) {
      playerAction = pick ? `${revealed.human} 颗` : ACTION_NAMES[revealed.human];
      computerAction = pick ? `${revealed.computer} 颗` : ACTION_NAMES[revealed.computer];
    } else if (this.matchBusy) {
      playerAction = '已提交';
      computerAction = '揭示中…';
    }

    const gap = 10;
    const panelWidth = (WIDTH - 36 - gap) / 2;
    const panelY = top + 62;
    this.drawPanel('电脑', computerBullets, computerAction, 18, panelY, panelWidth, computerMoney);
    this.drawPanel('你', playerBullets, playerAction, 18 + panelWidth + gap, panelY, panelWidth, playerMoney);

    const historyY = panelY + 150;
    roundedRect(ctx, 18, historyY, WIDTH - 36, 172, 12);
    ctx.fillStyle = 'rgba(30, 27, 26, 0.64)';
    ctx.fill();
    this.drawText('本轮记录', 32, historyY + 22, 14, '#c6ad90', 'left', 'bold');
    const history = this.matchEvents.filter((event) => event.before.phase === 'play'
      && event.before.round === before.round).slice(-4);
    if (!history.length) {
      this.drawText(pick ? '双方选择后一起公开' : '尚未出招', WIDTH / 2, historyY + 76, 14, '#8f837a');
    } else {
      history.forEach((event, index) => {
        const line = `回合${event.before.turn}　你${ACTION_NAMES[event.human]}，电脑${ACTION_NAMES[event.computer]}`;
        this.drawText(line, 32, historyY + 50 + index * 25, 14, '#fff2dc', 'left');
      });
    }
    if (settlement && settlement.round_end) {
      const winner = settlement.winner === 2 ? '你胜' : settlement.winner === 1 ? '电脑胜' : '平局';
      this.drawText(
        `本轮${winner} · 你 ${settlement.money[1]} / 电脑 ${settlement.money[0]}`,
        WIDTH / 2,
        historyY + 151,
        13,
        '#e07f3a',
      );
    } else if (this.matchError) {
      this.drawText(this.matchError, WIDTH / 2, historyY + 151, 12, '#e8a0a0');
    }

    const buttonGap = 8;
    const buttonWidth = (WIDTH - 36 - buttonGap * 2) / 3;
    const buttonY = HEIGHT - 96;
    const enabled = !this.matchBusy && !this.matchError && value.ready && !value.snapshot.over;
    const labels = pick ? ['0 颗', '1 颗', '2 颗'] : ACTION_NAMES;
    for (let action = 0; action < 3; action++) {
      const legal = pick || Game.isFeasible(displayState.bh, action);
      this.drawButton(
        `match-action-${action}`,
        labels[action],
        18 + action * (buttonWidth + buttonGap),
        buttonY,
        buttonWidth,
        58,
        enabled && legal,
        pick ? undefined : action,
      );
    }
  }

  drawPvpMenu() {
    const top = Math.max(SAFE_TOP + 10, 36);
    this.drawButton('pvp-menu-back', '‹ 菜单', 16, top, 76, 38, true);
    this.drawText(
      this.pvpMode === 'match' ? '完整 · 好友对决' : '快速 · 好友对决',
      WIDTH / 2,
      top + 88,
      28,
      '#e07f3a',
      'center',
      'bold',
    );
    this.drawText(
      this.pvpMode === 'match' ? '五轮筹码对决，双方同时决策' : '创建房间，把房间号发给好友',
      WIDTH / 2,
      top + 130,
      14,
      '#c6ad90',
    );
    const width = Math.min(330, WIDTH - 48);
    const x = (WIDTH - width) / 2;
    this.drawButton('pvp-create', '创建房间', x, top + 190, width, 62, true);
    this.drawButton('pvp-join', '输入房间号加入', x, top + 268, width, 62, true);
    this.drawText('房间内不传输昵称、头像或聊天内容', WIDTH / 2, top + 362, 13, '#8f837a');
  }

  drawPvpLobby() {
    const state = this.pvpState;
    const top = Math.max(SAFE_TOP + 10, 36);
    this.drawButton('pvp-leave', '‹ 离开', 16, top, 76, 38, true);
    this.drawText('等待好友加入', WIDTH / 2, top + 100, 27, '#e07f3a', 'center', 'bold');
    this.drawText('房间号', WIDTH / 2, top + 160, 15, '#c6ad90');
    roundedRect(ctx, WIDTH / 2 - 110, top + 178, 220, 72, 14);
    ctx.fillStyle = 'rgba(30, 27, 26, 0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(194, 138, 75, 0.42)';
    ctx.stroke();
    this.drawText(state && state.code ? state.code : '连接中…', WIDTH / 2, top + 212, 42, '#fff2dc', 'center', 'bold');
    this.drawText(this.pvpStatus || '正在连接服务器…', WIDTH / 2, top + 278, 14, '#c6ad90');
    this.drawText('请让好友选择相同模式并输入房间号', WIDTH / 2, top + 326, 13, '#8f837a');
    if (state && state.code) {
      const width = Math.min(260, WIDTH - 80);
      this.drawButton('pvp-copy', '复制房间号', (WIDTH - width) / 2, top + 360, width, 54, true);
    }
  }

  drawPvpGame() {
    const state = this.pvpState;
    if (!state) return;
    const top = Math.max(SAFE_TOP + 10, 36);
    const pick = state.mode === 'match' && state.phase === 'pick';
    const mySeat = state.seat;
    const myBullets = mySeat === 0 ? state.b1 : state.b2;
    const opponentBullets = mySeat === 0 ? state.b2 : state.b1;
    const myMoney = mySeat === 0 ? state.money[0] : state.money[1];
    const opponentMoney = mySeat === 0 ? state.money[1] : state.money[0];

    this.drawButton('pvp-leave', '‹ 离开', 16, top, 76, 38, true);
    const roundText = state.mode === 'match'
      ? `第${state.matchRound}/5轮　${pick ? '选择初始子弹' : `回合 ${state.round}`}`
      : `回合 ${state.round}`;
    this.drawText(roundText, WIDTH / 2 + 32, top + 19, 17, '#fff2dc', 'center', 'bold');
    this.drawText(`房间 ${state.code}`, WIDTH / 2, top + 47, 12, '#8f837a');

    let myAction = pick ? (state.acted ? `已选择 ${state.myPick} 颗` : '等待选择') : (state.acted ? '已出招' : '等待出招');
    let opponentAction = state.opponentConnected ? '等待对手' : '对手断线，等待重连';
    if (this.pvpReveal) {
      myAction = this.pvpReveal.pick ? `${this.pvpReveal.human} 颗` : ACTION_NAMES[this.pvpReveal.human];
      opponentAction = this.pvpReveal.pick ? `${this.pvpReveal.opponent} 颗` : ACTION_NAMES[this.pvpReveal.opponent];
    }

    const gap = 10;
    const panelWidth = (WIDTH - 36 - gap) / 2;
    const panelY = top + 76;
    this.drawPanel('好友', opponentBullets, opponentAction, 18, panelY, panelWidth,
      state.mode === 'match' ? opponentMoney : undefined);
    this.drawPanel('你', myBullets, myAction, 18 + panelWidth + gap, panelY, panelWidth,
      state.mode === 'match' ? myMoney : undefined);

    const historyY = panelY + 150;
    roundedRect(ctx, 18, historyY, WIDTH - 36, 172, 12);
    ctx.fillStyle = 'rgba(30, 27, 26, 0.64)';
    ctx.fill();
    this.drawText('本轮记录', 32, historyY + 22, 14, '#c6ad90', 'left', 'bold');
    const history = this.pvpEvents.filter((event) => state.mode !== 'match'
      || event.matchRound === state.matchRound).slice(-4);
    if (!history.length) {
      this.drawText(pick ? '双方选择后一起公开' : '尚未出招', WIDTH / 2, historyY + 76, 14, '#8f837a');
    } else {
      history.forEach((event, index) => {
        const line = `回合${event.round}　你${ACTION_NAMES[event.human]}，好友${ACTION_NAMES[event.opponent]}`;
        this.drawText(line, 32, historyY + 50 + index * 25, 14, '#fff2dc', 'left');
      });
    }
    if (this.pvpStatus) this.drawText(this.pvpStatus, WIDTH / 2, historyY + 151, 12, '#e07f3a');

    const buttonGap = 8;
    const buttonWidth = (WIDTH - 36 - buttonGap * 2) / 3;
    const buttonY = HEIGHT - 96;
    const labels = pick ? ['0 颗', '1 颗', '2 颗'] : ACTION_NAMES;
    for (let action = 0; action < 3; action++) {
      const legal = pick || Game.isFeasible(myBullets, action);
      this.drawButton(
        `pvp-action-${action}`,
        labels[action],
        18 + action * (buttonWidth + buttonGap),
        buttonY,
        buttonWidth,
        58,
        state.status === 'playing' && !state.acted && legal,
        pick ? undefined : action,
      );
    }
  }

  drawResult() {
    const titles = { win: '你赢了！', lose: '你输了', draw: '平局' };
    const colors = { win: '#e07f3a', lose: '#e8a0a0', draw: '#b0b0c8' };
    roundedRect(ctx, 24, HEIGHT * 0.22, WIDTH - 48, HEIGHT * 0.24, 18);
    ctx.fillStyle = 'rgba(30, 27, 26, 0.76)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(194, 138, 75, 0.38)';
    ctx.stroke();
    this.drawText(titles[this.result.outcome], WIDTH / 2, HEIGHT * 0.31, 40, colors[this.result.outcome], 'center', 'bold');
    this.drawText(this.result.reason, WIDTH / 2, HEIGHT * 0.39, 15, '#fff2dc');

    const width = Math.min(320, WIDTH - 48);
    const x = (WIDTH - width) / 2;
    const againId = this.resultSource === 'match' ? 'match-again'
      : this.resultSource === 'pvp' ? 'pvp-again' : 'quick-again';
    this.drawButton(againId, '再来一局', x, HEIGHT * 0.52, width, 58, true);
    this.drawButton('result-menu', '返回主菜单', x, HEIGHT * 0.52 + 72, width, 58, true);
  }

  askAdaptiveConsent() {
    if (Adaptive.consent() !== 'unset') return Promise.resolve();
    if (this.adaptiveConsentPrompt) return this.adaptiveConsentPrompt;
    this.adaptiveConsentPrompt = new Promise((resolve) => {
      const done = () => {
        this.adaptiveConsentPrompt = null;
        resolve();
      };
      wx.showModal({
        title: '启用个性化强化策略',
        content: '是否允许把两种人机模式产生的策略记忆保存到云端？启用后，电脑可跨局更快适应你的打法。系统仅将这些数据用于恢复电脑策略，不用于模型训练、对局分析或开发者导出。若选择基础策略，仍可正常游玩，但电脑每次会从基础记忆开始，适应速度和强度会下降。',
        confirmText: '启用强化',
        cancelText: '基础策略',
        success: (answer) => {
          Adaptive.setConsent(!!answer.confirm);
          done();
        },
        fail: done,
      });
    });
    return this.adaptiveConsentPrompt;
  }

  async loadAdaptiveState() {
    if (Adaptive.consent() !== 'allow') return { quickLog: '', fullMemory: null };
    if (this.adaptiveState) return this.adaptiveState;
    try {
      const value = await Adaptive.load();
      this.adaptiveState = {
        quickLog: value.quickLog || '',
        fullMemory: value.fullMemory || null,
      };
    } catch (error) {
      this.adaptiveState = { quickLog: '', fullMemory: null };
      wx.showToast({ title: '强化记忆读取失败，本次使用基础策略', icon: 'none' });
    }
    return this.adaptiveState;
  }

  saveFullMemory() {
    if (Adaptive.consent() !== 'allow' || !this.match || !this.match.memory) return;
    if (!this.adaptiveState) this.adaptiveState = { quickLog: '', fullMemory: null };
    this.adaptiveState.fullMemory = this.match.memory;
    Adaptive.saveFull(this.match.memory)
      .catch(() => wx.showToast({ title: '强化记忆暂未保存', icon: 'none' }));
  }

  askTrainingConsent() {
    if (Training.consent() !== 'unset') return Promise.resolve();
    return new Promise((resolve) => {
      wx.showModal({
        title: '贡献训练数据（可选）',
        content: '是否允许把已完成的人机对局存入独立训练库，供开发者导出并改进模型？不包含昵称、头像或其他私人信息，只保存玩家哈希与公开对局过程。选择“仅游玩”不会影响当前或个性化强化策略。',
        confirmText: '允许贡献',
        cancelText: '仅游玩',
        success: (answer) => {
          Training.setConsent(!!answer.confirm);
          resolve();
        },
        fail: () => resolve(),
      });
    });
  }

  askMatchNetworkNotice() {
    if (Training.hasAcceptedNetworkNotice()) return Promise.resolve(true);
    return new Promise((resolve) => {
      wx.showModal({
        title: '完整人机需要联网',
        content: '完整模式会把当前公开局面、你的选择和匿名会话发送到本游戏的Render服务器，由服务器实时计算电脑行动。数据用于完成本次玩法；训练记录是否保存会在下一步单独询问。',
        confirmText: '同意进入',
        cancelText: '暂不进入',
        success: (answer) => {
          if (answer.confirm) Training.acceptNetworkNotice();
          resolve(!!answer.confirm);
        },
        fail: (error) => {
          wx.showToast({ title: error.errMsg || '联网说明打开失败', icon: 'none' });
          resolve(false);
        },
      });
    });
  }

  async beginQuick() {
    await this.askAdaptiveConsent();
    await this.askTrainingConsent();
    this.startQuick();
  }

  async beginMatch() {
    this.loadingTitle = '正在准备完整模式…';
    this.loadingDetail = '正在检查授权与网络';
    this.screen = 'loading';
    this.render();
    await this.askAdaptiveConsent();
    const accepted = await this.askMatchNetworkNotice();
    if (!accepted) {
      this.screen = 'menu';
      this.render();
      return;
    }
    await this.askTrainingConsent();
    await this.startMatch();
  }

  showPrivacy() {
    this.screen = 'privacy';
    this.render();
  }

  showAdaptivePrivacy() {
    const allowed = Adaptive.consent() === 'allow';
    const pendingDeletion = Adaptive.hasPendingDeletion();
    wx.showModal({
      title: '个性化强化策略',
      content: pendingDeletion
        ? '强化策略已关闭，但上次删除云端策略记忆时未成功。你可以现在重试。'
        : allowed
        ? '跨局策略记忆保存在独立策略记忆库，系统仅将它用于恢复电脑策略，不用于训练、对局分析或导出。关闭后仍可使用基础策略，并可删除已有记忆。'
        : '当前使用基础策略，不保存跨局策略记忆。开启后，电脑可在后续对局中更快适应你的打法；这不会同时开启训练数据贡献。',
      confirmText: pendingDeletion ? '重试删除' : allowed ? '关闭删除' : '开启强化',
      cancelText: '返回',
      success: async (answer) => {
        if (!answer.confirm) return;
        if (!allowed && !pendingDeletion) {
          Adaptive.setConsent(true);
          this.adaptiveState = null;
          this.render();
          wx.showToast({ title: '已开启个性化强化', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '正在删除' });
        try {
          const value = await Adaptive.withdrawAndDelete();
          this.adaptiveState = null;
          wx.hideLoading();
          this.render();
          wx.showToast({ title: `强化已关闭，删除${value.removed || 0}份记忆`, icon: 'none' });
        } catch (error) {
          wx.hideLoading();
          wx.showModal({
            title: '已关闭强化策略',
            content: `云端记忆删除暂时失败：${error.message}。请稍后在这里重试。`,
            showCancel: false,
          });
        }
      },
      fail: (error) => {
        wx.showToast({ title: error.errMsg || '设置弹窗打开失败', icon: 'none' });
      },
    });
  }

  showTrainingPrivacy() {
    const allowed = Training.consent() === 'allow';
    const pendingDeletion = Training.hasPendingDeletion();
    wx.showModal({
      title: '训练数据贡献',
      content: pendingDeletion
        ? '后续训练上传已经停止，但上次删除服务器旧数据时未成功。你可以现在重试删除。'
        : allowed
        ? '你已允许贡献完成的人机对局。云函数使用微信OpenID生成HMAC玩家哈希，数据库不保存OpenID原值、昵称或头像。你可以撤回授权并删除该哈希下此前上传的数据。'
        : '训练数据贡献当前未开启。允许后只上传完成的人机对局，用于分析和改进电脑策略；不影响游戏功能，可随时撤回并删除。',
      confirmText: pendingDeletion ? '重试删除' : allowed ? '撤回删除' : '允许贡献',
      cancelText: '关闭',
      success: async (answer) => {
        if (!answer.confirm) return;
        if (!allowed && !pendingDeletion) {
          Training.setConsent(true);
          this.render();
          wx.showToast({ title: '已允许贡献训练数据', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '正在删除' });
        try {
          const value = await Training.withdrawAndDelete();
          wx.hideLoading();
          this.render();
          wx.showToast({ title: `已撤回，删除${value.removed || 0}条`, icon: 'none' });
        } catch (error) {
          wx.hideLoading();
          wx.showModal({
            title: '已停止后续上传',
            content: `服务器删除暂时失败：${error.message}。请稍后在这里重试。`,
            showCancel: false,
          });
        }
      },
      fail: (error) => {
        wx.showToast({ title: error.errMsg || '设置弹窗打开失败', icon: 'none' });
      },
    });
  }

  startQuick() {
    const token = ++this.runId;
    this.loadingTitle = '正在构建电脑策略…';
    this.loadingDetail = '首次进入可能需要一点时间';
    this.screen = 'loading';
    this.render();
    setTimeout(async () => {
      if (token !== this.runId) return;
      try {
        const adaptive = await this.loadAdaptiveState();
        if (token !== this.runId) return;
        this.quick = new QuickSession({
          logText: adaptive.quickLog,
          onSave: (quickLog) => {
            if (Adaptive.consent() !== 'allow') return;
            adaptive.quickLog = quickLog;
            Adaptive.saveQuick(quickLog)
              .catch(() => wx.showToast({ title: '强化记忆暂未保存', icon: 'none' }));
          },
        });
        this.busy = false;
        this.pendingAction = -1;
        this.reveal = null;
        this.result = null;
        this.screen = 'quick';
        this.render();
      } catch (error) {
        this.screen = 'menu';
        this.render();
        wx.showModal({
          title: '电脑策略加载失败',
          content: error && error.message ? error.message : '请重新编译后再试',
          showCancel: false,
        });
      }
    }, 50);
  }

  async startMatch() {
    const token = ++this.runId;
    this.loadingTitle = '正在连接完整模式 AI…';
    this.loadingDetail = 'Render 冷启动时可能需要约一分钟';
    this.screen = 'loading';
    this.render();
    const adaptive = await this.loadAdaptiveState();
    if (token !== this.runId) return;
    this.match = new MatchClient({ memory: adaptive.fullMemory });
    this.matchBusy = true;
    this.matchError = '';
    this.match.start((attempt) => {
      if (token !== this.runId) return;
      this.loadingDetail = `服务器正在准备，已重试 ${attempt} 次`;
      this.render();
    }).then(() => {
      if (token !== this.runId) {
        this.match.discard();
        return;
      }
      this.matchBusy = false;
      this.matchReveal = null;
      this.matchEvents = [];
      this.matchStartedAt = Date.now();
      this.matchHistoryRound = 1;
      this.result = null;
      this.screen = 'match';
      this.render();
    }).catch((error) => {
      if (token !== this.runId) return;
      this.match = null;
      this.matchBusy = false;
      this.screen = 'menu';
      this.render();
      wx.showModal({
        title: '完整模式连接失败',
        content: `${error.message}。请确认开发者工具已允许网络请求，并稍后重试。`,
        showCancel: false,
      });
    });
  }

  async playMatch(action) {
    if (!this.match || this.matchBusy || this.matchError) return;
    const state = this.match.data.snapshot.state;
    if (state.phase === 'play' && !Game.isFeasible(state.bh, action)) return;
    const token = this.runId;
    this.matchBusy = true;
    this.matchReveal = null;
    this.render();
    try {
      const value = await this.match.step(action);
      if (token !== this.runId) return;
      const result = value.result;
      const event = {
        before: {
          phase: result.before.phase,
          round: result.before.round,
          turn: result.before.turn,
          bc: result.before.bc,
          bh: result.before.bh,
          mc: result.before.mc,
          mh: result.before.mh,
        },
        human: result.human,
        computer: result.computer,
        settlement: result.settlement,
        score: result.score,
      };
      this.matchEvents.push(event);
      if (result.settlement.round_end || value.snapshot.over) this.saveFullMemory();
      this.matchReveal = result;
      if (result.before.phase === 'play') this.effects.playRound(result.human, result.computer);
      this.render();

      setTimeout(() => {
        if (token !== this.runId) return;
        if (value.snapshot.over) {
          const outcome = result.score === 0 ? 'win' : result.score === 1 ? 'lose' : 'draw';
          const money = result.settlement.money;
          Training.upload({
            mode: 'match',
            startedAt: this.matchStartedAt,
            endedAt: Date.now(),
            outcome,
            events: this.matchEvents,
            final: {
              playerMoney: money[1],
              computerMoney: money[0],
              policy: value.policy,
              gameNumber: value.snapshot.gameNumber,
            },
          }).catch(() => wx.showToast({ title: '训练记录上传失败，不影响游戏', icon: 'none' }));
          this.result = {
            outcome,
            reason: `完整对局结束 · 你 ${money[1]} / 电脑 ${money[0]} 筹码`,
          };
          this.resultSource = 'match';
          this.matchBusy = false;
          this.screen = 'result';
          this.render();
          return;
        }
        if (value.snapshot.state.round !== this.matchHistoryRound) {
          this.matchHistoryRound = value.snapshot.state.round;
        }
        this.matchReveal = null;
        this.matchBusy = false;
        this.render();
      }, result.settlement.round_end ? 1500 : 850);
    } catch (error) {
      if (token !== this.runId) return;
      this.matchBusy = false;
      this.matchError = error.message || '网络连接异常';
      this.render();
      wx.showModal({
        title: '本局连接中断',
        content: `${this.matchError}。为避免同一动作重复结算，请返回菜单重新进入；已保存的电脑记忆不会丢失。`,
        showCancel: false,
      });
    }
  }

  async rematchMatch() {
    if (!this.match || this.matchBusy) return;
    const token = this.runId;
    this.loadingTitle = '正在开始下一局…';
    this.loadingDetail = '电脑会保留上一局学到的公开信息';
    this.screen = 'loading';
    this.render();
    try {
      await this.match.rematch();
      if (token !== this.runId) return;
      this.matchBusy = false;
      this.matchReveal = null;
      this.matchEvents = [];
      this.matchStartedAt = Date.now();
      this.matchHistoryRound = 1;
      this.matchError = '';
      this.result = null;
      this.screen = 'match';
      this.render();
    } catch (error) {
      if (token !== this.runId) return;
      this.screen = 'result';
      this.render();
      wx.showModal({ title: '下一局启动失败', content: error.message, showCancel: false });
    }
  }

  resetPvpState(mode) {
    if (this.pvpRevealTimer) clearTimeout(this.pvpRevealTimer);
    if (this.pvpReconnectTimer) clearTimeout(this.pvpReconnectTimer);
    this.pvpRevealTimer = null;
    this.pvpReconnectTimer = null;
    this.pvpPendingGameOver = null;
    this.pvpReveal = null;
    this.pvpEvents = [];
    this.pvpStatus = '';
    this.pvpState = {
      mode: mode === 'match' ? 'match' : 'single',
      status: 'connecting',
      phase: mode === 'match' ? 'pick' : 'play',
      code: '',
      seat: 0,
      b1: 0,
      b2: 0,
      round: 1,
      matchRound: 1,
      money: [50, 50],
      acted: false,
      myPick: null,
      opponentConnected: true,
    };
  }

  enterPvp(mode) {
    this.pvpMode = mode === 'match' ? 'match' : 'single';
    this.result = null;
    this.screen = 'pvp-menu';
    this.render();
  }

  makePvpClient(token) {
    if (this.pvp) this.pvp.close();
    this.pvp = new PvpClient({
      onOpen: () => {
        if (token !== this.runId) return;
        this.pvpStatus = '已连接，正在进入房间…';
        this.render();
      },
      onMessage: (message) => {
        if (token === this.runId) this.handlePvpMessage(message);
      },
      onClose: () => {
        if (token !== this.runId || !this.pvpState || this.pvpState.status === 'finished') return;
        this.pvpState.opponentConnected = false;
        this.pvpStatus = '连接中断，正在尝试恢复…';
        this.render();
        if (this.pvpReconnectTimer) clearTimeout(this.pvpReconnectTimer);
        this.pvpReconnectTimer = setTimeout(() => {
          this.pvpReconnectTimer = null;
          if (token === this.runId && this.pvp && !this.pvp.rejoin()) {
            this.pvpStatus = '房间已失效，请返回菜单重试';
            this.render();
          }
        }, 1500);
      },
      onError: () => {
        if (token !== this.runId) return;
        this.pvpStatus = '网络连接异常';
        this.render();
      },
    });
  }

  createPvp() {
    const token = ++this.runId;
    this.resetPvpState(this.pvpMode);
    this.pvpStatus = '正在创建房间…';
    this.screen = 'pvp-lobby';
    this.render();
    this.makePvpClient(token);
    this.pvp.create(this.pvpMode);
  }

  joinPvp() {
    wx.showModal({
      title: '加入房间',
      content: '',
      editable: true,
      placeholderText: '请输入房间号',
      confirmText: '加入',
      cancelText: '取消',
      success: (answer) => {
        if (!answer.confirm) return;
        const code = String(answer.content || '').trim();
        if (!/^\d{3,6}$/.test(code)) {
          wx.showToast({ title: '请输入正确的房间号', icon: 'none' });
          return;
        }
        const token = ++this.runId;
        this.resetPvpState(this.pvpMode);
        this.pvpState.code = code;
        this.pvpStatus = '正在加入房间…';
        this.screen = 'pvp-lobby';
        this.render();
        this.makePvpClient(token);
        this.pvp.join(code);
      },
    });
  }

  schedulePvpReveal(callback, delay) {
    if (this.pvpRevealTimer) clearTimeout(this.pvpRevealTimer);
    const token = this.runId;
    this.pvpRevealTimer = setTimeout(() => {
      this.pvpRevealTimer = null;
      if (token === this.runId) callback();
    }, delay);
  }

  pvpActionPair(message) {
    const seat = this.pvpState.seat;
    const first = Game.charToAction(message.a1);
    const second = Game.charToAction(message.a2);
    return seat === 0 ? [first, second] : [second, first];
  }

  handlePvpRound(message) {
    const state = this.pvpState;
    const pair = this.pvpActionPair(message);
    state.b1 = message.b1_next;
    state.b2 = message.b2_next;
    state.acted = true;
    if (state.mode === 'match') {
      state.matchRound = message.matchRound;
      state.money = message.money.slice();
    }
    this.pvpReveal = { human: pair[0], opponent: pair[1], pick: false };
    this.pvpEvents.push({
      round: message.round,
      matchRound: state.matchRound,
      human: pair[0],
      opponent: pair[1],
      outcome: message.outcome,
    });
    this.effects.playRound(pair[0], pair[1]);
    if (message.outcome === 'continue') {
      this.pvpStatus = '双方行动已公开';
      this.schedulePvpReveal(() => {
        state.round = message.round + 1;
        state.acted = false;
        this.pvpReveal = null;
        this.pvpStatus = '';
        this.render();
      }, 1100);
    } else {
      if (state.mode === 'match') {
        const myMoney = state.money[state.seat];
        const opponentMoney = state.money[1 - state.seat];
        this.pvpStatus = `本轮结算 · 你 ${myMoney} / 好友 ${opponentMoney}`;
      } else {
        this.pvpStatus = '本局胜负已定';
      }
      this.schedulePvpReveal(() => {
        if (this.pvpPendingGameOver) {
          const gameOver = this.pvpPendingGameOver;
          this.pvpPendingGameOver = null;
          this.showPvpGameOver(gameOver);
          return;
        }
        if (message.nextPhase === 'pick') {
          state.phase = 'pick';
          state.matchRound = message.nextMatchRound;
          state.round = 1;
          state.b1 = 0;
          state.b2 = 0;
          state.acted = false;
          state.myPick = null;
          this.pvpReveal = null;
          this.pvpStatus = '';
          this.render();
        }
      }, 1500);
    }
    this.render();
  }

  syncPvpRoom(message) {
    const state = this.pvpState;
    state.code = message.code;
    state.seat = message.seat;
    state.status = message.status;
    state.mode = message.mode || state.mode;
    state.phase = message.phase || 'play';
    state.b1 = message.b1;
    state.b2 = message.b2;
    state.round = message.round;
    state.matchRound = message.matchRound || 1;
    state.money = (message.money || [50, 50]).slice();
    state.acted = !!(message.acted && message.acted[message.seat]);
    state.myPick = message.myPick === undefined ? null : message.myPick;
    state.opponentConnected = message.opponentConnected !== false;
    this.pvpEvents = (message.history || []).map((event, index) => {
      const pair = message.seat === 0
        ? [Game.charToAction(event.a1), Game.charToAction(event.a2)]
        : [Game.charToAction(event.a2), Game.charToAction(event.a1)];
      return { round: index + 1, matchRound: state.matchRound, human: pair[0], opponent: pair[1], outcome: event.outcome };
    });
    if (message.lastGameOver) {
      this.showPvpGameOver(message.lastGameOver);
    } else if (message.status === 'waiting') {
      this.pvpStatus = '等待好友加入…';
      this.screen = 'pvp-lobby';
      this.render();
    } else {
      this.pvpStatus = state.opponentConnected ? '已恢复对局' : '好友断线，等待重连…';
      this.screen = 'pvp-game';
      this.render();
    }
  }

  handlePvpMessage(message) {
    const state = this.pvpState;
    if (!state) return;
    if (message.type === 'pong') return;
    if (message.type === 'room_created' || message.type === 'room_joined') {
      state.code = message.code;
      state.seat = message.seat;
      state.status = 'waiting';
      this.pvpStatus = '等待好友加入…';
      this.screen = 'pvp-lobby';
      this.render();
      return;
    }
    if (message.type === 'opponent_joined') {
      this.pvpStatus = '好友已加入，正在开始…';
      this.render();
      return;
    }
    if (message.type === 'game_started') {
      state.mode = message.mode || state.mode;
      state.status = 'playing';
      state.phase = message.phase || 'play';
      state.b1 = message.b1;
      state.b2 = message.b2;
      state.round = message.round;
      state.matchRound = message.matchRound || 1;
      state.money = (message.money || [50, 50]).slice();
      state.acted = false;
      state.myPick = null;
      state.opponentConnected = true;
      this.pvpEvents = [];
      this.pvpReveal = null;
      this.pvpStatus = '';
      this.screen = 'pvp-game';
      this.render();
      return;
    }
    if (message.type === 'bullet_reveal') {
      state.phase = 'play';
      state.matchRound = message.matchRound;
      state.b1 = message.b1;
      state.b2 = message.b2;
      state.round = message.round;
      state.money = message.money.slice();
      state.acted = false;
      const mine = message.picks[state.seat];
      const theirs = message.picks[1 - state.seat];
      this.pvpReveal = { human: mine, opponent: theirs, pick: true };
      this.pvpStatus = `初始子弹公开：你 ${mine} / 好友 ${theirs}`;
      this.schedulePvpReveal(() => {
        this.pvpReveal = null;
        this.pvpStatus = '';
        this.render();
      }, 1100);
      this.render();
      return;
    }
    if (message.type === 'round_result') {
      this.handlePvpRound(message);
      return;
    }
    if (message.type === 'game_over') {
      if (this.pvpRevealTimer) this.pvpPendingGameOver = message;
      else this.showPvpGameOver(message);
      return;
    }
    if (message.type === 'rematch_status') {
      const mine = message.votes[state.seat];
      const theirs = message.votes[1 - state.seat];
      this.result.reason = mine && theirs ? '双方同意，正在开始…'
        : mine ? '已发起再来一局，等待好友同意…'
          : '好友邀请再来一局，点击按钮即可同意';
      this.render();
      return;
    }
    if (message.type === 'opponent_left') {
      state.opponentConnected = false;
      this.pvpStatus = '好友断线，服务器将等待其重连';
      this.render();
      return;
    }
    if (message.type === 'opponent_rejoined') {
      state.opponentConnected = true;
      this.pvpStatus = '好友已重新连接';
      this.render();
      return;
    }
    if (message.type === 'room_state') {
      this.syncPvpRoom(message);
      return;
    }
    if (message.type === 'timeout_notice') {
      const mine = message.seat === state.seat;
      wx.showToast({ title: mine ? '你超时，系统已随机代选' : '好友超时，系统已随机代选', icon: 'none' });
      return;
    }
    if (message.type === 'room_closed') {
      wx.showToast({ title: '房间已关闭', icon: 'none' });
      this.closePvp(false);
      return;
    }
    if (message.type === 'error') {
      const fatal = ['room_not_found', 'bad_token', 'room_full', 'game_in_progress'].includes(message.code);
      wx.showModal({ title: '好友对决提示', content: message.msg || '服务器拒绝了本次操作', showCancel: false });
      if (fatal) this.closePvp(true);
    }
  }

  pvpResultReason(message) {
    const outcome = message.result;
    if (message.reason === 'match_end') {
      const money = message.money || [0, 0];
      return `完整对局结束 · 你 ${money[this.pvpState.seat]} / 好友 ${money[1 - this.pvpState.seat]} 筹码`;
    }
    if (message.reason === 'round_cap') return '达到回合上限，本局平局';
    if (message.reason === 'timeout_loss') return outcome === 'lose' ? '你连续超时 3 次，判负' : '好友连续超时 3 次';
    if (message.reason === 'opponent_left') return outcome === 'win' ? '好友已离开房间' : '你已离开房间';
    return outcome === 'win' ? '你赢得了这局对决' : outcome === 'lose' ? '好友赢得了这局对决' : '本局平局';
  }

  showPvpGameOver(message) {
    if (this.pvpRevealTimer) clearTimeout(this.pvpRevealTimer);
    this.pvpRevealTimer = null;
    this.pvpPendingGameOver = null;
    this.pvpState.status = 'finished';
    this.pvpState.lastReason = message.reason;
    this.pvpReveal = null;
    this.result = { outcome: message.result, reason: this.pvpResultReason(message) };
    this.resultSource = 'pvp';
    this.screen = 'result';
    this.render();
  }

  playPvp(action) {
    const state = this.pvpState;
    if (!this.pvp || !state || state.status !== 'playing' || state.acted) return;
    if (state.phase === 'pick') {
      if (!this.pvp.send({ type: 'submit_bullets', bullets: action })) {
        this.pvpStatus = '连接尚未恢复，请稍后再试';
        this.render();
        return;
      }
      state.myPick = action;
      state.acted = true;
      this.pvpStatus = `已选择 ${action} 颗，等待好友…`;
    } else {
      const bullets = state.seat === 0 ? state.b1 : state.b2;
      if (!Game.isFeasible(bullets, action)) return;
      if (!this.pvp.send({ type: 'submit_action', action: Game.ACT_CHARS[action] })) {
        this.pvpStatus = '连接尚未恢复，请稍后再试';
        this.render();
        return;
      }
      state.acted = true;
      this.pvpStatus = '已出招，等待好友…';
    }
    this.render();
  }

  rematchPvp() {
    if (!this.pvp || !this.pvpState || this.pvpState.status !== 'finished') return;
    if (this.pvpState.lastReason === 'opponent_left') {
      this.pvpState.status = 'waiting';
      this.pvpStatus = '等待好友重新加入当前房间…';
      this.screen = 'pvp-lobby';
      this.render();
      return;
    }
    this.pvp.send({ type: 'rematch_vote', accept: true });
    this.result.reason = '已发起再来一局，等待好友同意…';
    this.render();
  }

  closePvp(leaveRoom) {
    this.effects.stop();
    if (this.pvpRevealTimer) clearTimeout(this.pvpRevealTimer);
    if (this.pvpReconnectTimer) clearTimeout(this.pvpReconnectTimer);
    this.pvpRevealTimer = null;
    this.pvpReconnectTimer = null;
    if (this.pvp) {
      if (leaveRoom !== false) this.pvp.leave();
      else this.pvp.close();
    }
    this.pvp = null;
    this.pvpState = null;
    this.pvpReveal = null;
    this.pvpEvents = [];
    this.pvpStatus = '';
    this.pvpPendingGameOver = null;
    this.screen = 'menu';
    this.render();
  }

  leavePvp() {
    const playing = this.pvpState && this.pvpState.status === 'playing';
    if (!playing) {
      this.closePvp(true);
      return;
    }
    wx.showModal({
      title: '离开好友对决',
      content: '对局中离开会立即判负，确定离开吗？',
      confirmText: '离开',
      cancelText: '继续',
      success: (answer) => { if (answer.confirm) this.closePvp(true); },
    });
  }

  playQuick(action) {
    if (this.busy || !this.quick || this.quick.over) return;
    if (!Game.isFeasible(this.quick.b1, action)) return;
    const token = this.runId;
    this.busy = true;
    this.pendingAction = action;
    this.reveal = null;
    this.render();

    setTimeout(() => {
      if (token !== this.runId) return;
      const result = this.quick.play(action);
      this.reveal = result;
      this.effects.playRound(action, result.computerAction);
      this.render();
      setTimeout(() => {
        if (token !== this.runId) return;
        if (result.outcome === 'continue') {
          this.busy = false;
          this.pendingAction = -1;
          this.reveal = null;
          this.render();
        } else {
          Training.upload(this.quick.trainingRecord(result.outcome))
            .catch(() => wx.showToast({ title: '训练记录上传失败，不影响游戏', icon: 'none' }));
          this.result = result;
          this.resultSource = 'quick';
          this.screen = 'result';
          this.render();
        }
      }, 900);
    }, 650);
  }

  toMenu() {
    this.runId++;
    this.effects.stop();
    if (this.quick && !this.quick.over) this.quick.abort();
    this.saveFullMemory();
    if (this.match) this.match.discard();
    if (this.pvpRevealTimer) clearTimeout(this.pvpRevealTimer);
    if (this.pvpReconnectTimer) clearTimeout(this.pvpReconnectTimer);
    if (this.pvp) this.pvp.leave();
    this.quick = null;
    this.match = null;
    this.pvp = null;
    this.pvpState = null;
    this.pvpReveal = null;
    this.pvpEvents = [];
    this.pvpStatus = '';
    this.pvpRevealTimer = null;
    this.pvpReconnectTimer = null;
    this.pvpPendingGameOver = null;
    this.busy = false;
    this.matchBusy = false;
    this.matchReveal = null;
    this.matchEvents = [];
    this.matchError = '';
    this.pendingAction = -1;
    this.reveal = null;
    this.screen = 'menu';
    this.render();
  }

  showStartError(title, error) {
    this.screen = 'menu';
    this.render();
    wx.showModal({
      title,
      content: error && error.message ? error.message : '请稍后重试',
      showCancel: false,
    });
  }

  activate(id) {
    if (id === 'mode-0' || id === 'quick-again') {
      this.beginQuick().catch((error) => this.showStartError('快速模式启动失败', error));
    } else if (id === 'mode-3') {
      this.beginMatch().catch((error) => this.showStartError('完整模式启动失败', error));
    } else if (id === 'match-again') {
      this.rematchMatch();
    } else if (id === 'pvp-again') {
      this.rematchPvp();
    } else if (id === 'privacy') {
      this.showPrivacy();
    } else if (id === 'music-toggle') {
      this.music.toggle();
      this.render();
    } else if (id === 'privacy-adaptive') {
      this.showAdaptivePrivacy();
    } else if (id === 'privacy-training') {
      this.showTrainingPrivacy();
    } else if (id === 'mode-1') {
      this.enterPvp('single');
    } else if (id === 'mode-2') {
      this.enterPvp('match');
    } else if (id === 'pvp-create') {
      this.createPvp();
    } else if (id === 'pvp-join') {
      this.joinPvp();
    } else if (id === 'pvp-copy') {
      wx.setClipboardData({ data: this.pvpState.code });
    } else if (id === 'pvp-leave') {
      this.leavePvp();
    } else if (id === 'quick-back' || id === 'match-back' || id === 'result-menu'
      || id === 'privacy-back' || id === 'pvp-menu-back') {
      this.toMenu();
    } else if (id.indexOf('action-') === 0) {
      this.playQuick(Number(id.slice(7)));
    } else if (id.indexOf('match-action-') === 0) {
      this.playMatch(Number(id.slice(13)));
    } else if (id.indexOf('pvp-action-') === 0) {
      this.playPvp(Number(id.slice(11)));
    }
  }

  findControl(touch) {
    for (let i = this.controls.length - 1; i >= 0; i--) {
      if (this.controls[i].enabled && contains(this.controls[i], touch)) return this.controls[i];
    }
    return null;
  }

  handleTouchStart(event) {
    const touch = event.touches && event.touches[0];
    const control = touch ? this.findControl(touch) : null;
    this.activeId = control ? control.id : '';
    this.render();
  }

  handleTouchEnd(event) {
    const touch = event.changedTouches && event.changedTouches[0];
    const control = touch ? this.findControl(touch) : null;
    const id = control && control.id === this.activeId ? control.id : '';
    this.activeId = '';
    this.render();
    this.music.resume();
    if (id) this.activate(id);
  }
}
