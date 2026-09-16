# =============================================================================
# 二年级快乐学习台 · 内网 HTTPS 一键配置（mkcert 自签）
# -----------------------------------------------------------------------------
# 为什么需要这个：
#   安卓 Chrome 只在「安全上下文」（https:// 或 http://localhost）里才会
#     1) 允许注册 Service Worker
#     2) 把网页装成应用（WebAPK —— 独立窗口，**没有地址栏和底栏**）
#   内网跑 http://192.168.x.x 时这两件都做不到，「添加到主屏幕」只会退化成
#   普通书签快捷方式，打开时浏览器头尾照样在。这就是平板上的那个问题。
#
# 这个脚本做四件事：
#   1. 找 mkcert（没有就用 winget 装）
#   2. mkcert -install —— 把本地 CA 装进 Windows 受信任根
#   3. 把本机所有可用内网 IPv4 + localhost / 127.0.0.1 / ::1 / 主机名一起签进证书
#      SAN 里（多地址覆盖，换个 IP 不用重签；但 IP 变了要重跑）
#   4. 证书落到 server/certs/，并把根证书也复制一份出来供平板下载
#
# 用法（仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts/https-setup.ps1
#
# 参数：
#   -Force   已有证书时也重新签一份
# =============================================================================
[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Windows PowerShell 5.1 默认按 ANSI(GBK) 解码脚本文件，中文会乱码。
# 本文件已另存为 UTF-8 with BOM；这里再统一控制台输出编码，双保险。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CertDir  = Join-Path $RepoRoot "server\certs"
$CertFile = Join-Path $CertDir "cert.pem"
$KeyFile  = Join-Path $CertDir "key.pem"
$RootCopy = Join-Path $CertDir "rootCA.crt"

function Say  { param([string]$m) Write-Host $m }
function Step { param([string]$m) Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Good { param([string]$m) Write-Host "    OK  $m" -ForegroundColor Green }
function Warn { param([string]$m) Write-Host "    注意 $m" -ForegroundColor Yellow }
function Die  {
    param([string]$m)
    Write-Host ""
    Write-Host "    失败 $m" -ForegroundColor Red
    exit 1
}

# ------------------------------------------------------------------ 1. mkcert
Step "检查 mkcert"
$mkcert = Get-Command mkcert -ErrorAction SilentlyContinue
if (-not $mkcert) {
    Warn "没找到 mkcert，尝试用 winget 安装（FiloSottile.mkcert）"
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        $help = @"
没找到 mkcert，也没找到 winget。请任选一种方式装好 mkcert 后重跑：
  · winget install -e --id FiloSottile.mkcert
  · scoop install mkcert
  · choco install mkcert
  · 或直接下载 https://github.com/FiloSottile/mkcert/releases 里的 exe 放进 PATH
"@
        Die $help
    }
    # winget 装完当前进程的 PATH 不会刷新，所以装完再找一次
    & winget install -e --id FiloSottile.mkcert --accept-source-agreements --accept-package-agreements
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path    = @($machinePath, $userPath) -join ";"
    $mkcert = Get-Command mkcert -ErrorAction SilentlyContinue
    if (-not $mkcert) {
        Die "winget 装完了但当前会话仍找不到 mkcert。请重开一个终端再跑一次本脚本。"
    }
}
Good "mkcert：$($mkcert.Source)"

# ------------------------------------------------------------- 2. 装本地 CA
Step "把本地 CA 装进 Windows 受信任根（mkcert -install）"
try {
    & mkcert -install
} catch {
    Die "mkcert -install 失败：$($_.Exception.Message)"
}
$Caroot = (& mkcert -CAROOT).Trim()
Good "CA 目录：$Caroot"

# --------------------------------------------------- 3. 收集要签进证书的地址
Step "收集本机地址"
# 与后端 index.ts 的 localAddresses 保持一致：过滤虚拟网卡，它们的地址平板根本连不上
$Virtual = "wsl|docker|veth|vmware|virtualbox|hyper-v|loopback|tailscale|zerotier|vEthernet"
$ips = @(
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -ne "127.0.0.1" -and
            $_.IPAddress -notlike "169.254.*" -and
            $_.InterfaceAlias -notmatch $Virtual
        } |
        ForEach-Object { $_.IPAddress } |
        Select-Object -Unique
)
$hosts = @("localhost", "127.0.0.1", "::1")
if ($env:COMPUTERNAME) { $hosts += $env:COMPUTERNAME }
if ($ips.Count) { $hosts += $ips }
$hosts = $hosts | Select-Object -Unique
foreach ($h in $hosts) { Good $h }

# ---------------------------------------------------------------- 4. 签证书
Step "签发证书"
if ((Test-Path $CertFile) -and -not $Force) {
    Warn "证书已存在：$CertFile"
    Warn "要重新签一份请加 -Force（例如地址变了、或证书快过期了）"
} else {
    New-Item -ItemType Directory -Force -Path $CertDir | Out-Null
    if (Test-Path $CertFile) { Remove-Item -Force $CertFile }
    if (Test-Path $KeyFile)  { Remove-Item -Force $KeyFile }
    & mkcert -cert-file $CertFile -key-file $KeyFile @hosts
    if ($LASTEXITCODE -ne 0) { Die "mkcert 签发失败（退出码 $LASTEXITCODE）" }
    Good "证书：$CertFile"
    Good "私钥：$KeyFile"
}

# 根证书也放一份到证书目录：平板要装它，而让服务自己发一份比插 USB 省事得多
$rootPem = Join-Path $Caroot "rootCA.pem"
if (Test-Path $rootPem) {
    Copy-Item -Force $rootPem $RootCopy
    Good "根证书副本：$RootCopy"
} else {
    Warn "没找到 $rootPem，平板那一步需要自己从 CA 目录拷出来"
}

# ------------------------------------------------------------------- 收尾提示
$shownIp = if ($ips.Count) { $ips[0] } else { "<本机内网IP>" }

Say ""
Say "============================================================="
Say " 证书就绪，接下来三步（顺序别调：先装证书再开 HTTPS）"
Say "============================================================="
Say ""
Say " 1) 平板先装一次根证书（没开 HTTPS 之前，正好好下载）"
Say "    · 平板浏览器打开："
Say "        http://$shownIp`:8788/api/diag/rootca.crt"
Say "      浏览器会下载一个 rootCA.crt"
Say "    · 设置 → 安全 → 更多安全设置 → 加密与凭据 → 安装证书 → CA 证书"
Say "      → 选刚下载的 rootCA.crt → 确认"
Say "      系统会提示「您的数据将不再私密」——这是装用户级 CA 的正常提示，继续即可"
Say "      部分机型还要在「加密与凭据 → 受信任的凭据 → 用户」里能看到它才算装好"
Say ""
Say " 2) 打开 HTTPS"
Say "    改 server\config\config.yaml 里的这一段："
Say ""
Say "        https:"
Say "          enabled: true"
Say "          certFile: ./certs/cert.pem"
Say "          keyFile: ./certs/key.pem"
Say ""
Say "    或者更省事：在 server\.env 里加一行 HTTPS_ENABLED=true"
Say ""
Say " 3) 重启服务（双击 start.cmd，或者到 server 目录 npm run dev）"
Say "    启动日志里会打印 HTTPS 地址，并出现「已启用 HTTPS（安全上下文）」"
Say ""
Say " 装完之后：平板打开 https://$shownIp`:8788"
Say "   Chrome 右上角菜单 → 安装应用（或添加到主屏幕）→ 图标点开就是独立窗口，"
Say "   没有地址栏、没有底栏。首次安装后建议把旧的 http 书签删掉。"
Say ""
Say " ============================================================="
Say " 三个坑"
Say " ============================================================="
Say ""
Say " · 开了 HTTPS 之后 http 就访问不了了（所以第 1 步要排在前面）。"
Say "   日后要再下一次根证书，就用 https 打开，Chrome 提示不安全时点「高级 → 继续前往」，"
Say "   或者直接从 mkcert -CAROOT 目录里拷 rootCA.pem。"
Say " · 证书有有效期（默认约 2 年），到期后 Chrome 会报「连接不是私密连接」，"
Say "   重跑本脚本（加 -Force）即可。本机内网 IP 变了也要重跑并重装证书。"
Say " · 如果平板打开 https 后 Chrome 仍提示不安全，八成是根证书没装成功，"
Say "   回到第 1 步重来；命令行可用 mkcert -CAROOT 找到 CA 目录核对。"
Say ""
