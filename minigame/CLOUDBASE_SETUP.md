# CloudBase 策略记忆与训练数据库配置

环境 ID：`cloud1-d1gclwenrc6f659c0`

本配置包含两个相互隔离的用途：`adaptive_memory` 只保存电脑跨局适应所需的策略记忆，`training_matches` 只保存玩家另行授权、可供开发者导出的训练对局。完整 AI 与玩家联机目前仍由 Render 运行。

## 1. 创建数据库集合

1. 在微信开发者工具打开“云开发”，确认当前环境为上述环境 ID。
2. 进入“数据库”，分别新建集合 `adaptive_memory` 和 `training_matches`。
3. 将两个集合权限都设为“仅管理员可读写”。不要允许小游戏客户端直接读写；所有操作必须经过对应云函数。

## 2. 部署云函数

项目重新编译或重新打开后，资源管理器中的 `cloudfunctions` 应显示为云函数目录。

1. 展开 `cloudfunctions/training-data`。
2. 右键 `training-data`，选择“上传并部署：云端安装依赖”。
3. 用同样方式上传并部署 `cloudfunctions/adaptive-memory`。
4. 等待部署完成。依赖由各目录的 `package.json` 声明，不需要把 `node_modules` 提交到 Git。

## 3. 配置 HMAC 密钥

在 CloudBase／云函数控制台分别配置：

- `training-data`：`TRAINING_HASH_SECRET`
- `adaptive-memory`：`ADAPTIVE_HASH_SECRET`
- 两个值都使用至少 32 字节的随机字符串，而且必须彼此不同

可以在 PowerShell 本地生成：

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

运行两次命令，把两个不同结果分别填入云函数环境变量。不要发到聊天、截图或写进项目文件。密钥必须长期保留；更换后将无法根据旧哈希找到并删除旧记录。

保存配置后重新部署或重启云函数，使环境变量生效。

## 4. 验证

1. 首次打开时选择“启用强化”，完成一局快速人机或完整人机。
2. `adaptive_memory` 应新增一个文档，其中可以有 `quickLog`、`fullMemory`，但不应出现 OpenID、昵称或头像。
3. 进入“数据与隐私 → 个性化强化”，选择关闭并删除；对应文档应被删除。
4. 再进入“数据与隐私 → 训练数据贡献”，选择允许贡献并完成一局人机。
5. `training_matches` 应新增一条记录，其中有 `playerHash`，但不应出现 OpenID、昵称或头像。
6. 撤回训练贡献并删除；同一 `playerHash` 下的训练记录应被删除。

管理员需要训练数据时，只导出 `training_matches` 集合。不要导出 `adaptive_memory`，也不要为客户端开放任一集合的直接读取权限。

## 5. 微信后台隐私说明

应用内的两个弹窗不能替代微信公众平台的隐私保护指引。提交审核前，还要在小游戏后台如实说明：

- 为提供跨局个性化电脑策略，会处理匿名化后的游戏操作记录和策略记忆；拒绝后仍能使用基础策略。
- 只有再次单独同意后，完成的对局才会进入可供开发者导出的模型训练库。
- 两种用途可以分别开启、撤回和删除，训练授权不应与基本游玩或个性化强化捆绑。
- 隐私说明应写明保存期限、删除入口、开发者联系方式，以及完整模式仍会把本局公开操作发送给计算服务器。

后台可选的数据类型名称会随微信平台表单更新，应按提交时页面的实际选项选择；不要为了通过审核选择与代码行为不符的类型。

## 6. 常见问题

- 提示 `TRAINING_HASH_SECRET_NOT_CONFIGURED`：云函数没有配置密钥，或配置后尚未重新部署。
- 提示 `ADAPTIVE_HASH_SECRET_NOT_CONFIGURED`：强化记忆云函数没有配置独立密钥。
- 提示找不到云函数：确认项目的 `project.config.json` 包含 `cloudfunctionRoot`，然后重新打开项目。
- 提示找不到 `wx-server-sdk`：重新选择“上传并部署：云端安装依赖”。
- 允许训练后上传失败不影响游戏结果；修复云函数后，新完成的对局会继续上传。
