# 面试系统单后端 + 前端静态资源,部署到 Railway/Fly 等常驻 VPS。
# better-sqlite3 是原生模块,需要编译工具链。
FROM node:22-bookworm-slim AS build
WORKDIR /app

# 原生模块编译依赖(better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
# 构建前端(admin/public 静态资源 -> dist/)
RUN npm run build

# ── 运行镜像 ──
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production SERVE_STATIC=1 HOST=0.0.0.0

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server
COPY tsconfig.server.json ./

# SQLite 数据库 + 备份目录(挂持久卷)
VOLUME ["/app/data", "/app/backups"]
ENV DATABASE_PATH=/app/data/interview.db BACKUP_DIR=/app/backups
EXPOSE 8787

# tsx 直接跑 TS 后端(无需额外构建步骤)
CMD ["npx", "tsx", "server/index.ts"]
