# 二年级快乐学习台

给二年级小朋友用的学习台：每日口算、语文写字听写、童话阅读、错题本。界面是马卡龙配色 + 大字 + 手写板，跑在家里的电脑上，同一个 Wi-Fi 下平板 / 手机都能打开。

**已从单文件 HTML 改造为前后端分离**：大模型密钥、语音合成、数据存储全部收进后端，前端只负责界面和进度。

---

## 一、它长什么样

```
┌── 孩子端（平板 / 手机浏览器）──────────────────────┐
│  今日   │ 口算 │ 语文 │ 童话 │ 语言 │ 英文 │ 错题本 │
│                                                  │
│  · 今日：学习小岛地图 —— 六项任务排成一条闯关路线，│
│         完成一座才解锁下一座，奖励挂在进度上       │
│  · 口算：20 道 100 以内加减 / 表内乘法，即时判对错 │
│  · 语文：14 篇课文，可朗读、可屏上手写听写         │
│  · 童话：AI 生成短篇童话，逐句注音、点击跟读       │
│  · 语言：AI 每天出 9 道题（词语/搭配/扩句/改病句/  │
│         写具体/排句子/看图观察/看图说话/写一段），  │
│         看图题配真图，全做完 +20 分                │
│  · 英文：看一集英文故事（排在路线最后当奖励）      │
│  · 错题本：数学错题 + 语文错字，做对一次自动消掉   │
└──────────────────────────────────────────────────┘
┌── 家长后台（/admin，孩子端没有入口）───────────────┐
│  · 课文管理：增删改课文与生字、AI 推荐组词         │
│  · 批量粘贴生字表，自动拆字去重 + 注音             │
│  · 语音预热、缓存清理、备份与恢复                  │
└──────────────────────────────────────────────────┘
```

**闯关顺序**（首页地图从左到右，也是解锁顺序）：

| # | 小岛 | 对应任务 | 通关奖励 |
|---|------|----------|----------|
| 1 | 口算岛 | 20 道口算全部作答 | +10（全对再 +10） |
| 2 | 听写屋 | 任意一课完成一轮听写 | +10（全对再 +10） |
| 3 | 错题修理站 | 把错题重做一遍 | 不发分，只清错题 |
| 4 | 故事树 | 读一篇注音童话满 15 分钟 | +20 |
| 5 | 语言练习 | 9 道题全做完 | +20 |
| 6 | 英文小屋 | 完整看完一集英文故事 | +10 |
| — | 全勤 | 六项全部完成 | +10 |

错题修理站**不参与顺序锁**：错题本该是想看就能看的东西，它自己那层闸（口算 + 听写做完才能重做，随时可以查看）在错题本页里。

## 二、目录结构

```
.
├─ start.cmd                双击即用：Windows 一键本地启动
├─ scripts/start.ps1        一键启动的真实逻辑（可带参数）
├─ web/                     前端（Vue 3 + Vite + Pinia）
│  ├─ src/views/            孩子端各页面（今日/口算/语文/童话/语言/错题本/积分）+ /admin 后台
│  ├─ src/components/       手写板、听写面板、故事阅读器、诊断抽屉…
│  ├─ src/stores/           API 驱动的状态层（无 localStorage 业务数据）
│  └─ test/smoke.mjs        真实浏览器端到端冒烟测试
├─ server/                  后端（Node + Express + TypeScript）
│  ├─ .env.example          ← 本地配置模板（推荐从这里复制成 .env）
│  ├─ config/config.yaml    细节配置（音色/超时/备份…）
│  ├─ src/routes/           REST 接口
│  ├─ src/services/         LLM / TTS / 判卷 / 备份 / 日志
│  ├─ src/db/               双驱动（sqlite / mysql）+ 仓储层
│  └─ test/api.test.ts      123 条断言的后端集成测试
├─ deploy/                  Docker 部署件（本地验证用不到）
│  ├─ Dockerfile
│  ├─ docker-compose.yml
│  ├─ nginx.conf            可选反向代理
│  ├─ backup.sh             异地备份
│  └─ .env.example          容器用环境变量模板
└─ grade2-workbench.html    改造前的单文件版本（保留作为对照）
```

## 三、本地跑起来

### 方式一：一键启动（推荐）

**Windows：直接双击仓库根目录的 `start.cmd`。**

它会自动：找到 Node → 缺依赖就装 → 检查 `.env`（没有就帮你生成并打开记事本让你填密钥）→ 需要时构建前端 → 检查 8788 端口是否被占（被占会问你要不要结束它，并且**连启动器一起结束**，避免被自动重启）→ 启动服务 → 自动打开浏览器。

可用参数：

```powershell
.\scripts\start.ps1 -SkipBuild    # 跳过前端构建，重启更快
.\scripts\start.ps1 -NoBrowser    # 不自动开浏览器
.\scripts\start.ps1 -Force        # 端口被占时不再询问，直接结束占用者
```

> 脚本按约定**只使用托管安装的 Node**（`~/.workbuddy/binaries/node/versions/`），
> 不会去用系统 PATH 或 nvm 里的 node —— 避免和你机器上其它项目的 Node 版本互相干扰。

### 方式二：手动起（开发时改代码用热更新）

```powershell
cd server ; npm run dev      # 后端 :8788，改代码自动重启
cd web    ; npm run dev      # 前端 :5180，/api 自动代理到 8788
```

浏览器开 `http://localhost:5180`（家长后台 `/admin`）。

> 不想要 Vite 那一层就直接 `cd web ; npm run build`，产物落到 `web/dist`，
> 后端发现它存在会自动托管，开 `http://localhost:8788` 一个端口就够。

### 关于 `.env`：它放在哪儿、谁读它

后端启动时会按这个顺序找 `.env`，**先找到的先赢**：

1. `server/.env` ← 本地运行建议放这儿
2. 仓库根目录 `.env`
3. `deploy/.env` ← 原本给 docker compose 用的，本地也会顺带读

真实环境变量永远优先于 `.env` 文件里的同名项。
启动日志里会明确打出「已加载 .env 来源=…」，一眼能确认配置有没有被读到。

模板：`server/.env.example`（本地版，注释最全）。

### 第一次用要做的事

1. **填密钥**：至少有 `LLM_API_KEY`。手写判卷还需要一个**视觉模型**，见第五节。
2. **灌课文**：后端启动自动写入 14 篇课文 + 153 个生字（幂等，不会重复插）。
3. **预热语音**：`/admin` → 点某篇课文 → 语音预热。之后孩子听写就是本地缓存，秒出。

## 四、部署到家里的机器（Docker）

```bash
cd deploy
cp .env.example .env
vi .env                      # 必填 LLM_API_KEY、DB_PASSWORD
docker compose up -d --build
```

然后孩子用平板访问 `http://<这台机器的内网IP>:8788`。

**不想装 MySQL**：`deploy/docker-compose.yml` 里把 `db:` 整段删掉，`.env` 里设 `DB_DRIVER=sqlite`。数据落在 `app-data` 卷里，同样持久。家庭内网单设备用，sqlite 完全够。

**要固定域名 / HTTPS**：`docker compose --profile proxy up -d`，走 `deploy/nginx.conf`。

**要改 config.yaml 里的高级项**（模型名、音色、超时）：容器里的配置来自镜像，想改就走挂载——

```bash
cp ../server/config/config.yaml ./config.yaml
# 打开 docker-compose.yml，去掉 app.volumes 最后那行的注释
docker compose restart app
```

数据库地址和密钥这类常用项直接在 `.env` 里写就行，不用动配置文件。

### 数据放在哪

| 内容 | 容器内路径 | 卷 |
|---|---|---|
| 数据库 | `/app/server/data/grade2.db` | `app-data` |
| 语音缓存 | `/app/server/data/tts/` | `app-data` |
| 自动备份 | `/app/server/data/backup/` | `app-data` |
| 运行日志 | `/app/server/logs/` | `app-logs` |

语音缓存是可再生的（删了会重新合成），真正不能丢的只有数据库。

## 五、配置说明

配置分两层，**日常只改 `.env` 就够**：

- `.env`（推荐）——密钥、模型名、数据库、端口。改完重启服务生效。
- `server/config/config.yaml`——细节项（音色、语速、超时、备份时间…）。支持 `${VAR}` 与 `${VAR:-默认值}`，所以同一份配置本地和容器都能用。

两者覆盖同一批键时，**环境变量优先于 `.env`，`.env` 优先于 `config.yaml` 的写法默认值**。

### 多个模型怎么配

程序把大模型用在 **3 个地方**，可以各用一个模型，甚至可以来自不同厂商：

| 用途 | 变量 | 要求 |
|---|---|---|
| 生成童话 | `LLM_STORY_MODEL` | 纯文本模型即可，挑便宜的 |
| 手写判卷 | `LLM_MARK_MODEL` | ⚠️ **必须支持看图（视觉/多模态）**，纯文本模型一定失败 |
| 组词建议 | `LLM_SUGGEST_MODEL` | 纯文本 |

**场景 A：全都用 DeepSeek（默认）**
什么都不用填。但注意 DeepSeek 目前没有视觉模型，判卷必须换别家 → 看场景 C。

**场景 B：同一家厂商，只是不同模型**
只填模型名，`baseUrl` 和 `apiKey` 继续共用全局值：

```dotenv
LLM_STORY_MODEL=deepseek-chat
LLM_MARK_MODEL=qwen-vl-max
```

**场景 C：不同厂商，各用各的密钥（最常见的真实需求）**
给某个用途加 `LLM_<用途>_BASE_URL` 和 `LLM_<用途>_API_KEY`，留空就自动回落到全局值：

```dotenv
# 故事走 DeepSeek
LLM_STORY_MODEL=deepseek-chat

# 判卷走阿里云百炼
LLM_MARK_MODEL=qwen-vl-max
LLM_MARK_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MARK_API_KEY=sk-阿里的密钥
```

**厂商参数速查**

| 厂商 | 视觉模型 | base_url |
|---|---|---|
| DeepSeek | ✗ 无 | `https://api.deepseek.com/v1` |
| 阿里云百炼 | ✓ `qwen-vl-max` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 智谱 GLM | ✓ `glm-4v-plus` | `https://open.bigmodel.cn/api/paas/v4` |
| 月之暗面 | ✓ `moonshot-v1-8k-vision-preview` | `https://api.moonshot.cn/v1` |
| 火山方舟 | ✓ `doubao-1.5-vision-pro` | `https://ark.cn-beijing.volces.com/api/v3` |
| OpenAI | ✓ `gpt-4o` | `https://api.openai.com/v1` |

**怎么确认配对了**：启动日志会逐个用途打印解析结果；页面里的「诊断」抽屉 → `GET /api/diag/llm` 会列出每个用途实际用的模型、走的是哪家、是「共享 provider」还是「独立 provider」，并可用 `POST /api/diag/llm-test` 真实调一次验证（消耗极少 token）。

### 其它常用项

```dotenv
APP_PORT=8788              # 浏览器访问端口
DB_DRIVER=sqlite           # sqlite（默认，零运维）| mysql
```

音色与语速在 `config.yaml` 的 `tts` 段（默认 `zh-CN-XiaoyiNeural` 女童音、语速 `-12%`）。

密钥只出现在后端日志的脱敏位置（`sk-a…mnop`），永远不会下发给前端。

## 六、孩子端几个关键行为

**听写（语文页）**——这是改造中最核心的变化：

1. 选好课文，点「开始屏上听写」。
2. 语音念一个字，孩子在田字格里手写；写错点「清空重写」。
3. **一整轮全部写完**，再点「结束听写」一次性提交。
4. 提交后有两种批改方式：
   - **AI 批改**：N 个字拼成一张图，**一次**多模态请求判完（比逐字请求省约 8 倍成本）。返回结果会做严格的「数量 + 序号」校验，对不上就自动降级为逐字判，不会错位。
   - **家长批改**：不调模型，家长在屏幕上逐字点 √ / ×。
5. 写错的字自动进错题本，掌握了自动消掉。

**口算**——20 题全部作答即视为「已完成」（不管错几道）；全对才给满分反馈和庆祝动效。

**朗读**——优先用后端 Edge TTS 生成的 MP3；后端不可用时自动退回浏览器自带语音，孩子那边不会遇到「点了没声音」。

## 七、备份与恢复

- **自动**：后端每天凌晨 3 点写一份 JSON 快照到 `data/backup/`，保留 30 天。
- **异地**：`deploy/backup.sh` 把快照和 `mysqldump` 一起挪到另一块盘 / NAS：

  ```bash
  ./deploy/backup.sh /mnt/nas/grade2
  # 加进 crontab：0 4 * * * /path/to/deploy/backup.sh /mnt/nas/grade2
  ```
- **恢复**：`/admin` → 系统 → 导入备份。兼容两种格式：
  - 本服务导出的 **v2** 快照
  - **老单文件 HTML** 版本导出的 localStorage 备份（掌握度按课文标题映射回生字）

  导入可选「合并 / 覆盖」，默认跳过示例数据。

## 八、接口速览

| 分组 | 说明 |
|---|---|
| `GET /api/health` | 版本、运行时长、数据库统计、脱敏后的模型配置 |
| `/api/lessons*` | 课文与生字读取 |
| `/api/story*` | 童话生成（可传已读标题避免重复出题） |
| `/api/tts?text=` | 取语音 MP3（缓存未命中就现合成） |
| `/api/mark*` | 听写判卷：POST 建任务返回 `taskId`，GET 轮询结果 |
| `/api/state*` | 每日进度 / 口算 / 掌握度 / 错题 / 阅读计时 |
| `/api/admin*` | 课文增删改、批量导字、AI 组词、预热、清缓存 |
| `/api/backup*` | 导出 / 快照列表 / 立即备份 / 恢复 |
| `/api/diag*` | 日志、模型连通性自检、TTS 自检 |

判卷是**异步**的：POST 立刻返回 `taskId`，前端轮询。因为一次多模态请求可能几十秒，同步接口会超时。

## 九、自检与排错

页面顶栏有日志入口（诊断抽屉），能看到后端实时日志。

```bash
# 后端集成测试（257 条断言，含真实 Edge TTS）
cd server && npm test

# 真实浏览器冒烟测试（需先起后端）
cd web && node test/smoke.mjs http://127.0.0.1:8788
```

常见问题：

| 现象 | 原因 / 处理 |
|---|---|
| 页面显示「学习台暂时打不开」 | 后端没起，或设备与服务器不在同一 Wi-Fi |
| 判卷一直失败 | 判卷模型不支持视觉。换成 `qwen-vl-max` / `glm-4v-plus` / `gpt-4o` |
| 故事生成超时 | 换国内厂商接口，或调大 `llm.timeoutMs.story` |
| 点了朗读没声音 | 检查日志里的 TTS 段；浏览器策略要求首次交互后才能出声，点一下页面即可 |
| 改完 config.yaml 不生效 | 需要重启服务。容器里：`docker compose restart app` |
| 在家里也要输口令、家长后台接口全 403 | 容器看到的来源地址被 Docker 改写了（公网 IPv6 走 userland docker-proxy 时必然如此）。先看接口日志里的 `ip` 字段：若是 `172.22.0.1` 这种**网桥网关**而不是你家的地址，就说明来源 IP 丢了 —— `deploy/docker-compose.yml` 的 app 必须用 `network_mode: host`（默认已是），且 `AUTH_LAN_CIDRS` 要覆盖你家的 IPv4 段和 IPv6 /64 |
| 换了公信证书后，用内网 IP 访问反而报警 | 证书里只有域名。内网也改用域名访问（公信 CA 不给私有 IP 签证书） |

## 十、后续可做

- 多孩共用（数据库已有 `children` 表，接口目前固定用默认孩子）
- 生字描红字帖导出 PDF
- 口算错题的相似题强化训练
