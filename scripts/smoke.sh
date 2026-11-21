#!/usr/bin/env bash
# ============================================================================
# QQ-mini 端到端冒烟测试（纯 curl + bash，不依赖 jq / node）
# ----------------------------------------------------------------------------
# 覆盖 CONTRACT.md §9 全流程：
#   注册 A、注册 B → A 建群并拉 B →（A 建 Agent 拿 token → 把 Agent 拉进群）
#   → MCP initialize / notifications/initialized / tools/list
#   → B 发一条消息 → Agent whats_new 应看到它
#   → Agent send_message 带 reply_to_seq 回话
#   → REST 拉消息，断言最后一条 senderType=agent
#
# 用法：
#   bash scripts/smoke.sh                                # 默认 http://127.0.0.1:8787（本地开发）
#   BASE=https://127.0.0.1:8443 bash scripts/smoke.sh     # 生产（自签证书自动加 -k）
#   BASE=http://127.0.0.1:8787 KEEP=1 bash scripts/smoke.sh  # 失败时保留临时文件
#   DEBUG=1 ...                                          # 失败时打印响应体（token 会打码）
#
# 退出码：0 = 全部 PASS；非 0 = 任一步 FAIL（脚本立即停）。
#
# 注意：
#   * 服务端 SECURE_COOKIE=true（生产默认）时，Cookie 带 Secure，curl 不会在
#     http:// 上回传 → 必须用 https 的 BASE 跑（自签证书由脚本自动 -k）。
#   * Agent 必须先成为群成员才能收发；CONTRACT §9 省略了这一步，本脚本补上。
#   * 默认 reply_mode=mention 时，当前实现的 send_message 门控要求消息 mentions
#     包含 Agent 自己；脚本按此传 mentions=[agent_id]（见 §7 注释）。
# ============================================================================
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
BASE="${BASE%/}"
MCP_URL="$BASE/mcp"
DEBUG="${DEBUG:-0}"
KEEP="${KEEP:-0}"

CURL=(curl -sS --max-time 20)
if [[ "$BASE" == https://* ]]; then
  CURL+=(-k)   # 自签证书：内测期接受
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qqmini-smoke.XXXXXX")"
TMPBODY="$TMP_DIR/request-body.json"
JAR_A="$TMP_DIR/a.jar"
JAR_B="$TMP_DIR/b.jar"
PASS_COUNT=0

cleanup() {
  if [[ "$KEEP" == "1" ]]; then
    printf '\n临时文件保留：%s\n' "$TMP_DIR"
  else
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

section() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()      { PASS_COUNT=$((PASS_COUNT + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
warn()    { printf '  \033[33mWARN\033[0m %s\n' "$*" >&2; }
mask()    { sed -E 's/("token"[[:space:]]*:[[:space:]]*)"[^"]*"/\1"***"/g'; }

bad() {
  printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2
  if [[ -n "${LAST_DESC:-}" ]]; then
    printf '       请求：%s\n' "$LAST_DESC" >&2
    printf '       响应：HTTP %s\n' "${LAST_CODE:-?}" >&2
    if [[ "$DEBUG" == "1" && -n "${LAST_BODY:-}" ]]; then
      printf '       body：%s\n' "$(printf '%s' "$LAST_BODY" | mask | head -c 600)" >&2
    fi
  fi
  exit 1
}

expect_2xx() {
  if [[ ! "${LAST_CODE}" =~ ^2[0-9][0-9]$ ]]; then
    if [[ "${LAST_CODE}" == "401" ]]; then
      bad "$1（HTTP 401：会话没带上。若服务端 SECURE_COOKIE=true，请用 BASE=https://127.0.0.1:8443 重跑）"
    fi
    bad "$1（HTTP ${LAST_CODE}）：$LAST_BODY"
  fi
  ok "$1"
}

json_num() { # $1=字段名，$2=JSON；取第一个数字值
  printf '%s' "$2" | grep -o "\"$1\":[0-9][0-9]*" | head -n1 | cut -d: -f2
}

json_str() { # $1=字段名，$2=JSON；取第一个字符串值
  printf '%s' "$2" | grep -o "\"$1\":\"[^\"]*\"" | head -n1 | cut -d'"' -f4
}

gen_uuid() {
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    cat /proc/sys/kernel/random/uuid
  elif command -v uuidgen >/dev/null 2>&1; then
    uuidgen
  else
    # 退化方案：仅保证 client_msg_id 的字符集与长度符合 ^[0-9a-zA-Z_-]{8,64}$
    printf '%s-%s-%s-%s-%s' "$(date +%s)" "$RANDOM" "$RANDOM" "$RANDOM" "$RANDOM"
  fi
}

# 普通 REST 调用：方法 路径 cookie-jar 请求体(可为空)
http() {
  local method="$1" path="$2" jar="$3" data="${4:-}"
  local args=(-X "$method" -H 'Content-Type: application/json' -w $'
%{http_code}')
  [[ -n "$jar" ]] && args+=(-b "$jar" -c "$jar")
  # Windows/git-bash 下把中文当 argv 传给 curl 会被 ANSI 代码页打坏（服务端只会收到乱码，
  # 而 curl 仍返回 200）。统一写 UTF-8 文件再用 @file。
  if [[ -n "$data" ]]; then
    printf '%s' "$data" > "$TMPBODY"
    args+=(--data-binary "@$TMPBODY")
  fi
  LAST_DESC="$method $path"
  local raw
  raw="$("${CURL[@]}" "${args[@]}" "$BASE$path")" || bad "curl 请求失败：$method $path"
  LAST_CODE="${raw##*$'
'}"
  LAST_BODY="${raw%$'
'*}"
}

# MCP 调用：$1=JSON-RPC 请求体
mcp() {
  LAST_DESC="POST /mcp"
  local raw
  raw="$("${CURL[@]}" -X POST "$MCP_URL" \
          -H 'Content-Type: application/json' \
          -H "Authorization: Bearer ${TOKEN}" \
          --data-binary "$1" -w $'\n%{http_code}')" || bad "curl 请求失败：POST /mcp"
  LAST_CODE="${raw##*$'\n'}"
  LAST_BODY="${raw%$'\n'*}"
}

# MCP 结果里 content[0].text 是被转义的 JSON 字符串，去掉转义后再断言
mcp_text() { printf '%s' "$1" | sed 's/\\"/"/g'; }

# ============================================================================
section "0. 目标：$BASE（MCP：$MCP_URL）"
PROBE=(curl -sS --max-time 5)
if [[ "$BASE" == https://* ]]; then PROBE+=(-k); fi
HTTP_CODE="$("${PROBE[@]}" -o /dev/null -w '%{http_code}' "$BASE/healthz" 2>/dev/null || true)"
[[ "$HTTP_CODE" =~ ^[0-9]{3}$ && "$HTTP_CODE" != "000" ]] || bad "服务不可达：$BASE/healthz（先启动服务或检查 BASE）"
ok "服务可达（/healthz → HTTP $HTTP_CODE）"

STAMP="$(date +%s)$$"
PASSWORD="SmokeTest-2026!"
EMAIL_A="smoke-a-${STAMP}@example.com"
EMAIL_B="smoke-b-${STAMP}@example.com"
MARKER_B="smoke-b-msg-${STAMP}"
AGENT_BODY="smoke-agent-reply-${STAMP}"

# ============================================================================
section "1. 注册用户 A 与 B"
http POST "/api/auth/register" "$JAR_A" \
  "{\"email\":\"${EMAIL_A}\",\"password\":\"${PASSWORD}\",\"display_name\":\"冒烟A\",\"invite_code\":\"${REGISTER_CODE:-}\"}"
expect_2xx "注册 A"
A_ID="$(json_num id "$LAST_BODY")"
[[ -n "$A_ID" ]] || bad "注册 A 的响应里没有 id"
grep -q 'sid' "$JAR_A" || bad "注册 A 后 cookie jar 里没有 sid"
ok "A 已登录（id=$A_ID，sid Cookie 已保存）"
A_ACC="$(json_num accountNo "$LAST_BODY")"
[[ -n "$A_ACC" ]] || bad "注册 A 的响应里没有 accountNo"

http POST "/api/auth/register" "$JAR_B" \
  "{\"email\":\"${EMAIL_B}\",\"password\":\"${PASSWORD}\",\"display_name\":\"冒烟B\",\"invite_code\":\"${REGISTER_CODE:-}\"}"
expect_2xx "注册 B"
B_ID="$(json_num id "$LAST_BODY")"
[[ -n "$B_ID" ]] || bad "注册 B 的响应里没有 id"
grep -q 'sid' "$JAR_B" || bad "注册 B 后 cookie jar 里没有 sid"
ok "B 已登录（id=$B_ID）"
B_ACC="$(json_num accountNo "$LAST_BODY")"
[[ -n "$B_ACC" ]] || bad "注册 B 的响应里没有 accountNo"

# ============================================================================
section "2. A 先加 B 为好友（建群只能拉好友），再建群"
http POST "/api/friends/request" "$JAR_A" "{\"account_no\":${B_ACC}}"
expect_2xx "A 向 B 发好友申请"
http POST "/api/friends/accept" "$JAR_B" "{\"principal_id\":${A_ID}}"
expect_2xx "B 同意好友"
ok "A/B 已成为好友"

http POST "/api/conversations" "$JAR_A" \
  "{\"title\":\"冒烟群-${STAMP}\",\"member_ids\":[${B_ID}]}"
expect_2xx "建群"
CONV_ID="$(json_num id "$LAST_BODY")"
[[ -n "$CONV_ID" ]] || bad "建群响应里没有 conversation.id"
ok "群已创建（conversation_id=$CONV_ID）"

http GET "/api/conversations" "$JAR_A" ""
expect_2xx "A 拉会话列表"
grep -q "\"id\":${CONV_ID}" <<<"$LAST_BODY" || bad "会话列表里没有新群 $CONV_ID"
grep -q "\"id\":${B_ID}" <<<"$LAST_BODY" || bad "群成员里没有 B（$B_ID）"
ok "A 的会话列表已包含该群，且 B 在成员里"

# ============================================================================
section "3. A 创建 Agent 并把它拉进群（AI 必须是群成员才能收发）"
AGENT_NAME="冒烟助手"
http POST "/api/agents" "$JAR_A" \
  "{\"display_name\":\"冒烟助手\",\"persona\":\"端到端冒烟测试用，回答简短。\"}"
expect_2xx "创建 Agent"
AGENT_ID="$(json_num id "$LAST_BODY")"
TOKEN="$(json_str token "$LAST_BODY")"
[[ -n "$AGENT_ID" ]] || bad "创建 Agent 的响应里没有 agent.id"
[[ "$TOKEN" == qqa_* ]] || bad "创建 Agent 的响应里没有 qqa_ 开头的 token（只返回一次）"
ok "Agent 已创建（id=$AGENT_ID，token=${TOKEN:0:8}…）"

http POST "/api/conversations/${CONV_ID}/members" "$JAR_A" \
  "{\"principal_id\":${AGENT_ID}}"
expect_2xx "把 Agent 拉进群"
ok "Agent 已是群成员"

# ============================================================================
section "4. MCP initialize / notifications/initialized / tools/list"
mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"qqmini-smoke","version":"0.1.0"}}}'
[[ "$LAST_CODE" == "200" ]] || bad "initialize 应返回 HTTP 200（实际 ${LAST_CODE}）"
INIT_TEXT="$(mcp_text "$LAST_BODY")"
grep -q '"protocolVersion":"2025-06-18"' <<<"$INIT_TEXT" || bad "initialize 没有回显协议版本"
grep -q '"serverInfo"' <<<"$INIT_TEXT" || bad "initialize 缺少 serverInfo"
ok "initialize 成功（protocolVersion=2025-06-18）"

notif_code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer ${TOKEN}" \
  --data-binary '{"jsonrpc":"2.0","method":"notifications/initialized"}')"
[[ "$notif_code" =~ ^20[0-9]$ ]] || bad "notifications/initialized 应返回 2xx（实际 $notif_code）"
ok "notifications/initialized 被接受（HTTP $notif_code）"

mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
[[ "$LAST_CODE" == "200" ]] || bad "tools/list 应返回 HTTP 200（实际 ${LAST_CODE}）"
LIST_TEXT="$(mcp_text "$LAST_BODY")"
for tool in whats_new send_message list_conversations; do
  grep -q "\"name\":\"${tool}\"" <<<"$LIST_TEXT" || bad "tools/list 缺少工具：$tool"
done
ok "tools/list 返回 whats_new / send_message / list_conversations"

# ============================================================================
section "5. B 在群里发一条消息"
CLIENT_ID_B="$(gen_uuid)"
http POST "/api/conversations/${CONV_ID}/messages" "$JAR_B" \
  "{\"body\":\"@${AGENT_NAME} ${MARKER_B}\",\"client_msg_id\":\"${CLIENT_ID_B}\",\"mentions\":[${AGENT_ID}]}"
expect_2xx "B 发消息"
grep -q '"accepted":true' <<<"$LAST_BODY" || bad "B 发消息未被接受：$LAST_BODY"
B_SEQ="$(json_num seq "$LAST_BODY")"
[[ -n "$B_SEQ" ]] || bad "B 发消息的响应里没有 seq"
ok "B 已发送（seq=$B_SEQ，body=${MARKER_B}）"

http GET "/api/conversations/${CONV_ID}/messages?since_seq=0&limit=50" "$JAR_A" ""
expect_2xx "A 拉消息"
grep -q "$MARKER_B" <<<"$LAST_BODY" || bad "A 看不到 B 刚发的消息"
ok "A 已通过 REST 看到 B 的消息"

# ============================================================================
section "6. Agent whats_new 应看到 B 的消息"
mcp "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"whats_new\",\"arguments\":{\"since_seq\":0,\"conversation_ids\":[${CONV_ID}],\"limit\":50,\"detail\":true}}}"
[[ "$LAST_CODE" == "200" ]] || bad "whats_new 应返回 HTTP 200（实际 ${LAST_CODE}）"
NEW_TEXT="$(mcp_text "$LAST_BODY")"
grep -q '"isError":false' <<<"$NEW_TEXT" || bad "whats_new 返回 isError=true：$(head -c 300 <<<"$NEW_TEXT")"
grep -q "$MARKER_B" <<<"$NEW_TEXT" || bad "whats_new 没返回 B 的消息（$MARKER_B）"
grep -q "\"seq\":${B_SEQ}" <<<"$NEW_TEXT" || bad "whats_new 返回的 seq 与 B 的 seq(${B_SEQ}) 不一致"
ok "Agent 的 whats_new 已看到 B 的消息（seq=$B_SEQ）"

# ============================================================================
section "7. Agent 用 MCP send_message 回复（带 reply_to_seq）"
# 门控判定看的是「被回复的那条消息有没有 @ 它」——B 上面那条已经 @ 了 Agent，
# 所以这里不需要、也不应该把自己写进 mentions（那是被禁掉的绕过方式）。
CLIENT_ID_AGENT="$(gen_uuid)"
mcp "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"send_message\",\"arguments\":{\"conversation_id\":${CONV_ID},\"body\":\"${AGENT_BODY}\",\"client_msg_id\":\"${CLIENT_ID_AGENT}\",\"reply_to_seq\":${B_SEQ}}}}"
[[ "$LAST_CODE" == "200" ]] || bad "send_message 应返回 HTTP 200（实际 ${LAST_CODE}）"
SEND_TEXT="$(mcp_text "$LAST_BODY")"
grep -q '"isError":false' <<<"$SEND_TEXT" || bad "Agent send_message 返回 isError=true：$(head -c 500 <<<"$SEND_TEXT")"
grep -q '"accepted":true' <<<"$SEND_TEXT" || bad "Agent send_message 未被接受：$(head -c 500 <<<"$SEND_TEXT")"
AGENT_SEQ="$(json_num seq "$SEND_TEXT")"
ok "Agent 已回复（seq=${AGENT_SEQ:-?}，reply_to_seq=$B_SEQ）"

# ============================================================================
section "8. REST 拉消息，断言最后一条 senderType=agent"
http GET "/api/conversations/${CONV_ID}/messages?since_seq=0&limit=50" "$JAR_A" ""
expect_2xx "A 拉最终消息"
LAST_SENDER="$(grep -o '"senderType":"[^"]*"' <<<"$LAST_BODY" | tail -n1)"
[[ "$LAST_SENDER" == '"senderType":"agent"' ]] || bad "最后一条消息不是 Agent 发的（实际：${LAST_SENDER:-无}）"
grep -q "$AGENT_BODY" <<<"$LAST_BODY" || bad "最终消息里没有 Agent 的正文"
grep -q "\"replyToSeq\":${B_SEQ}" <<<"$LAST_BODY" || bad "Agent 消息的 replyToSeq 不等于 B 的 seq(${B_SEQ})"
ok "最后一条消息 senderType=agent，正文与 replyToSeq 均正确"

# ============================================================================
printf '\n\033[1;32m全部通过：%d 项检查\033[0m\n' "$PASS_COUNT"
printf '（群 %s / Agent %s / B 消息 seq %s / Agent 消息 seq %s）\n' \
  "$CONV_ID" "$AGENT_ID" "$B_SEQ" "${AGENT_SEQ:-?}"
exit 0
