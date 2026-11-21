# syntax=docker/dockerfile:1
# AIO 一键体验镜像（评审/演示用）：单镜像自带前端构建产物 + 迁移 + 演示数据。
# 只跑 AIO 本身；3D 世界（aio-world，GPL fork）刻意不打进这个镜像——两棵树零代码合并。

# ---------- 1) 前端构建（tsc + vite） ----------
FROM node:22-bookworm-slim AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- 2) 运行时 ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 生产依赖（含 sharp：缩略图/世界快照都要它）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY sql ./sql
COPY scripts ./scripts
COPY examples ./examples
COPY --from=web /build/web/dist ./web/dist
COPY docker/entrypoint.sh /usr/local/bin/aio-entrypoint

# 媒体目录独立挂卷；以 node 用户跑，别用 root
RUN chmod +x /usr/local/bin/aio-entrypoint \
 && mkdir -p /data/media \
 && chown -R node:node /app /data
USER node

EXPOSE 8787
ENTRYPOINT ["aio-entrypoint"]
