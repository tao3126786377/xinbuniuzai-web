# 更新原 Render 网址（v0.14.0）

项目根目录《工作记录.md》的 2026-09-02 部署记录确认：

- 原网址：<https://xinbuniuzai-web.onrender.com>
- GitHub 仓库：`tao3126786377/xinbuniuzai-web`，分支 `main`。
- 真正的 Git 仓库在 `E:\VS code\Game_XiBuNiuZai - web\web`，不是外面的项目总目录。
- 原部署使用 Render 免费 Web Service，推送 `main` 后自动部署。

以上仓库和分支已与本地 Git 配置核对；本次没有登录 Render 后台、推送或部署，后台设置请按下面核对。

## 本次更新内容

完整人机按钮已开放。固定 `full-temporal3-v1` 策略：小型行为网络、三步规划、完整模式均衡安全约束。电脑在玩家提交前锁定动作，双方公开后使用新观察规划下一步；模型权重固定，行为记忆逐回合更新，跨轮、跨局保留。快速模式每局读取最新日志的修补也包含在内。

完整模式计算在 Node 后台线程执行。浏览器只接收状态和已揭示动作，不下载均衡表。玩家记忆与完成对局记录保存在当前浏览器，和快速模式分开。退出不计入胜负；刷新页面或服务器重启后，需要重新开局，已保存的行为记忆保留。

## 1. 本地试玩

在 PowerShell 中执行：

```powershell
Set-Location 'E:\VS code\Game_XiBuNiuZai - web\web'
npm ci
npm run build
npm start
```

打开 <http://localhost:3000>，主菜单应显示 `网页版 v0.14.0`，进入“完整 · 人机对战”。如 3000 端口正在运行旧服务，先在旧终端按 Ctrl+C 退出，再重新启动。

本次新测试可以运行：`npm run test:match-web`。原快速模式检查为 `npm run test:ai`；原联机检查为 `node test/pvp_test.js` 和 `node test/match_test.js`。

## 2. 核对原 Render 服务设置

登录 [Render Dashboard](https://dashboard.render.com/)，打开网址为 `xinbuniuzai-web.onrender.com` 的**现有 Web Service**。

在 Settings → Build & Deploy 核对：

| 项目 | 值 |
| --- | --- |
| Repository | `tao3126786377/xinbuniuzai-web` |
| Branch | `main` |
| Root Directory | 留空（该仓库顶层就是本地 `web/` 的内容） |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm start` |
| Auto-Deploy | 开启，推送到关联分支后部署 |

Environment 保留 `ROOM_CODE_LENGTH=5`、`ALLOW_NO_ORIGIN=false`。无需 Python、GPU、额外数据库或持久化磁盘。不要把 `MATCH_AI_TABLES_PATH` 设置成本地 Windows 路径，默认即可。

建议先核对这些设置，完成下步代码推送后再保存新的构建命令，避免旧版本没有 `build` 脚本。新服务启动时本身也会自动准备缺失的模型资源，兼容原来的 `npm install` 构建命令。

这些设置对应 Render 的 [部署说明](https://render.com/docs/deploys)。务必操作现有服务，更新后原网址保持不变。

## 3. 提交本地修改并推送

在同一个 PowerShell 中执行。`git status` 用来核对本次需要提交的本地文件；包括此前研究模块、固定模型和快速模式修补。

```powershell
git status --short
git add .
git diff --cached --stat
git commit -m "接入完整模式人机 AI，保留连续对局学习修补"
git push origin main
```

提交列表中应包含 `assets/match-ai/*.gz`、`assets/match-ai/bundle.json`、`lib/match-ai/weights.bin`、新页面脚本、服务器接口和准备脚本。模型表压缩后总计约 **80 MB**，最大的单个文件约 32 MB；本次首次推送可能比以前慢。请使用 Git 推送，避免逐个通过 GitHub 网页上传。

`.gitignore` 已排除 `node_modules/`、`.runtime/`、`research/artifacts/` 和研究依赖缓存。这些大目录无需提交。`assets/match-ai/` 是必须提交的发布资源，不能漏掉。

如果 Git 提示 `detected dubious ownership`，确认错误中的目录就是上面的自己的 `web` 仓库，再按 Git 提示仅为该目录添加 `safe.directory`；不要把全盘目录设成信任。

## 4. 确认部署成功

在 Render → Events/Logs 等待最新部署显示 `Live`。若自动部署没有开启，在现有服务中选 **Manual Deploy → Deploy latest commit**。

- 构建日志：`npm run build` 成功；首次准备资源会显示“模型资源已准备就绪”。
- 运行日志：`[完整人机] full-temporal3-v1 已就绪`。
- 打开 <https://xinbuniuzai-web.onrender.com/api/match-ai/health>，应得到 `{"ready":true}`。
- 刷新原游戏网址（必要时强制刷新），确认版本为 `v0.14.0`。
- 玩一次完整人机：选弹、出招、轮末结算、再来一局；返回菜单能看到完整模式统计。
- 用原来的房间方式验证一次玩家对决。

Render 免费服务仍可能冷启动，具体限制以 [免费服务说明](https://render.com/docs/free) 为准。本地请求耗时不能代表 Render 实际速度；首次上线后观察请求延迟和实例内存即可，暂不需要购买更高规格。

## 常见问题

- **原网页还是旧版**：检查 Render 最新部署是否对应刚推送的提交、Branch 是否为 `main`，然后强制刷新页面。
- **完整人机一直在准备**：看服务日志是否缺少 `assets/match-ai` 文件，确认构建命令完成。模型资源哈希或长度不匹配会报错并拒绝加载，不会悄悄替换成另一套策略。
- **对局过期或服务器重启**：回菜单重新进入；浏览器保存的完整模式记忆仍在。部署时正在进行的联机/人机对局不跨进程恢复。
- **想恢复上一版**：在 Render 的部署记录里使用上一成功版本的回滚入口，并按后台提示处理自动部署设置。不要为了回滚创建另一个服务。

## 本地验收（2026-09-26）

- 快速模式 AI 数学对照与页面冒烟测试通过，连续对局学习修补保留。
- 完整模式 Node 移植：3,853 个规则转移、270 个矩阵、121 个策略状态通过；3 场会话、335 次决策通过。
- 新 HTTP/页面控制器：整局结算、重复请求、隐藏动作、非法动作、跨局记忆、旧回调隔离和两种日志隔离通过。
- 原快速 PvP：66 通过 / 0 失败；完整 PvP：114 通过 / 0 失败。
- 浏览器实测：菜单、选弹、动作揭示、跨轮筹码显示通过。
- 已用发布压缩包准备运行资源并启动本地服务。公网版本尚未更新。
