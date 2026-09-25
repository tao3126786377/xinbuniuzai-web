"""Versionable report generated only from completed, actual experiment output."""
import csv
from datetime import datetime,timezone
import hashlib
import json
import platform
from pathlib import Path
import shutil
import numpy as np
from ..matrix import DELTA,SAFETY_TOLERANCE
from ..experiments import interval
from .data import FAMILIES
from .study import paired_bootstrap


def generate_report(directory,destination):
    directory=Path(directory); destination=Path(destination); destination.mkdir(parents=True,exist_ok=True)
    data={key:json.loads((directory/f'{key}.json').read_text(encoding='utf-8'))
          for key in ('data','training','oracle','prediction','games')}
    if set(data['games']['results'])!=set(FAMILIES): raise ValueError('Incomplete game study')
    for key in data: shutil.copyfile(directory/f'{key}.json',destination/f'{key}.json')
    for name in ('linear','neural'): shutil.copyfile(directory/f'{name}.npz',destination/f'{name}.npz')
    source=Path(__file__).parents[1]
    provenance=dict(created_utc=datetime.now(timezone.utc).isoformat(),python=platform.python_version(),
                    numpy=np.__version__,platform=platform.platform(),processor=platform.processor(),
                    generator_seed=20260925,training_seed=101,initialization_seed=20260925,
                    source_hashes={str(p.relative_to(source)):hashlib.sha256(p.read_bytes()).hexdigest()
                                   for p in source.rglob('*.py') if 'results' not in p.parts},
                    artifact_hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.glob('*.npz')})
    (destination/'provenance.json').write_text(json.dumps(provenance,indent=2),encoding='utf-8')
    training=data['training']; prediction=data['prediction']['results']; games=data['games']; oracle=data['oracle']
    rows=[]
    for family in FAMILIES:
        for planner,s in games['results'][family]['planners'].items():
            rows.append(dict(family=family,planner=planner,**s,win_rate=s['wins']/s['n'],draw_rate=s['draws']/s['n'],loss_rate=s['losses']/s['n']))
    with (destination/'scores.csv').open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
    n=games['games_per_family']; net=training['neural']
    lines=['# 第二阶段研究：已知对手上界与小型行为网络','',
      '全部数据为合成数据。本阶段没有修改网页、快速模式算法或网络协议，也没有推送或部署。网络参数在对局期间固定，动作揭示后仅更新公开历史。','',
      '## 1. 本轮问题与实验控制','',
      '本轮验证三件事：局部安全约束内是否存在利用对手的空间；相同输入下非线性模型是否比线性模型更会预测；这种差异是否转化为完整对局成绩。',
      '没有训练价值网络，也没有把行为网络接入原完整 Bayesian MCTS。为单独比较预测模块，采用统一的一步／两步全分支前瞻，末端使用精确均衡价值；这是一项控制变量实验，不宣称是最终完整规划器。','',
      '## 2. 精确诊断：知道对手以后能提高多少','',
      '缩小规则为两轮、每轮两回合、初始筹码 10。仍使用生产的 delta=0.0199/505，因此比把预算按短局平均分配更保守。下面是完整动态规划得到的期望得分，无蒙特卡洛抽样误差。',
      '本节沿用第一阶段的固定规则对手；后面的完整规则实验使用新增的随机参数行为族。两节同名对手不表示参数完全相同，不能逐行直接比较得分。',
      'safe oracle 是已知该对手条件概率时、当前逐步约束下的最优策略。它不是仅受整局 0.02 总预算约束的全局最优。无约束列仅用于诊断，不作为待接入策略。','',
      '| 对手 | 均衡对该对手 | safe oracle | 提升 | 无约束诊断 | safe oracle 遭整局最佳反制 |',
      '|---|---|---|---|---|---|']
    for r in oracle['results']:
        lines.append(f'| {r["opponent"]} | {r["equilibrium"]:.6f} | {r["safe_oracle"]:.6f} | {r["safe_gain"]:+.6f} | {r["unconstrained_diagnostic"]:.6f} | {r["full_best_response_score"]:.6f} |')
    lines+=['','有些对手上均衡已接近满分，额外提升自然很小；对记忆反应型对手则存在明显空间。小规模结果不能直接外推到五轮、每轮一百回合的完整游戏。','',
      '## 3. 训练数据、网络和信息边界','',
      '| 集合 | 独立玩家历史 | 动作观测 |','|---|---|---|']
    for name,row in data['data']['splits'].items():
        lines.append(f'| {name} | {row["profiles"]} | {row["observations"]} |')
    lines+=['',
      '- 每个独立玩家历史包含两局完整规则对局；同一历史不跨训练、验证、测试集合。生成器使用独立种子命名空间。',
      '- 训练覆盖固定偏好、开枪后防御、筹码敏感、防御连续次数、周期动作、逐轮换风格六类。模仿与伺机出招两类只进入测试；测试集不参与早停或模型选择。',
      '- 收集数据时电脑混合均衡和随机探索以覆盖不同局面。这个合成数据收集策略不是受保护的待接入策略，不对它声称 0.02 保证。',
      '- 两个学习模型输入相同的 107 个数：公开局面、双方绝对筹码、玩家均衡概率、最近八条已揭示事件及局／轮边界。输入不含对手类型、真实参数、当前未公开动作、未来动作或 oracle 概率。',
      '- 线性模型使用掩码 softmax；神经网络为 107→64(tanh)→3。通过合法动作掩码保证非法动作概率为零。均使用实际采样动作作交叉熵训练标签。',
      '- 神经网络没有人工指定“连续防御后应装弹”的得分；但历史长度、网络结构、训练行为分布仍是建模选择。它只能利用八条历史，不能自动记住任意长的规律。',
      '- 原贝叶斯模型未重新拟合先验，也只使用原来的上下文特征。因此它与学习模型的差异同时包含训练数据和输入表达差异；神经网络与线性模型的比较才更直接检验非线性结构。','',
      '| 模型 | 参数数 | 权重原始字节 | 最佳验证轮次 | 验证 NLL | 本机训练秒 |','|---|---|---|---|---|---|']
    for name,r in training.items():
        lines.append(f'| {name} | {r["parameters"]} | {r["weight_bytes"]} | {r["best_epoch"]} | {r["validation_nll"]:.4f} | {r["seconds"]:.3f} |')
    lines+=['','训练最多 50 轮，批量 256，Adam 学习率 0.003；连续八轮验证集未改善则早停，恢复验证最优权重。以独立玩家历史等权平均 NLL 选择轮次。训练仅使用 CPU/NumPy。','',
      '## 4. 独立预测测试：更强的表达与泛化边界','',
      '下表为动作预测负对数似然（NLL，越低越好），每类 32 条完整独立历史。差值区间按整条玩家历史配对 bootstrap 2,000 次，避免把相关回合当成独立样本。区间为探索性、未作跨八类的多重比较校正。','',
      '| 类型 | 是否训练外 | 贝叶斯 | 线性 | 神经网络 | 神经−线性 | 配对 95% 区间 |','|---|---|---|---|---|---|---|']
    for r in prediction:
        m=r['metrics']; ci=r['difference_ci95']
        lines.append(f'| {r["family"]} | {r["unseen"]} | {m["bayes"]["nll"]:.4f} | {m["linear"]["nll"]:.4f} | {m["neural"]["nll"]:.4f} | {r["neural_minus_linear"]:+.4f} | [{ci[0]:+.4f}, {ci[1]:+.4f}] |')
    for unseen in (False,True):
        subset=[r for r in prediction if r['unseen']==unseen]
        linear=np.mean([r['metrics']['linear']['nll'] for r in subset]); neural=np.mean([r['metrics']['neural']['nll'] for r in subset])
        lines.append(f'\n{"未见行为" if unseen else "已覆盖行为"}等权平均 NLL：线性 {linear:.4f}、神经网络 {neural:.4f}；相对变化 {(neural/linear-1)*100:+.1f}%。')
    lines+=['','不能从某几类合成行为推断真人泛化。这里保留训练外模型表现变差的结果，不用测试集重新调整权重。prediction.json 另含基于生成器真实分布计算的条件 KL 和概率平方误差，真实分布仅用于评价。','',
      '## 5. 完整规则对局：同一个规划器，只换预测模块','',
      f'每种行为 {n} 个独立合成玩家，每个控制器对每位玩家打一局，总计 {n*len(FAMILIES)*6:,} 局。使用新的 games 随机种子空间，所有控制器从无历史开始，第一步实际行动均采用均衡。',
      'd1/d2 表示前瞻一次／两次同时行动（包括选弹）。两步搜索枚举所有合法分支，各分支更新贝叶斯信念或历史窗口；尾部以均衡价值截断。oracle_d2 知道对手条件分布，但也只有两步前瞻，因此不是完整游戏得分上界。',
      '这些成绩不可直接与第一阶段的 MCTS 结果相减：本阶段对手、历史初始化和规划器均不同。d1/d2 对照仅说明当前短前瞻的深度效果，不能代替原 MCTS 的模拟次数扫描。','',
      '| 类型 | 均衡 | Bayes d1 | Bayes d2 | 线性 d2 | 神经 d2 | Oracle d2 |','|---|---|---|---|---|---|---|']
    names=('equilibrium','bayes_d1','bayes_d2','linear_d2','neural_d2','oracle_d2')
    for family in FAMILIES:
        ps=games['results'][family]['planners']
        lines.append('| '+family+' | '+' | '.join(f'{ps[k]["score"]:.4f}' for k in names)+' |')
    lines+=['','各类型等量采样，下表对全部独立玩家做等权配对汇总。主区间为分布无关的 Hoeffding 95% 区间；它较保守。每类对手的区间与 bootstrap 辅助区间见 games.json；胜率、负率、平局率和各自 Wilson 区间见 scores.csv。','',
            '| 比较 | 平均得分差 | 95% 区间 |','|---|---|---|']
    aggregate={}
    for name,base in (('neural_d2','linear_d2'),('neural_d2','bayes_d2'),('bayes_d2','bayes_d1'),('oracle_d2','bayes_d2')):
        diff=np.concatenate([np.asarray(games['results'][f]['scores'][name])-games['results'][f]['scores'][base] for f in FAMILIES])
        ci=interval(diff); aggregate[f'{name}-{base}']=dict(mean=float(diff.mean()),ci95=ci,bootstrap_ci95=paired_bootstrap(diff))
        lines.append(f'| {name} − {base} | {diff.mean():+.5f} | [{ci[0]:+.5f}, {ci[1]:+.5f}] |')
    (destination/'aggregate.json').write_text(json.dumps(aggregate,indent=2),encoding='utf-8')
    lines+=['','## 6. 安全、计算成本与下一步','',
      '安全检查仍使用原始精确均衡价值，不由神经网络近似。实际动作及所有搜索节点均受原 delta 约束；网络预测错误会影响利用对手的效果，不会自行扩大允许的最坏损失。','',
      '| 控制器 | 决策数 | 平均规划毫秒 | 搜索节点数 | 最大单步损失 | 数值回退数 |','|---|---|---|---|---|---|']
    maximum=0.
    for name in names:
        ds=[games['results'][f]['diagnostics'][name] for f in FAMILIES]
        count=sum(d['decisions'] for d in ds); secs=sum(d['seconds'] for d in ds)
        loss=max(d['max_local_loss'] for d in ds); maximum=max(maximum,loss)
        lines.append(f'| {name} | {count} | {secs/count*1000:.3f} | {sum(d["nodes"] for d in ds)} | {loss:.12g} | {sum(d["fallbacks"] for d in ds)} |')
    if maximum>DELTA+SAFETY_TOLERANCE: raise ArithmeticError('Observed safety violation')
    lines+=['',
      '规划耗时包含特征构建和搜索，不含函数外的真实观测更新。四个进程并行运行，包含首次调用成本；这不是手机性能基准。',
      f'神经网络原始权重仅 {net["weight_bytes"]/1024:.1f} KiB，但这是行为预测模块大小。系统仍依赖约 402 MiB 的精确均衡表，不能把小网络大小当作整个 AI 的部署体积。',
      f'完整对局实验墙钟耗时 {games["seconds"]:.2f} 秒。共 18 项回归测试通过，新增覆盖梯度、非线性学习、序列边界、无未来信息泄漏、网络参数不在线修改、安全约束及独立 LP 的 oracle 核验。','',
      '本轮支持继续研究小型行为模块，但不支持直接宣称神经网络普遍强于规则模型。下一步应优先处理未见风格的预测退化，再用更充分的完整规划检查预测收益能否稳定转化为整局得分；本轮尚未训练用于加速终局模拟的价值网络。',
      '保留线性模型作为低成本基线。后续修改使用新验证／测试种子，不回头用本次测试结果调参并继续称其为独立测试。','',
      '## 7. 复现','',
      '运行步骤和实验边界见上级 README.md。本目录保存紧凑结果、两个可加载权重和源文件／数据集哈希；较大的观测数组留在 research/artifacts/phase2。',
      f'环境：Python {provenance["python"]}，NumPy {provenance["numpy"]}，{provenance["platform"]}；本轮设置 OPENBLAS_NUM_THREADS=1。','']
    (destination/'REPORT.md').write_text('\n'.join(lines),encoding='utf-8')
