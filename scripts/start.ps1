# =============================================================================
# 二年级快乐学习台 · 本地一键启动
# -----------------------------------------------------------------------------
# 直接双击仓库根目录的 start.cmd 即可，不用手敲任何命令。
#
# 它按顺序做这几件事（每一步都会打印在做什么，哪一步失败了一眼能看出来）：
#   1. 找到可用的 Node
#   2. 缺依赖就装（server / web）
#   3. 检查 .env：没有就帮你生成一份，并提示去填密钥
#   4. 前端没构建过、或源码比产物新 → 重新构建（后端会直接托管它）
#   5. 检查 8788 端口是否被占
#   6. 启动后端，并打印本机 / 平板可用的地址
#
# 参数：
#   -SkipBuild   跳过前端构建（前端没改动时，重启会快很多）
#   -NoBrowser   启动后不自动开浏览器
# =============================================================================
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$NoBrowser,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Windows PowerShell 5.1 默认按 ANSI(GBK) 解码脚本文件，中文会乱码。
# 本文件已另存为 UTF-8 with BOM；这里再统一控制台输出编码，双保险。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$ServerDir  = Join-Path $RepoRoot "server"
$WebDir     = Join-Path $RepoRoot "web"
$EnvFile    = Join-Path $ServerDir ".env"
$EnvSample  = Join-Path $ServerDir ".env.example"

function Say  { param([string]$m) Write-Host $m }
function Step { param([string]$m) Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Good { param([string]$m) Write-Host "    OK  $m" -ForegroundColor Green }
function Warn { param([string]$m) Write-Host "    警告 $m" -ForegroundColor Yellow }
function Die  {
    param([string]$m)
    Write-Host ""
    Write-Host "启动失败：$m" -ForegroundColor Red
    Write-Host ""
    Read-Host "按回车键关闭"
    exit 1
}

Say ""
Say "  二年级快乐学习台 · 本地启动" -ForegroundColor Magenta
Say "  ---------------------------------------------"

# ---------------------------------------------------------------- 1. Node
Step "检查 Node"

<#
 只使用 WorkBuddy 托管安装的 Node（在 ~/.workbuddy/binaries/node/versions 下）。
 刻意**不去**用系统 PATH 里的 node 或 nvm 的 node：
   · 避免和你本机其它项目的 Node 版本互相干扰
   · 托管版本是固定的，谁的机器上跑结果都一样
 配套的 npm 也在同一目录（npm.cmd 内部绑定自己那一份 node.exe），不会串味。
 版本优先级：versions/current 记录的版本 → 固定版本 → 目录下任意一个。
#>
$ManagedRoot = Join-Path $env:USERPROFILE ".workbuddy\binaries\node\versions"
$NodeExe = $null

if (Test-Path $ManagedRoot) {
    # versions/current 是一个只写了版本号的文本文件
    $curFile = Join-Path $ManagedRoot "current"
    if (Test-Path $curFile) {
        $curVer = ((Get-Content $curFile -Raw) -replace "\s", "")
        if ($curVer) {
            $cand = Join-Path $ManagedRoot "$curVer\node.exe"
            if (Test-Path $cand) { $NodeExe = $cand }
        }
    }
    if (-not $NodeExe) {
        $pinned = Join-Path $ManagedRoot "22.22.2-3\node.exe"
        if (Test-Path $pinned) { $NodeExe = $pinned }
    }
    if (-not $NodeExe) {
        $NodeExe = Get-ChildItem $ManagedRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "node.exe" } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
    }
}

if (-not $NodeExe) {
    Die @"
找不到托管安装的 Node（应该位于：
    $ManagedRoot
这个脚本按约定只使用托管 Node，不会去用系统 PATH 或 nvm 里的 node，
以免和你机器上其它项目互相干扰。请先安装托管运行时，或改 scripts\start.ps1 里这一段。
"@
}

$NodeDir = Split-Path -Parent $NodeExe
$nodeVersion = (& $NodeExe -v)
Good "node $nodeVersion"
Say "        $NodeExe"

# 校验 node 真的能执行代码（有些环境里 node 只是个空壳，版本能打印但跑不起来）
try {
    $probe = (& $NodeExe -e "console.log('ok')" 2>&1)
    if ("$probe".Trim() -ne "ok") { Die "这个 Node 无法正常执行代码（输出：$probe）" }
} catch {
    Die "这个 Node 无法正常执行代码：$($_.Exception.Message)"
}

# 用同目录的 npm.cmd；它内部用的是同一份 node.exe
$NpmCmd = Join-Path $NodeDir "npm.cmd"
if (-not (Test-Path $NpmCmd)) {
    Die "在 $NodeDir 找不到 npm.cmd，Node 安装可能不完整"
}
Good "npm $(& $NpmCmd -v)"

function Invoke-Npm {
    param([string]$Dir, [string[]]$NpmArgs, [string]$What)
    Push-Location $Dir
    try {
        & $NpmCmd @NpmArgs
        if ($LASTEXITCODE -ne 0) { Die "$What 失败（npm 退出码 $LASTEXITCODE）" }
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------- 2. 依赖
Step "检查依赖"
if (-not (Test-Path (Join-Path $ServerDir "node_modules"))) {
    Warn "server 依赖未安装，正在安装（首次需要一两分钟）…"
    Invoke-Npm -Dir $ServerDir -NpmArgs @("install", "--no-audit", "--no-fund", "--loglevel=error") -What "server 依赖安装"
    Good "server 依赖就绪"
} else {
    Good "server 依赖已存在"
}
if (-not (Test-Path (Join-Path $WebDir "node_modules"))) {
    Warn "web 依赖未安装，正在安装…"
    Invoke-Npm -Dir $WebDir -NpmArgs @("install", "--no-audit", "--no-fund", "--loglevel=error") -What "web 依赖安装"
    Good "web 依赖就绪"
} else {
    Good "web 依赖已存在"
}

# ---------------------------------------------------------------- 3. .env
Step "检查配置文件 .env"
$anyEnv = @(
    @(
        (Join-Path $ServerDir ".env"),
        (Join-Path $RepoRoot ".env"),
        (Join-Path $RepoRoot "deploy\.env")
    ) | Where-Object { Test-Path $_ }
)

if ($anyEnv.Count -eq 0) {
    if (Test-Path $EnvSample) {
        Copy-Item $EnvSample $EnvFile
        Warn "没有找到 .env，已为你生成：$EnvFile"
        Say ""
        Say "    请打开它，把这一行填上你的密钥后，重新双击 start.cmd：" -ForegroundColor Yellow
        Say "        LLM_API_KEY=sk-你的密钥" -ForegroundColor Yellow
        Say ""
        Say "    申请地址（DeepSeek，便宜稳定）：https://platform.deepseek.com" -ForegroundColor Yellow
        Say ""
        Start-Process notepad.exe $EnvFile
    } else {
        Die "没有 .env，也找不到模板 $EnvSample"
    }
    Read-Host "按回车键关闭"
    exit 0
} else {
    foreach ($f in $anyEnv) { Good "找到 $f" }
    $envText = Get-Content ($anyEnv[0]) -Raw
    if ($envText -match "(?m)^\s*LLM_API_KEY\s*=\s*(sk-\S+)") {
        $k = $Matches[1]
        Good "LLM_API_KEY 已填写（$($k.Substring(0,[Math]::Min(6,$k.Length)))…，长度 $($k.Length)）"
    } else {
        Warn "LLM_API_KEY 看起来是空的 —— 故事生成、手写判卷、组词建议都会失败"
        Warn "请编辑：$($anyEnv[0])"
    }

    # .env 里的 APP_PORT 后端运行时才读，这里提前取出来，好让下面的端口检查与实际一致
    foreach ($f in $anyEnv) {
        $t = Get-Content $f -Raw -ErrorAction SilentlyContinue
        if ($t -match "(?m)^\s*APP_PORT\s*=\s*(\d+)\s*$") {
            $script:AppPortFromEnv = [int]$Matches[1]
            break
        }
    }
    if ($script:AppPortFromEnv) { Good "APP_PORT=$($script:AppPortFromEnv)（来自 .env）" }
}

# ---------------------------------------------------------------- 4. 前端构建
function Test-NeedsBuild {
    $indexHtml = Join-Path $WebDir "dist\index.html"
    if (-not (Test-Path $indexHtml)) { return $true }
    $builtAt = (Get-Item $indexHtml).LastWriteTime
    $newer = Get-ChildItem -Path (Join-Path $WebDir "src") -Recurse -File -ErrorAction SilentlyContinue |
             Where-Object { $_.LastWriteTime -gt $builtAt } | Select-Object -First 1
    if ($newer) { return $true }
    if ((Get-Item (Join-Path $WebDir "vite.config.ts")).LastWriteTime -gt $builtAt) { return $true }
    return $false
}

Step "检查前端产物"
if ($SkipBuild) {
    Good "按参数要求跳过构建"
} elseif (Test-NeedsBuild) {
    Warn "前端未构建或源码已更新，正在构建…"
    Invoke-Npm -Dir $WebDir -NpmArgs @("run", "build") -What "前端构建"
    Good "前端构建完成"
} else {
    Good "前端产物是最新的"
}

# ---------------------------------------------------------------- 5. 端口
Step "检查端口"

<#
 找出「该杀谁」。
 为什么不能只杀监听 8788 的那个进程：如果它是由 `npm run dev`（tsx watch）拉起来的，
 杀了子进程，watch 会立刻重启一个新的，端口还是被占。
 所以要顺着 node.exe 的父子链往上爬到最顶层那个 node（也就是 npm / tsx watch），
 连同它的整棵树一起结束。
 只向上穿透 node.exe：碰到 cmd.exe / 终端就停手，绝不关掉你的命令行窗口。
#>
function Get-TopNodeOf {
    param([int]$StartPid)
    $cur = $StartPid
    for ($i = 0; $i -lt 8; $i++) {
        $me = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
        if (-not $me) { break }
        $parentId = [int]$me.ParentProcessId
        if ($parentId -le 0) { break }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction SilentlyContinue
        if (-not $parent) { break }
        if ("$($parent.Name)".ToLower() -eq "node.exe") { $cur = $parentId } else { break }
    }
    return $cur
}

$port = 8788
if ($env:APP_PORT -and "$env:APP_PORT" -match "^\d+$") {
    # 进程环境变量优先级最高
    $port = [int]$env:APP_PORT
    Good "端口来自环境变量 APP_PORT=$port"
} elseif ($script:AppPortFromEnv) {
    $port = $script:AppPortFromEnv
} else {
    # 从 config.yaml 读。只认「两个空格缩进」的 server.port，
    # 避免误匹配 db.mysql.port（那是四个空格缩进）。
    # 兼容两种写法：port: 8788  和  port: ${APP_PORT:-8788}
    $cfgPath = Join-Path $ServerDir "config\config.yaml"
    if (Test-Path $cfgPath) {
        $m = Select-String -Path $cfgPath -Pattern '^\s{2}port:\s*(?:\$\{[A-Za-z_]+:-(\d+)\}|(\d+))' |
             Select-Object -First 1
        if ($m) {
            $g = $m.Matches[0].Groups
            $val = if ($g[1].Success) { $g[1].Value } else { $g[2].Value }
            if ($val) { $port = [int]$val }
        }
    }
}
$busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) {
    $listenerPid = [int]$busy.OwningProcess
    $owner = Get-Process -Id $listenerPid -ErrorAction SilentlyContinue
    $ownerName = if ($owner) { $owner.ProcessName } else { "进程已退出" }
    $topPid = Get-TopNodeOf -StartPid $listenerPid
    Warn "端口 $port 已被占用：PID $listenerPid（$ownerName）"
    if ($topPid -ne $listenerPid) {
        $top = Get-Process -Id $topPid -ErrorAction SilentlyContinue
        $topName = if ($top) { $top.ProcessName } else { "进程已退出" }
        Warn "它是由启动器 PID $topPid（$topName）拉起来的，需要连启动器一起结束，否则会被自动重启"
    }
    if ($Force) {
        $ans = "y"
        Say "    已指定 -Force，直接结束它"
    } else {
        $ans = Read-Host "    结束它并继续？(Y/N)"
    }
    if ($ans -match "^(y|Y)") {
        # /T 连同子树一起结束，避免 watch 模式把子进程重新拉起来
        & taskkill.exe /PID $topPid /T /F 2>&1 | Out-Null
        Start-Sleep -Seconds 2
        $still = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($still) { Die "端口 $port 仍然被占用，请手动关闭占用它的程序。" }
        Good "已结束旧进程"
    } else {
        Die "端口被占用，无法启动。可以改 server/config/config.yaml 里的 server.port，或先关掉占用它的程序。"
    }
} else {
    Good "端口 $port 空闲"
}

# ---------------------------------------------------------------- 6. 启动
Step "启动后端"
Say "    （保持这个窗口开着；按 Ctrl+C 停止服务）"
Say ""

Push-Location $ServerDir
try {
    # 起一个后台小任务，等端口起来后自动打开浏览器
    if (-not $NoBrowser) {
        Start-Job -ScriptBlock {
            param($p)
            for ($i = 0; $i -lt 40; $i++) {
                Start-Sleep -Milliseconds 500
                try {
                    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/api/health" -UseBasicParsing -TimeoutSec 2
                    if ($r.StatusCode -eq 200) {
                        Start-Process "http://127.0.0.1:$p"
                        break
                    }
                } catch { }
            }
        } -ArgumentList $port | Out-Null
    }

    & $NodeExe "node_modules\tsx\dist\cli.mjs" "src\index.ts"
} finally {
    Pop-Location
}
