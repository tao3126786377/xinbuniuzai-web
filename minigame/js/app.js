import './render';

const QuickSession = require('./core/quick-session');
const MatchClient = require('./core/match-client');
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
    this.runId = 0;
    this.adaptiveState = null;
    this.adaptiveConsentPrompt = null;

    this.render();
    wx.onTouchStart(this.handleTouchStart.bind(this));
    wx.onTouchEnd(this.handleTouchEnd.bind(this));
    if (wx.onHide) wx.onHide(() => this.saveFullMemory());
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
  }

  drawText(text, x, y, size, color, align, weight) {
    ctx.shadowColor = 'transparent';
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${weight || 'normal'} ${size}px sans-serif`;
    ctx.fillStyle = color || '#fff2dc';
    ctx.fillText(text, x, y);
  }

  drawButton(id, label, x, y, width, height, enabled) {
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
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.strokeStyle = isEnabled ? 'rgba(194, 138, 75, 0.45)' : 'rgba(120, 105, 94, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    this.drawText(label, x + width / 2, y + height / 2 + 1, 17, isEnabled ? '#fff2dc' : '#8f837a');

    this.controls.push({ id, x, y, width, height, enabled: isEnabled });
  }

  drawMenu() {
    const titleY = Math.max(SAFE_TOP + 92, HEIGHT * 0.16);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 38px serif';
    ctx.fillStyle = '#e07f3a';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.fillText('牛仔决斗', WIDTH / 2, titleY);
    this.drawText('开枪 · 防御 · 装弹', WIDTH / 2, titleY + 43, 16, '#c6ad90');

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
    ctx.fillStyle = 'rgba(30, 27, 26, 0.88)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(194, 138, 75, 0.38)';
    ctx.stroke();

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
    this.drawPanel('你', this.quick.b1, playerAction, 18, panelY, panelWidth);
    this.drawPanel('电脑', this.quick.b2, computerAction, 18 + panelWidth + gap, panelY, panelWidth);

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
    this.drawButton('action-0', '开枪', 18, buttonY, buttonWidth, 58, actionEnabled && this.quick.b1 > 0);
    this.drawButton('action-1', '防御', 18 + buttonWidth + buttonGap, buttonY, buttonWidth, 58, actionEnabled);
    this.drawButton('action-2', '装弹', 18 + (buttonWidth + buttonGap) * 2, buttonY, buttonWidth, 58, actionEnabled && this.quick.b1 < Game.MAX_BULLET);
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
    this.drawPanel('你', playerBullets, playerAction, 18, panelY, panelWidth, playerMoney);
    this.drawPanel('电脑', computerBullets, computerAction, 18 + panelWidth + gap, panelY, panelWidth, computerMoney);

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
      );
    }
  }

  drawResult() {
    const titles = { win: '你赢了！', lose: '你输了', draw: '平局' };
    const colors = { win: '#e07f3a', lose: '#e8a0a0', draw: '#b0b0c8' };
    this.drawText(titles[this.result.outcome], WIDTH / 2, HEIGHT * 0.31, 40, colors[this.result.outcome], 'center', 'bold');
    this.drawText(this.result.reason, WIDTH / 2, HEIGHT * 0.39, 15, '#fff2dc');

    const width = Math.min(320, WIDTH - 48);
    const x = (WIDTH - width) / 2;
    const againId = this.resultSource === 'match' ? 'match-again' : 'quick-again';
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
    if (this.quick && !this.quick.over) this.quick.abort();
    this.saveFullMemory();
    if (this.match) this.match.discard();
    this.quick = null;
    this.match = null;
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
    } else if (id === 'privacy') {
      this.showPrivacy();
    } else if (id === 'privacy-adaptive') {
      this.showAdaptivePrivacy();
    } else if (id === 'privacy-training') {
      this.showTrainingPrivacy();
    } else if (id === 'mode-1' || id === 'mode-2') {
      wx.showToast({ title: '该模式将在下一步迁移', icon: 'none' });
    } else if (id === 'quick-back' || id === 'match-back' || id === 'result-menu'
      || id === 'privacy-back') {
      this.toMenu();
    } else if (id.indexOf('action-') === 0) {
      this.playQuick(Number(id.slice(7)));
    } else if (id.indexOf('match-action-') === 0) {
      this.playMatch(Number(id.slice(13)));
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
    if (id) this.activate(id);
  }
}
