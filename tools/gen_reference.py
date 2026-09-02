# -*- coding: utf-8 -*-
"""生成 AI 移植最强对照数据 + 存档新基线（放宽随机检测阈值后）。

用法：python web/tools/gen_reference.py
1. 复用项目根目录 evaluation.py（已验证的 Python 镜像）按现行配置（差桶、N0=10、
   eps=0.05、kappa=5、随机检测新阈值 JS<0.03/样本≥20）计算完整策略表，
   导出 web/test/reference.json 供 test/verify_ai.js 第 3 层逐状态 diff；
2. 顺带跑两个配置的镜像评估并存档新基线（纯均衡 / 当前配置）。
"""
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
import evaluation as ev


def main():
    t0 = time.time()
    eq_comp, eq_player, v_values = ev.parse_header(ev.HEADER_PATH)
    counts, totals, fired = ev.load_log(ev.LOG_PATH)
    pool = ev.pool_stats(counts, totals)

    print("随机检测触发状态（新阈值 JS<%.2f、样本>=%g）: %s" % (
        ev.RANDOM_JS_THRESHOLD, ev.MIN_SAMPLES_FOR_RANDOM_CHECK, fired))
    print("头文件均衡值 V(0,0) = %.4f" % v_values[0, 0])

    # ---- 现行配置（与 C++/JS 完全一致：纯差桶） ----
    post = ev.build_posterior(counts, totals, eq_player, kappa=ev.DIRICHLET_KAPPA,
                              gen="bucket", pool=pool)
    V_br, V_eqm, br = ev.solve_br(post, eq_comp)
    import numpy as np
    wtab = np.zeros((11, 11))
    for (b1, b2) in ev.STATES:
        wtab[b1, b2] = pool[1][ev.diff_bucket(b1, b2), ev.support_type(b1)]
    comp = ev.comp_strategy(post, eq_comp, V_br, V_eqm, br, totals,
                            ev.EV_ADVANTAGE_EPSILON, ev.N0, w_table=wtab)

    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test", "reference.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({
            "now_sec": int(time.time()),   # 验证脚本须用同一时刻计算时间衰减权重，保证对比确定
            "comp": comp.tolist(),
            "br": [[int(br[b1, b2]) for b2 in range(11)] for b1 in range(11)],
            "V_br": V_br.tolist(),
            "V_eqm": V_eqm.tolist(),
        }, f)
    print("已导出参照数据: %s" % os.path.relpath(out_path, ROOT))

    # ---- 新基线存档（镜像玩家 = 日志后验，静止习惯模型） ----
    true_player = ev.build_posterior(counts, totals, eq_player, kappa=ev.DIRICHLET_KAPPA)

    post_b = ev.build_posterior(counts, totals, eq_player, kappa=ev.DIRICHLET_KAPPA,
                                gen="none", pool=pool)
    V_br_b, V_eqm_b, br_b = ev.solve_br(post_b, eq_comp)
    comp_b = ev.comp_strategy(post_b, eq_comp, V_br_b, V_eqm_b, br_b, totals,
                              1e9, ev.N0, w_table=totals)
    win_b = ev.simulate(comp_b, true_player)
    safety_b = ev.value_vs_eq_player(comp_b, eq_player)
    print("基线（纯均衡）           模拟玩家 %.2f%%   vs理性玩家 %.2f%%" % (
        win_b * 100, safety_b * 100))

    win_c = ev.simulate(comp, true_player)
    safety_c = ev.value_vs_eq_player(comp, eq_player)
    print("当前配置（差桶,N0=10,新阈值）模拟玩家 %.2f%%   vs理性玩家 %.2f%%" % (
        win_c * 100, safety_c * 100))
    print("总耗时 %.1fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
