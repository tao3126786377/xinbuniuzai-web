# 第五阶段：优先做出更强的电脑

直接训练行为预测器、接入安全规划、用完整对局选版本。本阶段不接网页，不推送或部署；原快速模式修改保留。

两个新模型：`refreshed` 用扩充数据重训原 107→64→3 网络；`temporal` 为 203→96→3，额外输入最近 64 个公开事件里，玩家对电脑/自己过去 1～4 手动作的条件频率及样本量。没有把对手类型、真实概率、隐藏参数或本手未公开动作输入网络。网络用于学习行为组合，胜负结算与安全约束仍由现有规则完成。

每次动作揭示后更新历史即可，下一手使用新统计，不在游戏里反复训练权重。历史跨轮保留，计算延迟频率时禁止跨越选弹边界形成假配对。每局评测从新玩家空历史开始；训练每位玩家生成三局，覆盖延续经验。

从 `web/` 目录执行：

```powershell
$env:OPENBLAS_NUM_THREADS='1'
python -m research.match_ai.phase5 data
python -m research.match_ai.phase5 train
python -m research.match_ai.phase5 tune
python -m research.match_ai.phase5 test
python -m unittest discover -s research/match_ai/tests -v
python -m research.match_ai.phase5 report
```

默认四进程；`--workers` 可调整。验证默认每类 16 局，四种控制器；独立测试默认每类 64 局，原版本与选中版本。`--games` 可改变局数。`--output` 为独立试跑目录，默认 `research/artifacts/phase5`。测试必须在验证选出版本之后执行，不根据测试重新选参数。

完整模式均衡表使用 `research/artifacts/full`。模型和简短报告保存在 `phase5/results`；训练数组和可重放日志在忽略目录 `research/artifacts/phase5`。所有数据标为合成；模型效果以整局期望得分和胜/平/负为准，不凭交叉熵降低宣称更强。

本地使用选中模型：

```python
import json
from pathlib import Path
from research.match_ai.equilibrium import Equilibrium
from research.match_ai.phase5.run import controller
from research.match_ai.phase5.model import remember
from research.match_ai.phase2.data import event

folder = Path('research/match_ai/phase5/results')
name = json.loads((folder/'selection.json').read_text())['selected']
agent = controller(Equilibrium('research/artifacts/full'), folder, name)
# p 的顺序对应 rules.actions(state)[0]；从 p 随机采样自己的动作。
p, diagnostics = agent.decision(state, public_history)
# 仅在双方动作揭示且执行 transition 后更新公开历史。
public_history = remember(public_history, event(state, computer_action, human_action, settlement, terminal))
```

`temporal3` 同时增加了输入、网络宽度和搜索深度；这是实用候选比较，并不声称严格隔离了每个因素的因果收益。0.02 最坏期望得分损失预算维持不变。仍依赖较大的精确均衡表，离线上可用不等于已完成手机网页部署。
