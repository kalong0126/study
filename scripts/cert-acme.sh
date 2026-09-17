#!/usr/bin/env bash
# =============================================================================
# 二年级快乐学习台 · 用公信 CA 的证书替换自签证书（DNS-01 验证）
# -----------------------------------------------------------------------------
# 解决的问题：
#   内网自签（mkcert）的证书有两个毛病 —— ① 不是公信 CA，任何没装过根证书的设备
#   都会报「连接不是私密连接」；② SAN 里通常只有内网 IP，用域名访问还会主机名不匹配。
#   换成 Let's Encrypt 之后，**任何设备都不用装根证书**，地址栏是干净的小锁。
#
# 为什么用 DNS-01 而不是 HTTP-01：
#   域名解析在阿里云 → 让 ACME 客户端自动加一条 TXT 记录就能证明域名归你，
#   既不要求 80/443 对公网放开，也不受「运营商封端口 / 路由器 IPv6 防火墙怎么配」影响。
#   家里是 IPv6 + 端口直连的形态，这条路最省事也最可靠。
#
# 用法（在 NAS / Linux 上，仓库根目录）：
#   export Ali_Key=LTAI5t...          # 阿里云 RAM 子账号的 AccessKey
#   export Ali_Secret=...
#   export ACME_EMAIL=you@example.com # 证书到期通知用（可选但建议填）
#   bash scripts/cert-acme.sh
#
#   DOMAIN=other.chinwer.top bash scripts/cert-acme.sh     # 签别的域名
#   RELOAD_CMD="docker restart grade2-app" bash scripts/cert-acme.sh
#
# 前置：阿里云 RAM 里建一个**子账号**，只授「AliyunDNSFullAccess」
#       （或更细的自定义策略，只给 alidns 的 Describe/Add/DeleteDomainRecord），
#       用它生成 AccessKey。**别用主账号的 AccessKey** —— 那把钥匙能开整个云账号。
#
# 续期：acme.sh 装完会自动注册定时任务（每天跑一次），到期前 30 天自动续，
#       续完执行下面的 reload（默认重启容器）。证书 90 天一轮，续期是自动的。
# =============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-fn.chinwer.top}"
ACME_SERVER="${ACME_SERVER:-letsencrypt}"
RELOAD_CMD="${RELOAD_CMD:-docker restart grade2-app}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CERT_DIR="$REPO_ROOT/server/certs"
ACME_HOME="${ACME_HOME:-$HOME/.acme.sh}"
ACME="$ACME_HOME/acme.sh"

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die()  { printf '\n失败：%s\n' "$*" >&2; exit 1; }

step "检查前置"
[ -n "${Ali_Key:-}" ]    || die "没设 Ali_Key。用法见本文件顶部注释（阿里云 RAM 子账号的 AccessKey）。"
[ -n "${Ali_Secret:-}" ] || die "没设 Ali_Secret。"
command -v curl >/dev/null 2>&1 || die "没有 curl，装一下（Debian/Ubuntu：apt-get install -y curl）。"
say "  域名        $DOMAIN"
say "  ACME 服务端 $ACME_SERVER"
say "  证书目录    $CERT_DIR"
say "  续期后执行  $RELOAD_CMD"

# ------------------------------------------------------------------ 1. acme.sh
step "准备 acme.sh"
if [ -x "$ACME" ]; then
  say "  已存在：$ACME"
else
  say "  没找到，正在安装到 $HOME/.acme.sh（不写系统目录、不需要 root 以外的权限）"
  curl -fsSL https://get.acme.sh | sh -s -- --home "$ACME_HOME" >/dev/null 2>&1 \
    || die "acme.sh 安装失败。或者你的机器连不上 get.acme.sh，可以手动 clone：
    git clone https://github.com/acmesh-official/acme.sh.git ~/.acme.sh && cd ~/.acme.sh && ./acme.sh --install"
  [ -x "$ACME" ] || die "装完了但找不到 $ACME"
  say "  已安装：$ACME"
fi

# ------------------------------------------------------------------- 2. 签证书
step "签发证书（DNS-01：会自动往阿里云 DNS 加 TXT 记录）"
"$ACME" --issue \
  --server "$ACME_SERVER" \
  --dns dns_ali \
  -d "$DOMAIN" \
  ${ACME_EMAIL:+--accountemail "$ACME_EMAIL"} \
  "${@:-}" \
  || die "签发失败。常见原因：
    · AccessKey 没有 DNS 权限，或建的不是 RAM 子账号；
    · 域名不在这个阿里云账号的云解析里（dns_ali 只操作阿里云 DNS）；
    · 该域名已经签过、且没到期 —— 想强制重签加 --force。"

# ----------------------------------------- 3. 装到 server/certs/ + 注册自动续期
step "安装证书到 $CERT_DIR（并注册续期后的 reload）"
mkdir -p "$CERT_DIR"
"$ACME" --install-cert -d "$DOMAIN" \
  --key-file       "$CERT_DIR/key.pem" \
  --fullchain-file "$CERT_DIR/cert.pem" \
  --reloadcmd      "$RELOAD_CMD" \
  || die "安装失败（检查 $CERT_DIR 是否可写）"

# 容器是 root 跑的，但宿主机上还是别让私钥人人可读
chmod 600 "$CERT_DIR/key.pem" 2>/dev/null || true
chmod 644 "$CERT_DIR/cert.pem" 2>/dev/null || true

step "完成"
say "  证书：$CERT_DIR/cert.pem"
say "  私钥：$CERT_DIR/key.pem"
say ""
say "  接下来："
say "    1) 确认 .env 里 HTTPS_ENABLED=true"
say "    2) $RELOAD_CMD          # 服务只在启动时读证书，所以必须重启"
say "    3) 日志里应出现「已启用 HTTPS（安全上下文，平板可安装为应用）」"
say "    4) 浏览器打开 https://$DOMAIN:8788 —— 应该不再有任何警告"
say ""
say "  之后每次续期都会自动执行上面那条 reload（acme.sh 的定时任务里），不用管。"
say "  查续期任务：  crontab -l | grep acme"
say "  手动试一次：  $ACME --cron --home $ACME_HOME"
say ""
say "  ⚠️ 换了公信证书之后，用**内网 IP** 访问会重新报警（证书里没有那个 IP）。"
say "     内网也改用域名访问即可 —— 域名解析到公网 IPv6，在家是直连、不走 NAT。"
say "  ⚠️ mkcert 那张 rootCA.crt 可以删了；删掉后 /api/diag/rootca.crt 会回 404（正常）。"
