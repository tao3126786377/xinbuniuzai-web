# 西部牛仔 · 网页版（人机对战 + 玩家对决）

Node.js 服务器：静态页面 + WebSocket 房间对战 + 后台线程中的完整模式 AI。手机浏览器（含微信内置浏览器）可直接游玩。首次启动自动准备模型资源，也可先运行 `npm run build`。

**更新原 Render 网址**：按 [DEPLOY_RENDER.md](DEPLOY_RENDER.md) 操作现有服务，保留 `https://xinbuniuzai-web.onrender.com`。

**完整人机模型说明**：见 [完整模式AI模型说明.md](完整模式AI模型说明.md)，包含当前策略、神经网络、学习方式、实验效果与限制。

**v0.15.0 发布**：完整模式采用已验证的动态整局风险余额，快速模式保留原策略及连续学习修补。采用和暂缓的成果、测试结果见 [本次发布说明](RELEASE_AI_V0_15.md)。完整模式可导出诊断，用 `node tools/analyze_match_ai.js xnz_match_diagnostics.json` 分析当前浏览器的新对局；不自动上传。

## 局域网试玩

1. 双击 `start.bat`（首次运行会自动安装依赖；需要已安装 [Node.js](https://nodejs.org/) LTS）
2. Windows 防火墙弹窗时点"允许访问"
3. 启动横幅会打印本机与局域网地址，例如 `http://192.168.x.x:3000`
4. 电脑与手机连**同一个 WiFi**，手机浏览器（或微信）打开该地址即可
5. 一台设备"创建房间"，另一台输入房间号加入

## 游戏说明

- **人机对战**：电脑会观察你的习惯逐渐调整策略（按对局数量降权适应最近习惯；记忆存于本机浏览器，
  每台设备独立；主菜单可查看分模式胜率与对局记录）
- **玩家对决**：房间号制。每回合限时 60 秒，超时系统随机代出，连续 3 次超时判负；
  主动离开立即判负；意外断线有 60 秒重连宽限期（刷新页面可自动恢复）
- **完整对决**：完整对局最多 5 轮。每轮双方先**保密选择初始子弹**（0~2 颗），轮开始时公开，
  该轮从所选子弹数开局；轮末按子弹差结算筹码 y=(i+1)(j+1)x（劣势方获胜赔付翻倍，
  x=0 不结算），平局双方各扣 5×自选子弹；一方筹码归零立即结束，5 轮后筹码多者胜；
  玩家对决的选弹与出招限时、连击规则相同（连续 3 次超时判负）。完整人机已开放，不限时，需联网；
  使用独立记忆，逐回合更新并跨局保留。刷新或退出后重新开局，已保存记忆保留，中途退出不计胜负。

## 环境变量（部署/调参）

| 变量 | 默认 | 说明 |
|---|---|---|
| PORT | 3000 | 监听端口 |
| ROUND_TIMEOUT_MS | 60000 | 每回合限时（毫秒） |
| GRACE_MS | 60000 | 断线重连宽限期（毫秒） |
| TIMEOUT_STRIKES | 3 | 连续超时判负次数 |
| MAX_ROOMS | 1000 | 房间数上限 |
| MAX_ROOMS_PER_IP | 10 | 每 IP 最多创建房间数 |
| ROOM_TTL_MS | 600000 | 空房间清理时限（毫秒） |
| ROOM_CODE_LENGTH | 4 | 房间号位数（公网建议 5~6） |
| ALLOWED_ORIGINS | 空 | 额外允许的 WS Origin（逗号分隔，反代场景） |
| ALLOW_NO_ORIGIN | true | 是否允许无 Origin 的连接（公网建议 false） |
| TEST_BULLET_CHOICE | 空 | 测试钩子：选弹超时代选固定值（0~2，自动化测试用） |

示例：`PORT=8080 node server.js`（Linux/Mac 写法；Windows cmd 用 `set PORT=8080 && node server.js`）

## 公网部署清单

### 方案：GitHub + Render（免费，约 20 分钟）

1. **注册/登录**：[github.com](https://github.com)（托管代码）与 [render.com](https://render.com)（托管服务器，免费额度）
2. **上传代码**：仅首次新建服务时需要创建仓库；原站点更新请看上方部署文档。上传 `web/` 的代码及 `lib/`、`assets/`、`tools/`，遵循 `.gitignore`，无需传 `node_modules` 和 `.runtime`。
3. **在 Render 创建服务**：仅首次新建时 Dashboard → New → **Web Service** → 连接仓库（Node 环境、Build Command `npm ci && npm run build`、Start Command `npm start`）→ 选择实例 → Create。更新原网址不需要新建服务。
4. **配置环境变量**（服务设置 → Environment）：`ROOM_CODE_LENGTH=5`、`ALLOW_NO_ORIGIN=false`（其余默认即可）
5. **拿链接分发**：部署完成后得到 `https://xxx.onrender.com`，微信里直接发这个链接即可游玩（平台自带 HTTPS/WSS，代码零改动）

注意：
- Render 免费实例闲置 15 分钟会休眠，下次访问需约 30~60 秒冷启动（网页先开、游戏照常）
- 免费实例位于海外，国内访问偶尔偏慢；回合制游戏对延迟不敏感，不影响对战
- 若访问异常，可在国内云服务器（需备案域名）上用同一份代码自托管，见上方环境变量表

### 方案 B：电脑常开 + 内网穿透（零注册）

PC 跑 `start.bat`，再开一个穿透工具（如 Cloudflare Tunnel：`cloudflared tunnel --url http://localhost:3000`）得到公网 https 地址发给朋友。缺点：电脑必须一直开机，地址每次重启会变。适合临时约战。

## 开发

- 完整模式电脑决策见 [`lib/match-ai/README.md`](lib/match-ai/README.md)。网页使用 `full-temporal3-credit-v1`，固定原神经网络，采用动态整局余额；公网部署按上方文档进行。
- `npm run test:match-web`：完整模式 HTTP 会话和页面控制器验证，无 Python 依赖。
- `npm run test:match-ai`：完整模式决策移植与会话验证（首次先按模块文档生成离线参考数据）。
- `npm run gen`：从 `../Game_XiBuNiuZai/strategy_data.h` 重新生成 `public/strategies.js`
- `npm run test:ai`：AI 移植正确性验证（需先在项目根目录运行 `python web/tools/gen_reference.py` 生成最强对照数据）

## 与 C++ 控制台版的关系

网页版 AI 是 C++ `Game_XiBuNiuZai.cpp` 自适应层的逐行 JS 移植（差桶后验 + 完整最佳响应值迭代 + ε 门槛混合），日志格式与 `game_log.txt` 完全兼容。C++ 版与网页版独立运行，互不读写对方文件。
