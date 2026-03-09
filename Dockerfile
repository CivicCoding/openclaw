# Stage 1: Base image with system dependencies
FROM node:22-bookworm AS base

# 安装 Bun
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates     && rm -rf /var/lib/apt/lists/*     && curl -fsSL <https://bun.sh/install> | bash     && mv /root/.bun/bin/bun /usr/local/bin/bun     && ln -s /usr/local/bin/bun /usr/local/bin/bunx     && rm -rf /root/.bun

# 启用 corepack 以使用 pnpm
RUN corepack enable

# 可选安装额外 apt 包
ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then       apt-get update &&       DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES &&       apt-get clean &&       rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*;     fi

# Stage 2: Install dependencies
FROM base AS dependencies
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY skills ./skills
COPY packages ./packages
COPY extensions ./extensions

RUN --mount=type=cache,target=/root/.local/share/pnpm/store     pnpm install --frozen-lockfile

# Stage 3: Build application
FROM dependencies AS builder

COPY scripts ./scripts
COPY . .

RUN pnpm build

ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

# Stage 4: Production image
FROM base AS production
WORKDIR /app

ENV NODE_ENV=production
ENV OPENCLAW_HOME=/root/.openclaw

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/ui/node_modules ./ui/node_modules
COPY --from=dependencies /app/extensions ./extensions
COPY --from=dependencies /app/packages ./packages

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/openclaw.mjs ./openclaw.mjs
COPY --from=builder /app/package.json ./package.json
COPY docs ./docs
COPY --from=dependencies /app/skills ./skills

RUN mkdir -p /root/.openclaw

EXPOSE 18789 18790

HEALTHCHECK --interval=3m --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
