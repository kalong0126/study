# =============================================================================
# 二年级快乐学习台 · 生产镜像（多阶段构建）
# -----------------------------------------------------------------------------
# 产物布局刻意与仓库保持一致，因为后端是用「相对路径」找前端与数据目录的：
#   /app/server/dist        后端编译产物（SERVER_ROOT = /app/server）
#   /app/server/node_modules 仅生产依赖
#   /app/server/config      config.yaml
#   /app/server/data        ← 数据库 / 语音缓存 / 备份（挂卷）
#   /app/server/logs        ← 日志（挂卷）
#   /app/web/dist           前端静态产物（后端自动托管，省一个 nginx）
#
# 构建（在仓库根目录执行）：
#   docker build -f deploy/Dockerfile -t grade2-app:1.0 .
# =============================================================================

# ---------------------------------------------------------------- 1. 前端
FROM node:22-bookworm-slim AS web-build
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------- 2. 后端
FROM node:22-bookworm-slim AS server-build
WORKDIR /build/server
# better-sqlite3 是原生模块：优先命中官方预编译包，命中不了就本地编译。
# 这一层在 COPY 之前，package.json 不变就永远 CACHED（0 秒）；万一缓存失效，
# 也先把 debian 源换成阿里云镜像（NAS 在国内访问 deb.debian.org 极慢，实测 100 秒+）。
# ca-certificates 不用装：node 基础镜像自带（npm 本身就依赖它）。
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' \
      /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY server/package*.json ./
RUN npm ci --no-audit --no-fund
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---------------------------------------------------------------- 3. 运行时
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai

# 这一阶段**不做任何 apt-get**：
#   · ca-certificates node 基础镜像自带；
#   · PID 1 信号转发交给 docker 内置的 docker-init（compose 里 init: true，零下载）。
#     以前在这里装 tini，就是为了干这件事 —— 国内访问 debian 源要 100 秒+，纯浪费。

WORKDIR /app/server

COPY --from=server-build /build/server/node_modules ./node_modules
COPY --from=server-build /build/server/dist         ./dist
COPY --from=server-build /build/server/package.json ./package.json
COPY server/config                                  ./config
COPY --from=web-build /build/web/dist               /app/web/dist

# 数据与日志必须落在卷上，否则重建容器就全没了
VOLUME ["/app/server/data", "/app/server/logs"]

EXPOSE 8788

# 不设 ENTRYPOINT：信号转发靠 compose 的 init: true（docker 内置 docker-init）。
# 若要脱离 compose 单独 docker run，请加 --init，例如：
#   docker run -d --init ... grade2-app:1.0
CMD ["node", "dist/index.js"]
