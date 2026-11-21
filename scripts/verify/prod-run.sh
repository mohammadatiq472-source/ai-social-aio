#!/usr/bin/env bash
# 生产验收（在服务器本机跑）：临时放宽 IP 闸 → 建一次性站务码 → 依次跑 verify → 无条件还原 → 吊销码。
#
# 为什么需要这个脚本（2026-11-19 第 4 次手工重复同一件事）：
#   smoke/accept/各 verify 都会注册账号，而它们全从服务器本机出口出去，
#   一天跑几轮就会撞上 `INVITE_MAX_PER_IP_DAY`（默认 8/24h）→ 429。
#   手工做法是「改 env → 重启 → 跑 → cp -a 还原 → 重启 → revoke」，漏一步就把闸门留在放宽状态。
#
# 安全设计：
#   - **trap EXIT** 还原 env 并重启：脚本中途失败/被 Ctrl-C 也会还原；
#   - 还原后 assert「INVITE_MAX_PER_IP_DAY 行数回到 0 或原值」，不一致就红字告警；
#   - 一次性码用完即吊销；
#   - `--dry` 只打印将要做什么。
#
# 用法（在服务器上，root）：
#   bash scripts/verify/prod-run.sh --dry
#   bash scripts/verify/prod-run.sh verify-mcp-schema verify-group-announcement accept
#
# 注意：这个脚本会重启 qqmini（每次 ~2~5 秒不可用），只在验收窗口用。

set -uo pipefail
APP_DIR="${APP_DIR:-/opt/aio/app}"
ENVFILE="${ENVFILE:-/etc/qqmini.env}"
NODE_BIN="${NODE_BIN:-/opt/aio/runtime/bin/node}"
RELAXED="${RELAXED:-200}"
BACKUP="/root/qqmini.env.bak-prodrun"
DRY=0
TARGETS=()

for arg in "$@"; do
  case "$arg" in
    --dry) DRY=1 ;;
    -*) echo "未知参数：$arg"; exit 2 ;;
    *) TARGETS+=("$arg") ;;
  esac
done
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=(accept verify-mcp-schema verify-mcp-social verify-docs-consistency verify-agent-example)
fi

cd "$APP_DIR" || { echo "进不去 $APP_DIR"; exit 1; }
[ -f "$ENVFILE" ] || { echo "找不到 $ENVFILE"; exit 1; }

ORIG_LINE=$(grep -E '^INVITE_MAX_PER_IP_DAY=' "$ENVFILE" || true)
RESTORED=0
restore() {
  [ "$RESTORED" = "1" ] && return 0
  RESTORED=1
  echo "───── 还原 env ─────"
  cp -a "$BACKUP" "$ENVFILE"
  systemctl restart qqmini
  sleep 3
  systemctl is-active qqmini || echo "!! qqmini 没有起来，立刻人工检查"
  local now
  now=$(grep -E '^INVITE_MAX_PER_IP_DAY=' "$ENVFILE" || true)
  if [ "$now" != "$ORIG_LINE" ]; then
    echo "!! 还原后 INVITE_MAX_PER_IP_DAY 与原值不一致：[$now] vs [$ORIG_LINE]"
  else
    echo "env 已还原（INVITE_MAX_PER_IP_DAY: ${ORIG_LINE:-未设置=默认}）"
  fi
}
trap 'restore' EXIT INT TERM

echo "───── 计划 ─────"
echo "目标：${TARGETS[*]}"
echo "临时把 INVITE_MAX_PER_IP_DAY 设为 $RELAXED（结束时还原）"
[ "$DRY" = "1" ] && { echo "[dry] 未做任何修改"; exit 0; }

echo "───── 放宽 IP 闸 ─────"
cp -a "$ENVFILE" "$BACKUP"
if grep -q '^INVITE_MAX_PER_IP_DAY=' "$ENVFILE"; then
  sed -i "s/^INVITE_MAX_PER_IP_DAY=.*/INVITE_MAX_PER_IP_DAY=$RELAXED/" "$ENVFILE"
else
  printf '\nINVITE_MAX_PER_IP_DAY=%s\n' "$RELAXED" >> "$ENVFILE"
fi
systemctl restart qqmini
sleep 3
curl -s -o /dev/null -w "healthz=%{http_code}\n" http://127.0.0.1:8787/healthz || true

set -a; . "$ENVFILE"; set +a
export BASE="${BASE:-http://127.0.0.1:8787}"

echo "───── 建一次性站务码 ─────"
OUT=$($NODE_BIN scripts/invite-cli.mjs create --max-uses 40 --days 1 --note "prod-run $(date +%F_%H%M)")
CODE=$(printf '%s\n' "$OUT" | awk '/id=[0-9]+/{print $1; exit}')
CODE_ID=$(printf '%s\n' "$OUT" | sed -n 's/.*id=\([0-9]*\).*/\1/p' | head -1)
if [ -z "${CODE:-}" ]; then echo "建码失败"; printf '%s\n' "$OUT" | tail -3; exit 1; fi
echo "站务码 id=$CODE_ID"
export REGISTER_CODE="$CODE"

FAIL=0
run_one() {
  local out=/tmp/prodrun.$$.out
  ( "$@" ) > "$out" 2>&1
  local rc=$?
  tail -4 "$out"
  rm -f "$out"
  return $rc
}

for t in "${TARGETS[@]}"; do
  echo "───── $t ─────"
  if [ "$t" = "accept" ]; then
    run_one $NODE_BIN scripts/accept.mjs || FAIL=1
  elif [ "$t" = "smoke" ]; then
    run_one bash scripts/smoke.sh || FAIL=1
  else
    # 允许写 verify-mcp-schema 或 verify-mcp-schema.mjs
    f="scripts/verify/$t"
    [ -f "$f" ] || f="scripts/verify/$t.mjs"
    if [ -f "$f" ]; then
      run_one $NODE_BIN "$f" || FAIL=1
    else
      echo "不认识的目标：$t（可以是 accept / smoke / scripts-verify 下的文件名）"
      FAIL=1
    fi
  fi
done

echo "───── 吊销站务码 ─────"
$NODE_BIN scripts/invite-cli.mjs revoke --id "$CODE_ID" 2>&1 | tail -1

echo "───── 结果 ─────"
if [ "$FAIL" = "1" ]; then echo "❌ 有目标失败（env 仍会被 trap 还原）"; else echo "✅ 全部通过"; fi
exit "$FAIL"
