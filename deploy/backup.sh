#!/usr/bin/env bash
# =============================================================================
# 二年级快乐学习台 · 异地备份
# -----------------------------------------------------------------------------
# 后端自己每天凌晨 3 点会往 ./data/backup 里写一份 JSON 快照（放在卷里）。
# 这个脚本负责「再往外挪一份」——卷还在同一块盘上，硬盘坏了就一起没了。
#
# 用法：
#   ./backup.sh                     # 备份到 ./offsite
#   ./backup.sh /mnt/nas/grade2     # 备份到 U 盘 / NAS / 另一块盘
#
# 加进 crontab（每天 4 点，比后端晚一小时，确保快照已经生成）：
#   0 4 * * * /path/to/deploy/backup.sh /mnt/nas/grade2 >> /var/log/grade2-backup.log 2>&1
# =============================================================================
set -euo pipefail

DEST="${1:-./offsite}"
APP_CONTAINER="grade2-app"
DB_CONTAINER="grade2-mysql"
KEEP_DAYS="${KEEP_DAYS:-60}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$(dirname "$0")"
mkdir -p "$DEST"

echo "[$(date '+%F %T')] 开始备份 → $DEST"

# ---------------------------------------------------------------- 1. 让后端生成一份新快照
if docker ps --format '{{.Names}}' | grep -qx "$APP_CONTAINER"; then
  echo "  · 请求后端生成快照…"
  curl -fsS -X POST "http://127.0.0.1:${APP_PORT:-8788}/api/backup/run" >/dev/null \
    && echo "  · 快照已生成" \
    || echo "  ! 快照接口调用失败（服务没起？端口不是 ${APP_PORT:-8788}？），继续备份已有的"
else
  echo "  ! 容器 $APP_CONTAINER 没在运行，只备份卷里已有的快照"
fi

# ---------------------------------------------------------------- 2. 卷里的 JSON 快照
if docker ps -a --format '{{.Names}}' | grep -qx "$APP_CONTAINER"; then
  if docker cp "$APP_CONTAINER:/app/server/data/backup/." "$DEST/backup-$STAMP" 2>/dev/null; then
    n=$(find "$DEST/backup-$STAMP" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
    echo "  · 已导出 $n 份 JSON 快照"
  else
    echo "  ! 容器内还没生成过快照（/app/server/data/backup 为空）"
  fi
fi

# ---------------------------------------------------------------- 3. MySQL 逻辑备份
if docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "  · 导出 MySQL…"
  # 密码从容器环境里读，避免在这里再维护一份
  docker exec "$DB_CONTAINER" sh -c \
    'exec mysqldump --single-transaction --quick --routines --triggers \
       -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' \
    | gzip > "$DEST/mysql-$STAMP.sql.gz"
  echo "  · MySQL 已导出（$(du -h "$DEST/mysql-$STAMP.sql.gz" | cut -f1)）"
fi

# ---------------------------------------------------------------- 4. 清掉过期备份
echo "  · 清理 $KEEP_DAYS 天前的备份…"
find "$DEST" -maxdepth 1 -name 'backup-*' -type d -mtime "+$KEEP_DAYS" -exec rm -rf {} + 2>/dev/null || true
find "$DEST" -maxdepth 1 -name 'mysql-*.sql.gz' -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true

echo "[$(date '+%F %T')] 备份完成"
