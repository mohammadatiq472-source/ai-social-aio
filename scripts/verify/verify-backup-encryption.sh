#!/usr/bin/env bash
# A2 静态加密回归（服务器上跑；需要 /etc/qqmini-backup.key 与备份目录）
# 判据：① 没有明文 .sql.gz 残留 ② 最新备份是 .enc ③ 密钥 600 ④ 能解密并通过 gzip 校验
#      ⑤ /healthz 报 encrypted:true
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/aio/data/backups}"
KEY="${BACKUP_KEY_FILE:-/etc/qqmini-backup.key}"
BASE="${BASE:-http://127.0.0.1:8787}"
FAIL=0
ok() { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; FAIL=1; }

# 1) 明文残留
PLAIN="$(find "$BACKUP_DIR" -maxdepth 1 -name 'qqmini-*.sql.gz' -not -name '*.enc' 2>/dev/null | wc -l)"
[ "$PLAIN" -eq 0 ] && ok "没有明文 .sql.gz 残留" || bad "仍有 ${PLAIN} 份明文备份"

# 2) 最新是 .enc
LATEST="$(ls -1t "$BACKUP_DIR"/qqmini-* 2>/dev/null | grep -v sha256 | head -1 || true)"
case "$LATEST" in
  *.sql.gz.enc) ok "最新备份已加密：$(basename "$LATEST")" ;;
  "") bad "备份目录为空" ;;
  *) bad "最新备份不是加密的：$(basename "$LATEST")" ;;
esac

# 3) 密钥权限
if [ -r "$KEY" ]; then
  PERM="$(stat -c %a "$KEY")"
  [ "$PERM" = "600" ] && ok "密钥权限 600" || bad "密钥权限是 ${PERM}（应为 600）"
else
  bad "读不到密钥 ${KEY}"
fi

# 4) 解密回环
if [[ "${LATEST}" == *.enc ]] && [ -r "$KEY" ]; then
  if openssl enc -d -aes-256-cbc -pbkdf2 -pass file:"$KEY" -in "$LATEST" 2>/dev/null | gzip -t 2>/dev/null; then
    ok "最新加密备份可解密且 gzip 完整"
  else
    bad "最新加密备份解密/校验失败（密钥不匹配或文件损坏）"
  fi
fi

# 5) healthz
HZ="$(curl -s --max-time 5 "$BASE/healthz" || true)"
if echo "$HZ" | grep -q '"encrypted":true'; then ok "/healthz 报告 encrypted:true"; else bad "/healthz 未报告加密：${HZ}"; fi

echo
[ "$FAIL" = "0" ] && echo "全部通过：备份静态加密已生效" || echo "有失败项"
exit "$FAIL"
