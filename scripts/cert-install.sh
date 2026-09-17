#!/usr/bin/env bash
# =============================================================================
# 二年级快乐学习台 · 把手头已有的证书装进 server/certs/
# -----------------------------------------------------------------------------
# 用在两种场景：
#   ① 证书是在**别处**签好的（别的 acme.sh / 面板 / 服务商后台下载的压缩包），
#      你只想把它放对位置 —— 那就用这个脚本，不要重复签发；
#   ② 不想装 acme.sh 的自动续期，打算 90 天手动来一次。
#
# 用法（在 NAS / Linux 上，仓库根目录）：
#   bash scripts/cert-install.sh <fullchain 文件> <key 文件> [域名]
#   例：bash scripts/cert-install.sh fullchain.crt fn.chinlinger.top.key fn.chinlinger.top
#
# 服务端启动时只读一次证书、读进内存 → **装完必须重启容器**（脚本会提示命令）。
#
# 常见的下载包命名（各家不一样，靠内容判断才可靠）：
#   fullchain.crt / fullchain.pem      = 叶子 + 中间证书  ← 要的是这个
#   <域名>.crt / certificate.crt / cert.pem = 只有叶子证书（**不能单独用**，缺中间证书）
#   <域名>.key / privkey.pem           = 私钥
#   issuer_certificate.crt / ca_bundle.crt / chain.pem = 中间证书（已含在 fullchain 里）
# =============================================================================
set -euo pipefail

if [ "$#" -lt 2 ]; then
  cat >&2 <<'USAGE'
用法：bash scripts/cert-install.sh <fullchain 文件> <key 文件> [域名]
  例：bash scripts/cert-install.sh fullchain.crt fn.chinlinger.top.key fn.chinlinger.top
USAGE
  exit 2
fi

SRC_CHAIN="$1"
SRC_KEY="$2"
EXPECT_DOMAIN="${3:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CERT_DIR="$REPO_ROOT/server/certs"
RESTART_CMD="${RELOAD_CMD:-cd $REPO_ROOT/deploy && docker compose restart app}"

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*" >&2; }
die()  { printf '\n失败：%s\n' "$*" >&2; exit 1; }
abs()  { (cd "$(dirname "$1")" && printf '%s/%s' "$(pwd)" "$(basename "$1")"); }

step "检查输入"
[ -f "$SRC_CHAIN" ] || die "找不到证书文件：$SRC_CHAIN"
[ -f "$SRC_KEY" ]   || die "找不到私钥文件：$SRC_KEY"
say "  证书 $SRC_CHAIN"
say "  私钥 $SRC_KEY"

HAVE_OPENSSL=1
command -v openssl >/dev/null 2>&1 || HAVE_OPENSSL=0
[ "$HAVE_OPENSSL" = 1 ] || warn "没有 openssl，跳过内容校验（只做拷贝）"

if [ "$HAVE_OPENSSL" = 1 ]; then
  # ------------------------------------------------- 1. 证书链是否完整
  step "校验证书链"
  N="$(grep -c -- '-----BEGIN CERTIFICATE-----' "$SRC_CHAIN" || true)"
  say "  $SRC_CHAIN 里有 $N 张证书"
  if [ "$N" -lt 2 ]; then
    die "这个文件里只有 $N 张证书 —— 多半是「只有叶子证书」的那一份。
    服务端要的是**全链**（叶子 + 中间证书），否则安卓 / 老浏览器会报「证书链不完整」。
    修法（把叶子和你手上的中间证书拼起来）：
      cat <域名>.crt issuer_certificate.crt > fullchain.crt
      bash scripts/cert-install.sh fullchain.crt <域名>.key
    或者直接改用下载包里现成的 fullchain.crt。"
  fi

  # ------------------------------------------------- 2. 证书与私钥是否配对
  step "校验证书与私钥是否配对"
  H1="$(openssl x509 -in "$SRC_CHAIN" -noout -pubkey | openssl md5 | awk '{print $NF}')"
  H2="$(openssl pkey -in "$SRC_KEY" -pubout 2>/dev/null | openssl md5 | awk '{print $NF}' || true)"
  if [ -z "$H2" ]; then
    warn "读不出私钥（可能不是 PEM 格式，或是加密私钥）—— 无法比对，请自行确认"
  elif [ "$H1" != "$H2" ]; then
    die "证书和私钥不配对（公钥指纹不同）。同一个下载包里同名但不同批次的文件很容易拿错，
    请用「和这张证书一起下载」的那把 key。"
  else
    say "  配对 OK（公钥指纹 $H1）"
  fi

  # ------------------------------------------------- 3. 域名与有效期
  step "证书信息"
  openssl x509 -in "$SRC_CHAIN" -noout -subject -issuer -dates 2>/dev/null | sed 's/^/  /'
  SAN="$(openssl x509 -in "$SRC_CHAIN" -noout -ext subjectAltName 2>/dev/null \
        | tail -n +2 | tr -d ' ' || true)"
  if [ -n "$SAN" ]; then
    say "  SAN: $SAN"
    if [ -n "$EXPECT_DOMAIN" ]; then
      case "$SAN" in
        *"$EXPECT_DOMAIN"*) say "  ✓ SAN 覆盖 $EXPECT_DOMAIN" ;;
        *) die "SAN 里没有 $EXPECT_DOMAIN —— 用这个域名访问会报「主机名不匹配」。
    确认签的是不是这个域名（子域和主域不通用，除非签的是通配符）。" ;;
      esac
    fi
  else
    warn "读不到 SAN 扩展，请自行确认证书覆盖的域名"
  fi

  END="$(openssl x509 -in "$SRC_CHAIN" -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
  if [ -n "$END" ]; then
    say "  到期：$END"
    END_S="$(date -d "$END" +%s 2>/dev/null || echo 0)"
    NOW_S="$(date +%s)"
    if [ "$END_S" != "0" ]; then
      DAYS=$(( (END_S - NOW_S) / 86400 ))
      if [ "$DAYS" -lt 0 ]; then
        die "这张证书已经过期了（$END）。"
      elif [ "$DAYS" -lt 14 ]; then
        warn "只剩 $DAYS 天 —— 装之前先想清楚续期怎么接上，否则很快又会报警。"
      else
        say "  剩余 $DAYS 天"
      fi
    fi
  fi
fi

# ----------------------------------------------------- 4. 落盘
step "装到 $CERT_DIR"
mkdir -p "$CERT_DIR"
# 源文件就是目标文件时（比如想「原地复查一遍」），cp 会报 same file，这里直接跳过拷贝
if [ "$(abs "$SRC_CHAIN")" = "$CERT_DIR/cert.pem" ] && [ "$(abs "$SRC_KEY")" = "$CERT_DIR/key.pem" ]; then
  say "  源文件已经在目标位置了，跳过拷贝（只做校验）"
else
  cp -f "$SRC_CHAIN" "$CERT_DIR/cert.pem"
  cp -f "$SRC_KEY"   "$CERT_DIR/key.pem"
  say "  $CERT_DIR/cert.pem"
  say "  $CERT_DIR/key.pem"
fi
chmod 644 "$CERT_DIR/cert.pem" 2>/dev/null || true
chmod 600 "$CERT_DIR/key.pem"  2>/dev/null || true

if [ -f "$CERT_DIR/rootCA.crt" ]; then
  warn "还留着 mkcert 那张 rootCA.crt —— 公信证书用不上它了（设备上装过的根证书也可以卸掉）。
    想删： rm -f $CERT_DIR/rootCA.crt
    删完 /api/diag/rootca.crt 会回 404，这是**正常**的，不是坏了。"
fi

step "完成"
say "接下来："
say "  1) $RESTART_CMD"
say "     （服务只在启动时读证书，不重启不生效；改证书不需要 --build）"
say "  2) docker compose logs --tail=40 app | grep -i https"
say "  3) 换完证书后**内网也要改用域名访问** —— 公信 CA 不给私有 IP 签证书，"
say "     继续用 https://<内网IP>:8788 会重新报警，这是必然的、不是没配好。"
say ""
say "  想以后不用手动管：这一份证书如果是 acme.sh 签的，可以挂上自动续期 ——"
say "    ~/.acme.sh/acme.sh --install-cert -d <域名> \\"
say "      --key-file       $CERT_DIR/key.pem \\"
say "      --fullchain-file $CERT_DIR/cert.pem \\"
say "      --reloadcmd      'docker restart grade2-app'"
say "  如果不是（面板 / 服务商后台下载的），就把「重新下载 → 跑本脚本 → 重启容器」"
say "  写进日历或计划任务，别指望自己记得住 90 天。"
