#!/usr/bin/env bash
# 负对照 · 策略取件的**有界重试**与**建连超时不压在读正文上**
#
# 收编自 `.runtime/lane-w25/scripts/negative-control.sh`，按统一口径（`nc-lib.ts` 头部八条）重写：
#   · 原脚本用 `assert old in s`（只断"存在"）且用 `|| true` 吞掉测试退出码 —— 两处都不合口径，已换掉
#   · 原脚本第二处锚点 `const composite = signal ? AbortSignal.any([...]) : …` **今天命中 0 次**
#     （该文件后来长出 connect / stall 两个 30s 的分工）⇒ 本文件按**今天的交付版**重新取锚点
#   · 不再依赖 `.runtime/**`：备份放 `mktemp -d`（平台临时区），还原比对 sha256
#
# 目标：`packages/policy-registry/src/source.ts`（**产品代码**；用例一个字不动）
# 跑法：`bash script/negative-controls/nc-policy-source-attempts.sh`
#       `NC_SLOW=1 bash …`  额外跑变异 B（观测窗口是 `policy-source-stall-cap.test.ts`，单跑约 90–100s）
set -uo pipefail
cd /home/s18/WS/Lyapunov/Dev || exit 1
export PATH="$HOME/.bun/bin:$PATH"

TARGET=packages/policy-registry/src/source.ts
TEST_A=packages/policy-registry/test/policy-source-bounded-fetch.test.ts
TEST_B=packages/policy-registry/test/policy-source-stall-cap.test.ts
BAK=$(mktemp -d)
cp "$TARGET" "$BAK/source.ts"
BEFORE=$(sha256sum "$TARGET" | cut -d' ' -f1)
echo "# nc-policy-source-attempts"
echo "# 目标 sha256 $TARGET $BEFORE bytes=$(wc -c < "$TARGET")"

restore() {
  cp "$BAK/source.ts" "$TARGET"
  local after; after=$(sha256sum "$TARGET" | cut -d' ' -f1)
  if [ "$after" = "$BEFORE" ]; then echo "  逐字节还原：一致 ✓ ($TARGET)"; else echo "  逐字节还原：不一致 ✗✗✗ ($after)"; return 1; fi
}
trap 'restore >/dev/null 2>&1; rm -rf "$BAK"' EXIT INT TERM

run_test() { bun --no-env-file test "$1" 2>&1; }
reading() {
  printf 'pass=%s fail=%s expect=%s' \
    "$(printf '%s' "$1" | grep -oE '^ *[0-9]+ pass' | tail -1 | grep -oE '[0-9]+')" \
    "$(printf '%s' "$1" | grep -oE '^ *[0-9]+ fail' | tail -1 | grep -oE '[0-9]+')" \
    "$(printf '%s' "$1" | grep -oE '^ *[0-9]+ expect\(\) calls' | tail -1 | grep -oE '[0-9]+')"
}
# bun 把失败打印两遍（逐条带 [Nms] + 收尾不带）⇒ 必须**去掉计时后缀再 sort -u**，否则条数会翻倍。
fails_of() { printf '%s' "$1" | grep -oE '^\(fail\) .*' | sed -E 's/^\(fail\) //; s/ \[[0-9.]+ms\]$//' | sort -u; }

BASE_OUT=$(run_test "$TEST_A"); BASE_RC=$?
echo "BASELINE test=$TEST_A $(reading "$BASE_OUT") exit=$BASE_RC"
[ "$BASE_RC" = 0 ] || { echo "ABORT: 交付版自己就不是全绿 ⇒ 下面的变红不可信"; exit 3; }

OK=1
# mutate_and_check <变异名> <用例> <期望条数> <锚点> <还原成> <期望片段...>
mutate_and_check() {
  local name="$1" test="$2" want="$3" from="$4" to="$5" ; shift 5
  local hits
  hits=$(python3 - "$TARGET" "$from" <<'PY'
import sys
print(open(sys.argv[1], encoding='utf-8').read().count(sys.argv[2]))
PY
)
  if [ "$hits" != 1 ]; then
    echo "MUTATION $name file=$TARGET 命中次数=$hits（要求恰好 1）⇒ 拒绝执行 REFUSE"
    OK=0; return
  fi
  python3 - "$TARGET" "$from" "$to" <<'PY'
import sys
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
assert s.count(old) == 1, f"anchor count {s.count(old)} != 1"
open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
PY
  local out rc failed n expect_hits=0
  out=$(run_test "$test"); rc=$?
  failed=$(fails_of "$out"); n=$(printf '%s' "$failed" | grep -c . || true)
  for frag in "$@"; do printf '%s' "$failed" | grep -qF -- "$frag" && expect_hits=$((expect_hits+1)); done
  local verdict="MISMATCH ✗"
  [ "$n" = "$want" ] && [ "$expect_hits" = "$#" ] && [ "$rc" != 0 ] && verdict="MATCH ✓"
  [ "$verdict" = "MATCH ✓" ] || OK=0
  echo "MUTATION $name file=$TARGET test=$test 目标sha256=$BEFORE 命中次数=1 $(reading "$out") exit=$rc 变红用例($n)[$(printf '%s' "$failed" | paste -sd' | ' -)] 期望组命中=$expect_hits/$# 期望条数=$want $verdict"
  restore || OK=0
}

mutate_and_check 'A 还原"没有重试"：尝试上限 3 → 1' "$TEST_A" 3 \
  'export const POLICY_FETCH_ATTEMPTS = 3' 'export const POLICY_FETCH_ATTEMPTS = 1' \
  '逐件下载：两次 socket 断开后第三次成功' '负对照：上游不响应' '瞬时故障自动重试：前两次 socket 断开'

if [ "${NC_SLOW:-0}" = 1 ]; then
  mutate_and_check 'B 还原"超时一直挂在正文上"：connect 作用域摘掉（慢：观测窗口 ≈92s）' "$TEST_B" 4 \
    "const deadline = options.timeoutScope === 'connect' ? newConnectDeadline(timeoutMs) : undefined" \
    'const deadline = undefined' \
    'timeoutScope` 计数 ≥ 10 且五个锚点都在' '建连上限 300ms，而 3s 的 trickle' '4s 的 trickle 超过建连上限' '真实默认常量'
else
  echo "# SKIP 变异 B（观测窗口 $TEST_B 单跑 ≈92s）—— 要跑请设 NC_SLOW=1；它不是 no-op，本单已实测 4 条精确变红（见回执）"
fi

AFTER_OUT=$(run_test "$TEST_A"); AFTER_RC=$?
echo "AFTER test=$TEST_A $(reading "$AFTER_OUT") exit=$AFTER_RC"
[ "$AFTER_RC" = 0 ] || OK=0
restore || OK=0
if [ "$OK" = 1 ]; then echo "RESULT nc-policy-source-attempts 全部变异按期望精确变红，且逐字节还原 ✓"; exit 0; fi
echo "RESULT nc-policy-source-attempts 有变异不符合期望 ✗"; exit 1
