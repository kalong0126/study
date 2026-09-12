# 二年级快乐学习台 · 前后端分离改造计划

> 版本 v2 · 2026-09-12（已锁定 4 项决策）
> 现状：`grade2-workbench.html` 单文件 3419 行 / 128.7 KB，本地打开
> 目标：Vue 3 前端 + Node/Express 后端 + MySQL，部署在**家庭内网**，平板通过网址使用

---

## 0. 一句话结论

前端做「界面 + 交互」，后端做「模型调用 + TTS + 数据 + 密钥 + 日志」。家长配置删除、密钥进 `config.yaml`；学习数据从 localStorage 搬进 MySQL；新增一个家长内容后台用来录课文和生字；听写从「逐字提交」改为「整轮写完一起提交」。

## 1. 已锁定的 4 项决策

| 决策项 | 结论 | 带来的影响 |
|---|---|---|
| TTS 方案 | **Edge TTS**（免费） | 抽象 `TtsProvider` 接口，预留云厂商/本地模型切换；磁盘缓存 |
| 部署环境 | **仅家庭内网** | 无需备案、无需 HTTPS、不做鉴权；但**装不了 PWA**（见 §8.1） |
| 数据存储 | **MySQL**，课文与生字支持后台录入 | 前端持久化逻辑重写为 API 驱动；**必须做定时备份**（见 §4、§8.3） |
| 访问安全 | 仅内网，不鉴权 | 保留 `auth.enabled` 开关默认关闭；禁止在路由器做端口映射 |

## 2. 现状盘点（基于代码实测）

| 项 | 现状 | 拆分后归属 |
|---|---|---|
| 页面结构 | 5 个 view：home / math / chinese / story / wrong | 前端 Vue 路由（视图不变） |
| 状态 | 全局 `S` + 8 个 localStorage key | Pinia + MySQL（API 驱动） |
| 大模型调用 | **3 处 fetch**：童话生成（60s 超时）、手写判卷（45s）、测试连接（20s） | 全部移到后端 |
| API 密钥 | 存浏览器 localStorage，随页面下发 | **移到 `config.yaml`，前端不再持有** |
| 语音 | 浏览器 `speechSynthesis`（rate 0.72 / zh-CN），4 个使用点 | 后端 Edge TTS，返回 mp3 |
| 拼音 | `pinyin-pro@3.29.4` 走 unpkg CDN，4 个使用点 | 改为 npm 依赖打包进前端，**去掉 CDN** |
| 生字表 | 14 篇课文硬编码在 HTML | 进 MySQL，家长后台可增改 |
| 手写板 | 双层 Canvas，**已用 Pointer Events**（触屏可用） | 组件化 + 触摸专项优化，改批量提交 |
| 日志 | 前端 `dbg()` / `apiFetch()` / `runDiagnostics()`，存在内存 | 后端 pino，前端只留只读诊断 |
| 装饰特效 | 彩带 Canvas、AudioContext 音效 | 保持不变 |

**已有资产**：口算 / 听写 / 错题 / 计时 / 进度条 / 日志的静态自检与浏览器冒烟测试脚本（约 130 项断言），阶段 2 改选择器即可复用。

## 3. 目标架构

```
┌──────────────────────────────────────────────────────┐
│  平板 / PC 浏览器（Vue 3 + Vite SPA）                 │
│  · 五个功能页 + 手写板 + 音频播放                      │
│  · 家长内容后台（独立路由 /admin）                     │
│  · 不持有任何密钥                                      │
└───────────────────────┬──────────────────────────────┘
                        │ HTTP · JSON（内网）
┌───────────────────────▼──────────────────────────────┐
│  Nginx（可选）· 静态资源 · /api 反向代理               │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│  Node + Express（BFF）                                │
│  config.yaml → baseUrl / apiKey / 模型 / 音色 / 超时   │
│  路由：                                               │
│   POST /api/story/generate   童话生成（文本）          │
│   POST /api/mark             听写批量判卷（多模态）    │
│   GET  /api/mark/:id         判卷任务查询              │
│   POST /api/mark/:id/review  家长改判                  │
│   GET  /api/tts              文字转语音（带缓存）      │
│   GET  /api/lessons          课文 + 生字 + 组词        │
│   /api/admin/lessons*        课文生字录入 CRUD         │
│   GET  /api/state            学习数据读写              │
│   GET  /api/backup           全量备份导出              │
│   GET  /api/diag/logs        最近日志（只读）          │
│   ┌──────────┬──────────┬──────────┬───────────────┐ │
│   │ LLM 客户端│ TTS 抽象层│ 磁盘缓存  │ pino 日志     │ │
│   │ 超时/重试 │ Edge 实现 │ mp3 复用  │ 按天轮转      │ │
│   │ 错误分类 │          │ hash 寻址 │ 密钥脱敏      │ │
│   └──────────┴──────────┴──────────┴───────────────┘ │
└───────┬──────────────────────┬───────────────────────┘
        │                      │
   ┌────▼────┐            ┌────▼─────────┐        ┌──────────────┐
   │ LLM API │            │ TTS 引擎     │        │ MySQL        │
   │ 文本/视觉│            │ Edge（联网） │        │ 内容 + 学习数据│
   └─────────┘            └──────────────┘        └──────────────┘
```

**注意内网的隐含前提**：服务器必须能出公网（家庭宽带即可），因为 Edge TTS 和 LLM 都是外部服务。平板只需能访问服务器，不需要公网。

## 4. 数据模型（MySQL）

按「内容」与「学习数据」两块划分。`child` 维度先只放一行，但字段保留，将来加二宝不用改表。

```sql
-- 内容：课文与生字
lessons      (id, title, unit, sort_no, note, created_at, updated_at)
lesson_chars (id, lesson_id, ch, word, pinyin, sort_no, hidden, created_at)
             UNIQUE(lesson_id, sort_no)

-- 主体（先单孩）
children     (id, name, created_at)

-- 学习数据
daily_progress (child_id, date, task_key, done, updated_at)  PK(child_id,date,task_key)
math_sets      (id, child_id, date, questions JSON, results JSON, created_at)
mastery        (child_id, lesson_id, ch, state, updated_at)  PK(child_id,lesson_id,ch)
wrong_items    (id, child_id, type ENUM('math','chinese'), ref_key, payload JSON,
                created_at, cleared_at)
stories        (id, child_id, title, text, created_at)
read_titles    (child_id, title, created_at)  PK(child_id,title)

-- 判卷留痕（也用于后续调优 Prompt）
mark_tasks  (id, child_id, lesson_id, status, degraded, items JSON, created_at, finished_at)
mark_items  (id, task_id, idx, target, correct, written, score, comment, reviewed_by)
```

**字段说明（几个关键点）**

- `lesson_chars.word`：**组词字段，TTS 消歧必需**。二年级听写真正的难点不是多音字（「发」读 fā 还是 fà，写出来都是「发」），而是**音近字混淆**（睛/晴、洋/阳、铜/同）。听写时先读词再读字（"眼睛……睛"），用语境消歧。这 14 篇的组词需要补录，后台要提供便利录入方式（见 §5）。
- `lesson_chars.pinyin`：**录入时自动生成**，后端用 pinyin-pro 注音，家长不用手填。
- `read_titles`：从原来的 localStorage 数组变成表，多设备共享「读过不再重复」。
- `math_sets.questions` 用 JSON 列：题目结构简单、不需要按题查询，避免过度拆表。

**老数据迁移**：现有页面有「导出 JSON」功能。写一个一次性导入接口 `POST /api/restore`，把导出的 JSON 灌进 MySQL，孩子已积累的进度、错题、故事历史全部保留。

## 5. 家长内容后台（新增模块）

你说「课本和生字后续也要支持后台录入新的篇章进去」，这是新增范围，但值得做——把内容从代码里解放出来。

**入口**：同一个 Vue 应用里的独立路由 `/admin`，与孩子界面完全分开（孩子不需要看到）。因为内网不鉴权，用「不告诉孩子网址」这种朴素隔离即可；如果将来要上公网，再加 `auth.enabled: true`。

**能力**

1. **课文管理**：列表 / 新增 / 编辑 / 删除 / 排序调整；字段 `title`、`unit`、`sort_no`
2. **生字录入 —— 批量粘贴为主入口**
   - 直接粘贴一行字：「两 哪 宽 顶 眼 睛 肚 皮 孩 跳」
   - 后端自动拆字、去重、调 pinyin-pro 注音、按顺序生成行
   - 家长只需补每行的「组词」——这是唯一必须人工的部分
3. **组词辅助**：每行给一个「AI 生成候选」按钮，调 LLM 返回 3 个贴合课文语境的候选词，家长点选即可。一次请求生成整篇的候选，省 token
4. **保存后自动预热 TTS**：异步触发该课所有生字的「组词 + 单字」音频合成，写进缓存。下次孩子听写直接命中缓存，零延迟
5. **TTS 缓存管理**：查看缓存数量与体积、清空、重新生成
6. **数据备份**：一键导出全量 JSON、查看最近备份时间

**顺手能做的增强**：现有生字表数据从 HTML 抽出时，顺便用 AI 补齐 14 篇的组词字段，一次性做完，孩子马上能用到消歧朗读。

## 6. 接口契约（草案）

```
GET  /api/health
     → { ok, version, uptime, config: { llmModel, markModel, ttsProvider, ttsVoice, keyMasked } }

GET  /api/lessons                       → [{ id, title, unit, chars: [{ ch, word, pinyin }] }]
POST /api/admin/lessons                 → { id }          # 新建课文
PUT  /api/admin/lessons/:id             → { ok }          # 改标题/单元/排序
DELETE /api/admin/lessons/:id           → { ok }
POST /api/admin/lessons/:id/chars/bulk  → { added, rows }
     body { text: "两 哪 宽 顶 眼 睛" }                   # 批量粘贴 → 自动拆字注音
POST /api/admin/lessons/:id/words/suggest → { cands: { 两: ["两个","两旁"], ... } }
POST /api/admin/lessons/:id/prewarm      → { taskId }     # 异步预热音频

POST /api/story/generate   body { avoidTitles } → { id, title, text }

GET  /api/tts?text=眼睛&type=word        → audio/mpeg      （X-TTS-Cache: HIT|MISS）

POST /api/mark
     body { lessonId, mode: "composite"|"each",
            items: [{ index, target, image: "data:image/png;base64,..." }] }
     → { taskId }
GET  /api/mark/:taskId
     → { status: "pending|running|done|failed", degraded,
         items: [{ index, target, correct, written, score, comment, reviewedBy }], error? }
POST /api/mark/:taskId/review  body { items: [{ index, correct }] } → { ok }

GET  /api/state?date=2026-09-12  → { daily, mastery, wrong, stories, timer, mathSet }
PATCH /api/state                 → { ok }        # 增量写入
GET  /api/backup                 → 全量 JSON 下载
POST /api/restore                → 从 JSON 恢复

GET  /api/diag/logs?limit=100    → [{ ts, level, tag, msg, detail }]
```

**配置文件草案**

```yaml
server:
  port: 8788
  host: 0.0.0.0
  auth: { enabled: false, childPin: "", parentPin: "", sessionDays: 30 }

db:
  host: 127.0.0.1
  port: 3306
  database: grade2
  user: grade2
  password: ${DB_PASSWORD}

llm:
  baseUrl: https://api.deepseek.com/v1     # 内网走家庭宽带，建议国内厂商
  apiKey: ${LLM_API_KEY}                   # 环境变量注入，不进 git
  storyModel: deepseek-chat
  markModel: qwen-vl-max                   # 必须支持视觉
  timeoutMs: { story: 60000, mark: 90000 }
  retries: 1

tts:
  provider: edge                           # edge | aliyun | tencent | local
  voice: zh-CN-XiaoyiNeural
  rate: "-10%"
  cacheDir: ./data/tts
  cacheMaxMB: 512

logging:
  level: info
  dir: ./logs
  keepDays: 14
  redact: [apiKey, password, authorization]

backup:
  enabled: true
  cron: "0 3 * * *"                        # 每天凌晨 3 点
  dir: ./data/backup
  keepDays: 30
```

## 7. 目录结构

```
grade2/
├── web/                          # 前端
│   ├── src/
│   │   ├── views/                # Home Math Chinese Story Wrong
│   │   ├── admin/                # 家长内容后台（LessonList LessonEdit CharBulkImport）
│   │   ├── components/           # TodayPanel StatusBar HandBoard StoryReader
│   │   │                         # AudioBar WrongBook DiagDrawer
│   │   ├── composables/          # useHandCanvas useAudio useApi
│   │   ├── stores/               # Pinia（daily / math / mastery / wrong / stories）
│   │   ├── styles/macaron.css    # 现有 CSS 变量与马卡龙配色整体迁移
│   │   └── api/                  # 后端接口封装
│   ├── public/manifest.webmanifest
│   └── vite.config.ts            # dev proxy: /api → :8788
├── server/
│   ├── src/
│   │   ├── index.ts  config.ts  logger.ts
│   │   ├── db/                   # 连接池 + 迁移脚本 + 仓储层
│   │   ├── routes/               # story mark tts lessons admin state backup diag
│   │   ├── services/
│   │   │   ├── llm.ts            # OpenAI 兼容客户端
│   │   │   ├── prompts/          # storyPrompt.ts markPrompt.ts wordSuggest.ts
│   │   │   ├── tts/              # index.ts edge.ts cache.ts prewarm.ts
│   │   │   └── backup.ts
│   │   └── seed/lessons.ts       # 14 篇课文 + 生字 + 组词（初始化数据）
│   ├── config/config.yaml
│   ├── data/tts/  data/backup/  logs/
│   └── package.json
├── deploy/
│   ├── docker-compose.yml        # node + mysql
│   ├── Dockerfile
│   └── nginx.conf                # 可选
└── docs/refactor-plan.md
```

保留 `grade2-workbench.html` **原地不动**，作为回退方案与新旧对照基线，也用于导出老数据。

## 8. 内网部署的工程要点

### 8.1 没有 HTTPS → 装不了 PWA（取舍已定）

内网 HTTP 环境下：

| 能力 | 内网 HTTP | 需要 HTTPS |
|---|---|---|
| 平板浏览器打开使用 | ✅ 正常 | — |
| 音频播放（后端 TTS） | ✅ 正常 | — |
| 手写板 | ✅ 正常 | — |
| iOS「添加到主屏幕」 | ⚠️ 可加，但是书签形态，**非全屏** | 完全 standalone |
| Android Chrome 安装 PWA | ❌ 不支持（需安全上下文） | 需要 |

**两个选项**：

- **A（省事，推荐先这样）**：接受书签形态。平板浏览器收藏网址即可用，只是顶部有地址栏
- **B（要全屏时再做）**：用 `mkcert` 生成自签证书，在平板上安装一次根证书。之后走 HTTPS，PWA 生效、可全屏

先把 A 跑通，孩子真觉得地址栏碍事再上 B。清单里仍保留 `manifest.webmanifest`，成本很低。

### 8.2 服务器与网络

- **机器**：一台旧笔记本 / NUC / 树莓派 4B 及以上就够。Node + MySQL 常驻约 300-500MB 内存，TTS 走 Edge 不需要 GPU
- **系统**：建议 Ubuntu Server + Docker（Windows 也可，用 Docker Desktop 或 WSL2）
- **固定内网 IP**：在路由器给服务器做 DHCP 静态绑定，平板收藏的网址才长期有效
- **禁止端口映射**：不要在路由器上把 8788/3306 映射到公网。不鉴权的前提就是「不暴露公网」
- **开机自启**：`docker compose` 里 `restart: always`，断电恢复后自动可用

### 8.3 备份（必需，不是可选项）

数据从浏览器搬进 MySQL 后，**服务器故障 = 全部学习记录丢失**（以前浏览器里至少还有一份）。所以：

- 服务内置每日 `mysqldump`（`backup.cron`），保留 30 天
- 备份目录建议挂到服务器之外的介质（NAS / 移动硬盘 / 云盘同步目录）
- 家长后台提供「一键导出全量 JSON」，重要节点手动留一份

## 9. 平板专项工程要点

### 9.1 音频自动播放被拦（最容易翻车的坑）

iOS Safari 和部分 Android 浏览器禁止无用户手势的音频播放。从 Web Speech 换成 `<audio>` 后：

- **解锁时机**：首次任意点击时，用一个隐藏 `<audio>` 播放 0.05s 静音 mp3 完成解锁，之后程序化播放不受限
- **不要 `await fetch` 后再 `play()`**：异步之后已脱离用户手势调用栈，iOS 会拒绝
- **连续朗读（顺次读生字）**：用同一个 `<audio>` 元素的 `ended` 事件串行推进，**不要用 `setInterval`**（现有实现是 1.5s 定时器，必须改）
- **预加载**：进入语文页时把该课生字音频批量拉成 Blob URL 缓存，点击即播、无网络抖动

### 9.2 手写板触摸体验

现有实现已用 Pointer Events，需补：

- `touch-action: none` + `user-select: none`：否则写字时页面跟着滚动
- 横竖屏旋转：重建画布并**保留已有笔迹**（笔迹已存为坐标数组，重绘即可）
- 抬笔即定型，避免手指离开瞬间的抖动笔画
- 确认 DPR 缩放下的坐标换算正确

### 9.3 故事朗读设计

不要整篇合成一个 mp3 从头播到底——**按句切分**（以 `。！？\n` 为界），每句一个音频，前端串行播放并**高亮当前句**。好处：孩子能跟着高亮跟读，逐句可重听，缓存放到了句子粒度。

## 10. 听写改批量提交（你提出的核心改动）

```
① 一轮 N 个字（N ≤ 8，取课文生字表前 N 个）
② 逐字写：每字笔迹单独保存，不提交
③ 全部写完 → [ 一起交给 AI 批改 ]  [ 交给大人审核 ]
④ AI 批改：前端把 N 个字的笔迹拼成一张带序号的网格图
   → 后端一次多模态请求 → 校验返回数量与序号
   → 不符则自动降级为逐字判卷
⑤ 逐字展示「目标字 / 孩子的字 / 判定 / 评语」，家长可逐字改判
⑥ 结果写入掌握度与错字本（沿用现有逻辑）
```

**为什么拼成一张图**：8 个字逐字判 = 8 次多模态请求，拼图后 = 1 次。**成本差 8 倍**，延迟也从 8×5s 降到 1×8s。

**判卷走异步任务**：`POST /api/mark` 立即返回 `taskId`，前端 1.5s 轮询 `GET /api/mark/:taskId`。避免 20-40s 同步阻塞，中途刷新页面任务不丢，失败可重试。

**判卷模型必须支持视觉**，所以 `markModel` 与 `storyModel` 分开配置。`deepseek-chat` 这类纯文本模型不能用于判卷。

## 11. 分阶段任务拆分与验收标准

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **0. 骨架**<br>约 0.5 天 | web/server 初始化；docker-compose 起 MySQL；迁移脚本；`/api/health`；Vite dev proxy | `docker compose up` + `pnpm dev` 双起，浏览器能拿到 health 且连上 MySQL |
| **1. 后端核心**<br>约 2 天 | ① config + zod 校验 + pino 日志 + reqId<br>② DB schema + 仓储层 + 14 篇课文种子数据（含组词）<br>③ LLM 客户端（超时/重试/错误分类）+ 童话生成<br>④ TTS Provider + Edge 实现 + 磁盘缓存 + 预热脚本<br>⑤ 批量判卷（拼图 → 校验 → 降级逐字）+ 异步任务<br>⑥ state / backup / diag 接口 | curl 全通；日志能读出每次调用的模型/耗时/状态；<br>**生字音频抽听 20 个确认无错读**；<br>批量判卷在 mock 下 6 种失败场景分类正确 |
| **2. 前端迁移**<br>约 2.5 天 | ① CSS 与视觉整体迁移，5 个视图路由化<br>② 数据层从 localStorage 改 API 驱动（Pinia + 乐观更新）<br>③ 手写板组件化 + 触摸专项<br>④ **听写改批量提交** + 家长改判<br>⑤ 音频层（解锁 / 预加载 / 串行 / 逐句高亮）<br>⑥ 拼音改 npm 本地依赖，删 CDN<br>⑦ 删配置面板，留只读诊断抽屉 | **复用现有冒烟测试脚本**（改选择器）全绿；<br>老数据经 `/api/restore` 导入后进度完整 |
| **3. 家长内容后台**<br>约 1 天 | 课文 CRUD；批量粘贴生字 → 自动拆字注音；AI 生成组词候选；保存后异步预热 TTS；缓存与备份管理 | 能完整录一篇新课文（含组词），保存后音频自动生成，<br>孩子在听写页能立即选中并正确朗读 |
| **4. 部署验收**<br>约 0.5 天 | Docker 化、内网固定 IP、定时备份、平板实机 | iPad Safari + Android Chrome 走完整流程；<br>断电重启后服务自动恢复；备份文件生成成功 |
| **5.（可选）** | 家长周报、学习趋势图、多孩支持 | — |

**阶段顺序建议**：0 → 1 → 2 是主干，跑通后孩子的日常使用就恢复了。阶段 3 内容后台可以往后放，先用种子数据里的 14 篇课文顶着。

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **MySQL 集中存储后服务器故障** | 全部学习记录丢失 | 每日 mysqldump + 保留 30 天 + 备份到服务器之外的介质 + 手动导出入口 |
| 无 HTTPS | 无法安装 PWA，部分浏览器 API 受限 | 先接受书签形态；需要全屏时用 mkcert 自签证书（§8.1） |
| 无鉴权 + 家庭 Wi-Fi | 同网设备可访问接口 | 禁止路由器端口映射；保留 `auth.enabled` 开关；内网固定 IP |
| 家庭宽带访问境外 LLM 不稳定 | 判卷/生成失败 | 用国内模型（DeepSeek / 通义 / 智谱）；后端超时放宽 + 重试 |
| Edge TTS 接口变动或被限 | 语音全挂 | Provider 抽象层 + 磁盘缓存（已生成的仍可用）+ 可切云厂商 |
| 批量判卷序号错位 | 判错字 | 长度 + 序号连续性校验，不符自动降级逐字；Prompt 强调序号对应 |
| 内容录入工作量大 | 后台用不起来 | 批量粘贴 + 自动注音 + AI 生成组词候选（组词是唯一必须人工的部分） |
| 音频自动播放被 iOS 拦 | 点朗读没声 | 手势解锁 + 预加载 Blob（§9.1） |
| 迁移期间功能回退 | 无法使用 | 保留单文件 HTML 作为回退，双轨并行至新版验收通过 |

## 13. 成本估算

因为部署在家庭内网，**服务器成本为 0**（用现有旧电脑，最多算点电费）。

| 项 | 估算 |
|---|---|
| 服务器 / MySQL | **¥0**（复用旧设备） |
| TTS（Edge） | **¥0** |
| 判卷（批量 1 次/轮 × 2 轮/天，gpt-4o-mini 级） | ≈ **¥0.7/月** |
| 童话生成（600 字/天，deepseek-chat） | ≈ **¥1/月** |
| **合计** | **不到 ¥2/月** |

## 14. 明确不做的事

- 不做用户注册与登录体系（内网不鉴权；将来上公网再开 `auth.enabled`）
- 不做教师端 / 多班级管理（后台只管内容，不管学生）
- 不做视频、大文件存储
- 不做浏览器推送（「打开就看见」的置顶区已等价于提醒）
- 不做 PWA 离线缓存（C 内网不会断网，离线队列是无谓复杂度）
- 不引入 UI 组件库（继续手写 CSS，保持现有马卡龙风格与内联 SVG 图标规范）
