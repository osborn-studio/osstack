FROM node:20-slim

WORKDIR /app

# 安装 pnpm
RUN corepack enable pnpm

# 复制 package 文件
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages

# 安装依赖（使用 npmjs.org）
RUN pnpm install --frozen-lockfile

# 构建
RUN pnpm build

# 暴露端口
EXPOSE 3000

CMD ["node", "packages/cli/dist/bin.js", "serve"]
