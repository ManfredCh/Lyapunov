"""只读源数据库，使用 SQLite backup 得到包含已提交 WAL 的一致性副本。"""
import json
import os
import pathlib
import sqlite3
import sys
import urllib.parse

source, destination, output = sys.argv[1:4]
source = pathlib.Path(source).resolve(strict=True)
destination = pathlib.Path(destination).resolve()
if source == destination:
    raise RuntimeError("SOURCE_AND_DESTINATION_MUST_DIFFER")
destination.parent.mkdir(parents=True, exist_ok=True)
connection = sqlite3.connect("file:" + urllib.parse.quote(str(source)) + "?mode=ro", uri=True)
connection.execute("PRAGMA query_only = ON")
target = sqlite3.connect(str(destination))
try:
    connection.backup(target)
    result = target.execute("PRAGMA quick_check").fetchone()[0]
    if result != "ok":
        raise RuntimeError("SQLITE_SNAPSHOT_CORRUPT")
    target.row_factory = sqlite3.Row
    existing = {row[0] for row in target.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    tables = ["project", "workspace", "session", "message", "part", "session_message", "session_diff", "session_share", "todo", "permission"]
    data = {name: [dict(row) for row in target.execute('SELECT * FROM "' + name + '"')] for name in tables if name in existing}
    for name in ["session", "message", "part"]:
        if name not in data:
            raise RuntimeError("LEGACY_TABLE_MISSING: " + name)
    # 旧库里存在、但本迁移器不导入的表必须逐条留名（含行数），不能静默略过：
    # "哪些旧数据没进新装"要是可审计的读数，而不是"没报错就等于迁完了"。
    unmigrated = {name: target.execute('SELECT COUNT(*) FROM "' + name + '"').fetchone()[0] for name in sorted(existing - set(tables))}
    with open(output, "w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False)
    os.chmod(output, 0o600)
    os.chmod(destination, 0o600)
    print(json.dumps({"status": "PASS", "tables": {name: len(rows) for name, rows in data.items()}, "unmigrated": unmigrated, "snapshot": str(destination)}))
finally:
    target.close()
    connection.close()
