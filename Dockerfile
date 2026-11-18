# syntax=docker/dockerfile:1
# SPEC-014: multi-stage image on the official Playwright image (browsers + OS deps preinstalled). Runs as the non-root
# `pwuser`. Credentials, API tokens and data are NEVER copied in: mount them at runtime (see docker-compose.yml).
# Keep PLAYWRIGHT_VERSION equal to the `playwright` dependency in package.json (a test enforces this).
ARG PLAYWRIGHT_VERSION=1.65.0
ARG PNPM_VERSION=10.33.0

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS base
ARG PNPM_VERSION
ENV CI=true
# corepack is not bundled with the image's Node; install the pinned pnpm (build stages only, not in the runtime image)
RUN npm install -g pnpm@${PNPM_VERSION} && pnpm --version
WORKDIR /src

# --- build: full deps, compile server/CLI (dist/) and the web UI (web/dist/)
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY bin ./bin
COPY src ./src
COPY web ./web
RUN pnpm build

# --- prod-deps: runtime dependencies only
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# --- runtime
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS runtime
ENV NODE_ENV=production \
    AGENTIC_E2E_DATA_DIR=/app/data \
    PORT=4173
WORKDIR /app
COPY --from=prod-deps --chown=pwuser:pwuser /src/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /src/package.json ./package.json
COPY --from=build --chown=pwuser:pwuser /src/bin ./bin
COPY --from=build --chown=pwuser:pwuser /src/dist ./dist
COPY --from=build --chown=pwuser:pwuser /src/web/dist ./web/dist
RUN mkdir -p /app/data && chown pwuser:pwuser /app/data
USER pwuser
VOLUME ["/app/data"]
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "bin/agentic-e2e.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "4173"]
