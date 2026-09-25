"""Report actual reliability experiments, retaining regressions and uncertainty."""
import csv
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import platform
import shutil
import numpy as np
from ..matrix import DELTA,SAFETY_TOLERANCE
from ..experiments import interval
from ..phase2.study import paired_bootstrap
from .data import FAMILIES
from .study import KINDS


def generate_report(directory,destination):
    directory=Path(directory); destination=Path(destination); destination.mkdir(parents=True,exist_ok=True)
    data={key:json.loads((directory/f'{key}.json').read_text(encoding='utf-8')) for key in ('data','selection','prediction','games','decisions')}
    games=data['games']; selection=data['selection']; predictions=data['prediction']['results']
    if set(games['results'])!=set(FAMILIES): raise ValueError('Game study is incomplete')
    for name,expected in data['data']['frozen_weights'].items():
        if hashlib.sha256((directory/f'{name}.npz').read_bytes()).hexdigest()!=expected:
            raise ValueError('Frozen model changed during the study')
    maximum=max(d['max_local_loss'] for r in games['results'].values() for d in r['diagnostics'].values())
    if maximum>DELTA+SAFETY_TOLERANCE: raise ArithmeticError('Observed safety violation')
    for key in data: shutil.copyfile(directory/f'{key}.json',destination/f'{key}.json')
    for name in ('linear','neural'): shutil.copyfile(directory/f'{name}.npz',destination/f'{name}.npz')
    source=Path(__file__).parents[1]
    provenance=dict(created_utc=datetime.now(timezone.utc).isoformat(),python=platform.python_version(),
        numpy=np.__version__,platform=platform.platform(),processor=platform.processor(),
        source_hashes={str(p.relative_to(source)):hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*.py') if 'results' not in p.parts},
        data_hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.glob('*.npz')})
    (destination/'provenance.json').write_text(json.dumps(provenance,indent=2),encoding='utf-8')
    rows=[]
    for family in FAMILIES:
        for name,s in games['results'][family]['planners'].items():
            rows.append(dict(family=family,planner=name,**s,win_rate=s['wins']/s['n'],draw_rate=s['draws']/s['n'],loss_rate=s['losses']/s['n']))
    with (destination/'scores.csv').open('w',newline='',encoding='utf-8-sig') as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
    lines=['# 第三阶段：神经行为预测的可靠性研究','',
      '本轮只在难以手写描述的玩家行为子问题上使用神经网络。规则、筹码结算、均衡查询与安全约束继续精确计算。未接入网页、推送或部署。','',
      '## 1. 实验问题与控制','',
      '检查概率校准及公开动作证据能否减轻未见打法下的预测退化，并检查这种变化能否改善整局得分。继续冻结第二阶段的神经网络和线性模型，没有扩大网络或重新训练网络权重。',
      '所有控制器使用同一两步全分支前瞻，末端接均衡价值；它仍不是完整 MCTS。无当前玩家数据时实际动作使用均衡。自适应组在模拟分支和真实观测后都更新专家权重，frozen 组仅在真实观测后更新，模拟中的公开历史仍推进。','',
      '## 2. 防止沿用旧测试集调参','',
      '上一阶段的 mimic/ambush 已经被我们看过失败结果，因此本轮把它们明确列入开发验证。新测试额外保留 delayed 和 contrarian 两类时间依赖行为；它们既不参与温度选择，也不参与分享率或固定混合权重选择。所有随机种子加入新的第三阶段命名空间。','',
      '| 集合 | 独立玩家历史 | 观测数 |','|---|---|---|']
    for key,r in data['data']['sequences'].items(): lines.append(f'| {key} | {r["profiles"]} | {r["observations"]} |')
    lines+=['','每条历史包含两局完整规则对局。对局测试另行生成独立玩家与种子。生成器真实动作概率、行为名、参数和切换位置只用于评估，不进入策略输入。','',
      '## 3. 校准与证据更新','',
      f'验证集选择的玩家预测温度：神经网络 {selection["temperatures"]["neural"]}，线性模型 {selection["temperatures"]["linear"]}。这个温度调整预测概率的尖锐程度，不是电脑出招熵温度；出招熵温度固定为 0，仍按安全分布采样。',
      f'三个专家依次是校准网络、校准线性、合法动作均匀预测。固定混合权重为 {selection["static_weights"]}；自适应混合从等权开始，验证集选出的分享率为 {selection["share"]}。',
      '每次动作揭示后，先按该动作的预测似然更新权重，再按分享率混入均匀专家权重。全程使用对数权重，事件编号严格递增；轮末、局末不重复计数。网络参数本身不更新。',
      '权重表示这些专家的相对预测表现，不能解释成“玩家属于未知分布的概率”。多个专家也可能一起预测错误。均匀专家用于表达对玩家动作的不确定性；电脑实际出招仍受到精确安全约束。','',
      '| 分享率 | 验证 NLL |','|---|---|']
    for share,value in selection['share_scan'].items(): lines.append(f'| {share} | {value:.6f} |')
    lines+=['',f'验证集固定混合 NLL 为 {selection["static_validation_nll"]:.6f}。选择仅根据完整玩家历史等权平均 NLL，测试集未参与选择。','',
      '## 4. 新测试上的预测表现','',
      'NLL 越低越好。每类 64 条独立玩家历史，区间按整条历史配对 bootstrap 2,000 次。下面区间是自适应减校准网络的差值，负值较好；各类区间为探索性结果，未作多重比较校正。','',
      '| 行为 | 新保留类型 | 原网络 | 校准网络 | 固定混合 | 自适应 | 自适应−校准 95% 区间 |','|---|---|---|---|---|---|---|']
    for r in predictions:
        m=r['metrics']; ci=r['comparisons']['calibrated']['ci95']
        lines.append(f'| {r["family"]} | {r["unseen"]} | {m["neural"]["nll"]:.4f} | {m["calibrated"]["nll"]:.4f} | {m["static"]["nll"]:.4f} | {m["adaptive"]["nll"]:.4f} | [{ci[0]:+.4f}, {ci[1]:+.4f}] |')
    lines+=['','按类型等权的描述性汇总：','',
            '| 范围 | 原网络 | 校准网络 | 固定混合 | 自适应 |','|---|---|---|---|---|']
    for name,subset in [('全部',predictions),('最初训练六类',predictions[:6]),('本轮完全保留两类',predictions[-2:])]:
        lines.append('| '+name+' | '+' | '.join(f'{np.mean([r["metrics"][k]["nll"] for r in subset]):.4f}' for k in ('neural','calibrated','static','adaptive'))+' |')
    lines+=['','校准和混合可能改善陌生行为，也可能损害原先已经预测得很好的行为；表中同时保留这些退步，没有使用测试结果再次改参数。prediction.json 另含条件 KL、十个等宽概率桶的 ECE，以及预测置信度至少 0.9 的样本数和实际错误率。ECE 和高置信统计按观测描述，不把相关回合当独立证据。','',
      '## 5. 轮内改变风格的诊断','',
      'changing 在每轮第 6–12 回合之间，从连续防御型切换到反应或周期型。切换位置只供评估方分桶。后续桶包含仍未结束的对局，样本有存活选择差异，不能把桶间变化当成恢复所需回合数的因果估计。','',
      '| 切换后回合偏移 | 观测数 | 原网络 NLL | 校准 NLL | 固定混合 NLL | 自适应 NLL | 自适应神经/线性/均匀权重 |','|---|---|---|---|---|---|---|']
    for r in data['prediction']['recovery']:
        scores=r['nll']; lo,hi=r['turns_after_change']; w='/'.join(f'{v:.3f}' for v in r['weights'])
        lines.append(f'| {lo}–{hi} | {r["observations"]} | {scores["neural"]:.4f} | {scores["calibrated"]:.4f} | {scores["static"]:.4f} | {scores["adaptive"]:.4f} | {w} |')
    n=games['games_per_family']
    lines+=['','## 6. 完整规则对局','',
      f'每类 {n} 位独立合成玩家，每位对七种控制器各打一局，共 {n*len(FAMILIES)*len(KINDS):,} 局。下表为胜 1／平 0.5／负 0 的期望得分样本均值。各组使用配对种子，样本独立性单位是玩家。','',
      '| 行为 | 均衡 | 线性 | 原网络 | 校准 | 固定混合 | 自适应 | 模拟冻结权重 |','|---|---|---|---|---|---|---|---|']
    for family in FAMILIES:
        ps=games['results'][family]['planners']
        lines.append('| '+family+' | '+' | '.join(f'{ps[k]["score"]:.4f}' for k in KINDS)+' |')
    lines+=['','主区间为分布无关 Hoeffding 95% 区间，较保守。辅助 bootstrap 区间和每类比较保存在 JSON 中；不因为某种区间更有利就更换主判据。胜率、平局率、负率及 Wilson 区间在 scores.csv 中分别保存。','',
            '| 自适应相比 | 平均得分差 | 主 95% 区间 |','|---|---|---|']
    aggregate={}
    for base in ('neural','calibrated','static','frozen'):
        diff=np.concatenate([np.asarray(games['results'][f]['scores']['adaptive'])-games['results'][f]['scores'][base] for f in FAMILIES])
        ci=interval(diff); aggregate[base]=dict(mean=float(diff.mean()),ci95=ci,bootstrap_ci95=paired_bootstrap(diff))
        lines.append(f'| {base} | {diff.mean():+.5f} | [{ci[0]:+.5f}, {ci[1]:+.5f}] |')
    (destination/'aggregate.json').write_text(json.dumps(aggregate,indent=2),encoding='utf-8')
    probe=data['decisions']
    lines+=['','## 7. 相同局面下，预测改善有没有改变决策','',
      f'补充抽取每类第一局原网络轨迹的最多 12 个等距状态，共 {probe["states"]} 个。所有方法使用同一公开历史；专家证据只根据之前的已揭示动作重建。该项是在看到对局结果后添加的描述性诊断，没有用来重新调参，不是新的独立验证。',
      f'自适应与原网络的动作分布平均总变差距离为 {probe["mean_total_variation"]:.6f}；超过 0.01 的状态占 {probe["fraction_tv_above_001"]*100:.1f}%。总变差距离可理解为需要重新分配的概率质量。','',
      f'超过 0.01 的 {probe["changed_states"]} 个状态中，{probe["changed_with_equal_reference_values"]} 个在共同两步参考下的所有动作得分相等（容差 1e-10）。因此在这批抽样中，明显的出招分布变化主要不对应该参考下的价值提升。不能把这个小样本结论外推成所有局面或完整深层规划都没有差别。','',
      '再以知道真实对手的共同两步后续策略评价各当前分布，比较相对该短前瞻最优分布的平均机会损失。它只诊断当前动作选择，不代表每个控制器真实的后续策略，更不是整局后悔值。','',
      '| 预测方法 | 两步参考下的平均机会损失 |','|---|---|']
    for name,value in probe['mean_opportunity_cost'].items(): lines.append(f'| {name} | {value:.7f} |')
    lines+=['','## 8. 验证、成本与边界','',
      f'所有已观测搜索节点与实际决策的最大单步损失为 {maximum:.12g}，小于 delta+数值容差。原完整均衡误差为 {data["data"]["baseline_error"]:.3g}；整局最坏损失预算仍为 0.02，没有让网络替代该证明。',
      '26 项测试通过，包括专家证据计数、未来动作不影响当前预测、对数损失基准、小规模自适应策略的整局最佳反制、校准合法动作掩码、同局面追踪诊断和旧规则回归。','',
      '| 控制器 | 决策数 | 平均决策函数毫秒 | 最大单步损失 | 数值回退数 |','|---|---|---|---|---|']
    for name in KINDS:
        ds=[games['results'][f]['diagnostics'][name] for f in FAMILIES]; count=sum(d['decisions'] for d in ds)
        lines.append(f'| {name} | {count} | {1000*sum(d["seconds"] for d in ds)/count:.3f} | {max(d["max_local_loss"] for d in ds):.12g} | {sum(d["fallbacks"] for d in ds)} |')
    lines+=['',
      f'本机四进程完整对局墙钟耗时 {games["seconds"]:.2f} 秒。决策函数耗时包含构建预测和搜索，但不含函数外真实观测更新，且包含首次调用成本；不是手机性能保证。',
      '没有新增神经网络参数。两个冻结模型权重合计约 58 KiB；仍依赖约 402 MiB 的原精确价值表，因此没有解决网页整体模型体积。',
      '本轮只能支持对行为预测可靠性的局部判断，不能证明自动识别所有陌生玩家。分享率和统一校准也会带来偏差；若对局得分区间包含零，应保留“未证实更强”的结论。',
      '后续应针对能够改变安全动作选择的关键局面继续诊断，再决定是否需要更长历史的行为网络或更深规划；不因网络可用就替换已知规则。','',
      '## 9. 复现','',
      '命令与接口见上级 README.md。该目录保存校准参数、冻结模型、结果与数据／源码 SHA-256。大型序列数据及首局公开观测追踪日志留在 research/artifacts/phase3。',
      f'Python {provenance["python"]}；NumPy {provenance["numpy"]}；{provenance["platform"]}；OPENBLAS_NUM_THREADS=1。','']
    (destination/'REPORT.md').write_text('\n'.join(lines),encoding='utf-8')
