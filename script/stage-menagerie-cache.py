#!/usr/bin/env python3
"""把中立缓存 .analysis/menagerie-jsdelivr/ 的 7 个模型合并进 Dev/packs/<packId>/asset/，
并生成/刷新 Dev/packs/ASSET_STAGING_MANIFEST.json（与本仓复制部分合账）。
用法：python3 script/stage-menagerie-cache.py [--dry-run]
纪律：许可只从 LICENSE 正文判读（Apache-2.0 / MIT / BSD 3-Clause 等），判读不出记 UNVERIFIED，绝不猜测；
逐文件 sha256 重算入账；本脚本只写 packs/<id>/asset/** 与 ASSET_STAGING_MANIFEST.json。"""
import hashlib, json, os, shutil, sys

DEV = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKS = os.path.join(DEV, "packs")
CACHE = os.path.join(os.path.dirname(DEV), ".analysis", "menagerie-jsdelivr")
DRY = "--dry-run" in sys.argv

# 缓存目录名 → packId（缓存名已用 packId，直通；上游名仅入台账）
MODELS = ["unitree_go2", "unitree_g1", "crazyflie_2", "allegro_hand", "leap_hand", "shadow_hand", "robotiq_2f85"]
UPSTREAM = {"unitree_go2": "unitree_go2", "unitree_g1": "unitree_g1", "crazyflie_2": "bitcraze_crazyflie_2",
            "allegro_hand": "wonik_allegro", "leap_hand": "leap_hand", "shadow_hand": "shadow_hand",
            "robotiq_2f85": "robotiq_2f85"}

def judge_license(root):
    for name in ("LICENSE", "LICENSE.txt", "LICENSE.md", "COPYING"):
        p = os.path.join(root, name)
        if not os.path.isfile(p):
            continue
        text = open(p, encoding="utf-8", errors="replace").read(4000)
        if "Apache License" in text and "2.0" in text:
            return "Apache-2.0"
        if "MIT License" in text or "Permission is hereby granted, free of charge" in text:
            return "MIT"
        if "BSD 3-Clause" in text or ("Redistribution and use" in text and "3" in text[:200]):
            return "BSD-3-Clause"
        return f"UNVERIFIED(见 {name})"
    return "UNVERIFIED(无 LICENSE 文件)"

def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()

cache_index = os.path.join(CACHE, "fetch-manifest.json")
if not os.path.isfile(cache_index):
    print("BLOCKED: 缓存清单不存在，先跑 .analysis/fetch_menagerie_jsdelivr.py")
    sys.exit(1)
cache_mf = json.load(open(cache_index))
commit = cache_mf.get("commit", "UNVERIFIED")

manifest_path = os.path.join(PACKS, "ASSET_STAGING_MANIFEST.json")
manifest = json.load(open(manifest_path)) if os.path.isfile(manifest_path) else {}

def index_existing(pack_id, origin):
    """重算磁盘 asset/ 全部文件入账（以磁盘为准，覆盖旧条目）。"""
    root = os.path.join(PACKS, pack_id, "asset")
    recs = []
    for dirpath, _dirs, files in os.walk(root):
        for f in sorted(files):
            p = os.path.join(dirpath, f)
            rel = os.path.relpath(p, root)
            recs.append({"path": rel, "bytes": os.path.getsize(p), "sha256": sha(p)})
    manifest[pack_id] = {"origin": origin, "files": recs,
                         "license": judge_license(root),
                         "total_bytes": sum(r["bytes"] for r in recs)}
    return len(recs)

staged = []
for mid in MODELS:
    src_root = os.path.join(CACHE, mid)
    if not os.path.isdir(src_root):
        print(f"  [跳过] {mid}: 缓存缺失")
        continue
    dst_root = os.path.join(PACKS, mid, "asset")
    n = 0
    for dirpath, _dirs, files in os.walk(src_root):
        for f in files:
            if f == "fetch-manifest.json":
                continue
            src = os.path.join(dirpath, f)
            rel = os.path.relpath(src, src_root)
            dst = os.path.join(dst_root, rel)
            if DRY:
                n += 1
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            n += 1
    origin = f"mujoco_menagerie@{commit} (via jsdelivr cache) / {UPSTREAM[mid]}"
    count = n if DRY else index_existing(mid, origin)
    staged.append((mid, count))
    print(f"  [合入] {mid}: {count} 文件 ← {UPSTREAM[mid]}")

if not DRY:
    json.dump(manifest, open(manifest_path, "w"), indent=1, ensure_ascii=False)
    print(f"台账已写 {manifest_path}（共 {len(manifest)} 包）")
print("STAGED:", staged if staged else "无（缓存空）")
