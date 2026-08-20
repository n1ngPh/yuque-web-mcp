#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真实轨迹生成器：复刻浏览器 feilin 采集的滑块轨迹特征。

源自 /tmp/real_track_template.json 的逆向统计：
  - 拖拽 65 点（含 down 后第一点 + 回退点），峰值 860，回退到 857，总距离 280px。
  - x 位移：加速段 [0,1,1,3,2,4,4,5] -> 巡航段(5px/点，偶插 6) -> 减速段 [4,4,3,2,1,1,1] -> 回退 -3。
  - y 抖动：±3px，围绕 395 平滑游走。
  - 时间：hover≈2700ms，hover→down≈400ms，down→首拖拽点≈13ms，
          拖拽点间隔 11-45ms（均值 23ms，约 10% 概率 40-45ms 停顿），
          松手后漂移到 (986,454)。
"""
import random

START_X, START_Y = 580, 395
DIST = 280


def _gen_xs():
    """返回 65 个拖拽点 x（580..860..857）。位移分布与真实模板逐项一致：
    0:1  1:5  2:2  3:2  4:4  5:45  6:4  -3:1（sum=277，峰值位移 280）。"""
    accel = [0, 1, 1, 3, 2, 4, 4]       # 7 位移，sum=15
    cruise = [5] * 45 + [6] * 4         # 49 位移，sum=249
    decel = [4, 4, 3, 2, 1, 1, 1]       # 7 位移，sum=16
    random.shuffle(cruise)
    steps = accel + cruise + decel + [-3]
    xs = [START_X]
    for d in steps:
        xs.append(xs[-1] + d)
    assert len(xs) == 65 and max(xs) == 860 and xs[-1] == 857, (len(xs), max(xs), xs[-1])
    return xs


def _gen_ys():
    """65 个拖拽点 y：平滑随机游走，392..397。"""
    y = START_Y
    ys = [y]
    for _ in range(64):
        y += random.choice([-1, -1, 0, 0, 0, 0, 0, 1, 1])
        y = max(392, min(397, y))
        ys.append(y)
    return ys


def _gen_ts(t_first):
    """65 个拖拽点相对时间（ms），从 t_first 起，间隔 11-45ms。"""
    ts = [t_first]
    t = t_first
    for _ in range(64):
        if random.random() < 0.10:
            dt = random.randint(40, 45)
        else:
            dt = random.randint(11, 30)
        t += dt
        ts.append(t)
    return ts


def gen_drag():
    """生成一次拖拽。返回与 solve_v9 兼容的 dict。所有 t 相对 TrackStartTime(=0)。"""
    t_hover = random.randint(2600, 2800)
    t_down = t_hover + random.randint(390, 420)          # hover→down ≈400ms
    t_first = t_down + random.randint(10, 16)            # down→首拖拽点 ≈13ms

    xs = _gen_xs()
    ys = _gen_ys()
    ts = _gen_ts(t_first)
    drag_pts = [(xs[i], ys[i], ts[i]) for i in range(65)]

    t_drift = ts[-1] + random.randint(12, 20)
    drift_x = 986
    drift_y = 454

    # TrackList 结构（与真实一致）
    mp_parts = [f"{START_X},{START_Y},{t_hover},1"]
    for x, y, t in drag_pts:
        mp_parts.append(f"{x},{y},{t},1")
    mm_parts = [f"{START_X},{START_Y},{t_down},1"]
    for x, y, t in drag_pts:
        mm_parts.append(f"{x},{y},{t},1")
    mm_parts.append(f"{drift_x},{drift_y},{t_drift},1")

    mc = f"{START_X},{START_Y},{t_down + 1}, ,1"
    tracklist = {
        "mc": mc, "tc": "", "mu": "", "te": "",
        "mp": "|".join(mp_parts), "tmv": "", "mm": "|".join(mm_parts),
        "ks": "", "fi": "",
    }

    # Log3 behavior（mousemove + pointerEvent）
    mmove = [{"x": START_X, "y": START_Y, "t": t_hover}]
    for x, y, t in drag_pts:
        mmove.append({"x": x, "y": y, "t": t})
    mmove.append({"x": drift_x, "y": drift_y, "t": t_drift})
    pevent = [{"p": 0.5, "b": 1, "pt": 1, "w": 1, "h": 1, "x": START_X, "y": START_Y, "it": True, "t": t_down}]

    return {
        "points": drag_pts, "t_hover": t_hover, "t_down": t_down,
        "duration_ms": t_drift,  # 最后事件(漂移)相对时间，用于回溯 TrackStartTime
        "tracklist": tracklist, "mmove": mmove, "pevent": pevent,
    }


if __name__ == "__main__":
    d = gen_drag()
    mp = d["tracklist"]["mp"].split("|")
    mm = d["tracklist"]["mm"].split("|")
    print("mp 点数 =", len(mp), " mm 点数 =", len(mm))
    print("mc =", d["tracklist"]["mc"])
    xs = [int(p.split(",")[0]) for p in mp]
    print("x 范围:", min(xs), "->", max(xs), " 末点:", xs[-1])
    print("t_hover =", d["t_hover"], " t_down =", d["t_down"], " duration =", d["duration_ms"])
    print("mp 首点 =", mp[0], " mm 首点 =", mm[0], " mm 末点 =", mm[-1])
