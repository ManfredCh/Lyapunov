#!/usr/bin/env bash
# 跑本目录**全部**已收编的负对照驱动；每个驱动以退出码表态（非零 ⇒ 整体非零）。
#
# 纪律：本脚本**不吞退出码**（不许 `|| true`）、**不 skip**（跑不动就是失败，不是"跳过"）。
# 逐个串行跑：变异窗口内产品文件是被改过的，并行跑会互相把别人的还原当成"漂移"。
#
# 跑法：`bash script/negative-controls/run-all.sh`
#       `NC_SLOW=1 bash script/negative-controls/run-all.sh`  额外跑慢变异（见各驱动说明）
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
export PATH="$HOME/.bun/bin:$PATH"
export NC_SLOW="${NC_SLOW:-0}"

FAIL=0
for d in nc-share-bounded-fetch.ts nc-share-preview-status.ts; do
  echo "################ $d ################"
  bun "script/negative-controls/$d" || FAIL=1
  echo
done
for d in nc-policy-source-attempts.sh; do
  echo "################ $d ################"
  bash "script/negative-controls/$d" || FAIL=1
  echo
done

# 跑完后复核：工作树里被变异过的目标文件必须一个都没变（对照 git 的只读判据，不执行任何 git 写命令）
echo "################ 收尾复核：被变异过的目标文件是否逐字节还原 ################"
sha256sum packages/lyapunov-share/src/fetch.ts packages/lyapunov-share/src/operations.ts \
          packages/lyapunov-share/src/preview-route.ts packages/policy-registry/src/source.ts
git diff --stat -- packages/lyapunov-share/src packages/policy-registry/src/source.ts
[ "$FAIL" = 0 ] && echo "RESULT run-all 全部负对照通过 ✓" || echo "RESULT run-all 有负对照不通过 ✗"
exit "$FAIL"
