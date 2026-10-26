"""生成示例数据：python3 samples/generate_samples.py

目录结构（演示递归扫描、不同表结构、不同插件匹配）：
  samples/ranging/2026-10-20/anchor01_walk.csv     ts 为毫秒时间戳
  samples/ranging/2026-10-20/anchor02_static.csv
  samples/ranging/2026-10-21/corridor/run_01.csv   列名大写、ts 为秒级时间戳
  samples/ranging/2026-10-21/corridor/run_02.csv   ts 为从 0 开始的相对秒
  samples/environment/sensor_2026-10.csv           日期字符串时间列
  samples/misc/城市统计_gbk.csv                     GBK 编码
  samples/misc/orders_semicolon.csv                分号分隔、带引号字段
"""
import csv
import math
import os
import random

ROOT = os.path.dirname(os.path.abspath(__file__))
random.seed(7)


def path(*parts):
    p = os.path.join(ROOT, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def smoother():
    """简单的离群抑制 + 指数平滑"""
    state = [None]

    def step(x):
        v = state[0]
        if v is None:
            v = x
        elif abs(x - v) < 0.5:
            v = 0.75 * v + 0.25 * x
        else:
            v = 0.95 * v + 0.05 * x
        state[0] = v
        return v
    return step


def ranging_rows(n, hz, distance_at, nlos_rate=0.02):
    """模拟测距日志：dis / dis_main 为两路带噪声与离群的距离，*_sm 为对应的平滑结果；
    rssi_init / rssi_refl 为两路信号强度，随距离衰减，NLOS 时首路明显减弱。"""
    rows = []
    sm, sm_main = smoother(), smoother()
    for i in range(n):
        t = i / hz
        d = distance_at(t)
        nlos = random.random() < nlos_rate
        outlier = random.uniform(0.6, 2.5) if nlos else 0.0
        dis = max(0.05, d + random.gauss(0, 0.06 + 0.01 * d) + outlier)
        dis_main = max(0.05, d + 0.15 + 0.02 * d + random.gauss(0, 0.05 + 0.008 * d) + 0.5 * outlier)
        rssi_init = -42 - 20 * math.log10(max(d, 0.3)) + random.gauss(0, 2.0) - (7 if nlos else 0)
        rssi_refl = rssi_init - random.uniform(3, 9) + (5 if nlos else 0) + random.gauss(0, 1.5)
        rows.append((t, dis, sm(dis), dis_main, sm_main(dis_main), rssi_init, rssi_refl, nlos))
    return rows


def fmt_row(dis, dis_sm, dis_main, dis_main_sm, rssi_init, rssi_refl):
    return [f"{dis:.3f}", f"{dis_sm:.3f}", f"{dis_main:.3f}", f"{dis_main_sm:.3f}", f"{rssi_init:.1f}", f"{rssi_refl:.1f}"]


RANGING_COLS = ["dis", "dis_sm", "dis_main", "dis_main_sm", "rssi_init", "rssi_refl"]


def write_ranging_ms(filename, start_ms, n, hz, distance_at, anchor):
    with open(path(*filename), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["ts", "anchor", "seq", *RANGING_COLS, "quality"])
        for i, (t, *vals, nlos) in enumerate(ranging_rows(n, hz, distance_at)):
            quality = max(0, min(100, int(95 - abs(vals[0] - vals[1]) * 60 + random.gauss(0, 3))))
            row = fmt_row(*vals)
            if random.random() < 0.004:
                row[4] = ""  # 偶尔缺失 rssi_init（空字符串）
            w.writerow([int(start_ms + t * 1000), anchor, i, *row, quality])


def walk(t):  # 来回走动 1 ~ 14 米
    return 7.5 + 6.5 * math.sin(2 * math.pi * t / 120) + 0.4 * math.sin(2 * math.pi * t / 9)


def static(t):
    return 3.0 + 0.02 * math.sin(t / 5)


def corridor(t):  # 匀速远离后停顿
    return min(1.0 + 0.35 * t, 22.0)


def corridor_back(t):
    return max(18.0 - 0.3 * t, 1.5)


write_ranging_ms(("ranging", "2026-10-20", "anchor01_walk.csv"), 1760947200000, 3000, 10, walk, "A01")
write_ranging_ms(("ranging", "2026-10-20", "anchor02_static.csv"), 1760950800000, 1200, 10, static, "A02")

# 列名大写 + 秒级时间戳（带小数），演示列名不区分大小写与时间戳自动识别
with open(path("ranging", "2026-10-21", "corridor", "run_01.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["TS", *[c.upper() for c in RANGING_COLS], "NLOS"])
    for t, *vals, nlos in ranging_rows(1500, 20, corridor, nlos_rate=0.04):
        w.writerow([f"{1761037200 + t:.3f}", *fmt_row(*vals), int(nlos)])

# 相对时间（秒），演示非时间戳的 ts
with open(path("ranging", "2026-10-21", "corridor", "run_02.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["ts", *RANGING_COLS, "NLOS"])
    for t, *vals, nlos in ranging_rows(1100, 20, corridor_back, nlos_rate=0.03):
        w.writerow([f"{t:.2f}", *fmt_row(*vals), int(nlos)])

# 环境传感器：日期字符串时间列
with open(path("environment", "sensor_2026-10.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["timestamp", "temperature", "humidity", "pressure", "co2"])
    for i in range(24 * 12 * 7):  # 7 天，每 5 分钟
        minutes = i * 5
        day, rem = divmod(minutes, 24 * 60)
        hh, mm = divmod(rem, 60)
        hour = minutes / 60
        temp = 21 + 3.5 * math.sin(2 * math.pi * (hour - 9) / 24) + random.gauss(0, 0.25)
        hum = 52 - 8 * math.sin(2 * math.pi * (hour - 9) / 24) + random.gauss(0, 1.2)
        pres = 1012 + 4 * math.sin(2 * math.pi * hour / (24 * 3.5)) + random.gauss(0, 0.3)
        occupied = 9 <= (hour % 24) <= 18 and day % 7 < 5
        co2 = 420 + (380 if occupied else 30) * (0.6 + 0.4 * random.random())
        w.writerow([f"2026-10-{1 + day:02d} {hh:02d}:{mm:02d}:00", f"{temp:.2f}", f"{hum:.1f}", f"{pres:.1f}", int(co2)])

# GBK 编码 + 中文列名（无时间列，只会匹配「通用统计」）
cities = [("北京", 2185, 16410, 43760), ("上海", 2487, 6340, 47218), ("广州", 1882, 7434, 30355),
          ("深圳", 1779, 1997, 34606), ("成都", 2140, 14335, 22075), ("杭州", 1252, 16850, 20059),
          ("武汉", 1377, 8569, 20011), ("西安", 1307, 10108, 12010), ("南京", 954, 6587, 17421),
          ("重庆", 3191, 82400, 30145), ("天津", 1364, 11966, 16737), ("苏州", 1295, 8657, 24653)]
with open(path("misc", "城市统计_gbk.csv"), "w", newline="", encoding="gbk") as f:
    w = csv.writer(f)
    w.writerow(["城市", "常住人口(万)", "面积(平方公里)", "GDP(亿元)", "人均GDP(万元)"])
    for name, pop, area, gdp in cities:
        w.writerow([name, pop, area, gdp, f"{gdp / pop:.2f}"])

# 分号分隔 + 带逗号/引号的字段
with open(path("misc", "orders_semicolon.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f, delimiter=";")
    w.writerow(["order_id", "customer", "note", "amount", "items"])
    names = ["Zhang, Wei", "Li \"Lucy\" Na", "Wang Fang", "Chen Jie", "Liu Yang"]
    for i in range(60):
        w.writerow([1000 + i, random.choice(names), random.choice(["", "加急", "含发票, 需盖章", "多行\n备注"]),
                    f"{random.uniform(20, 900):.2f}", random.randint(1, 9)])

print("samples written to", ROOT)
