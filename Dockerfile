ARG BUN_VERSION=1.4.0

FROM oven/bun:${BUN_VERSION} AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION} AS runtime
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git ripgrep tini jq python3 file unzip zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    DATABASE_URL=sqlite:///app/workspace/clanker.sqlite \
    PI_CODING_AGENT_DIR=/app/workspace/pi

COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
# Pi installs configured packages on first session initialization.
COPY --chown=bun:bun docker/pi/ ./.pi/
COPY --chown=bun:bun package.json bun.lock tsconfig.json AGENTS.md LICENSE ./
COPY --chown=bun:bun .agents ./.agents
COPY --chown=bun:bun src ./src

RUN mkdir -p /app/workspace/pi && chown bun:bun /app /app/workspace /app/workspace/pi
USER bun

# Persist SQLite, attachments, session snapshots, and Pi credentials/configuration.
# Pass Discord/model credentials at runtime, for example with --env-file.
VOLUME ["/app/workspace"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "src/index.ts"]
