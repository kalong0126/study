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
# better-sqlite3 v13 用 N-API，npm 包里自带 linux-x64 预编译二进制，运行时直接
# 加载 —— 不需要 python3/make/g++，也**没有任何 apt-get**（国内访问 debian 源
# 要 100 秒+）。server/.npmrc 的 ignore-scripts=true 保证 npm 不会去编译它。
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
