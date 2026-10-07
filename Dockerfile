ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION} AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION} AS runtime
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production SECRETS_DIR=/app/secrets
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock LICENSE ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun tsconfig.json .
RUN mkdir -p /app/workspace /app/secrets \
    && chown bun:bun /app/workspace /app/secrets \
    && chmod 700 /app/secrets
USER bun

VOLUME ["/app/workspace", "/app/secrets"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "start"]
