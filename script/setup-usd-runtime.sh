#!/usr/bin/env bash
set -euo pipefail
# 源码入口委托发行同一个安装实现；不改系统Python或其它Provider环境。
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$root/distribution/linux/install-usd-parser" "$@"
