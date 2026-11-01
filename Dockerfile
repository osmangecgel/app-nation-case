FROM node:24.22.2-alpine AS source
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# postinstall runs prisma generate, so the schema must be in place first.
RUN npm ci
COPY . .

# The test suite: the source with the development packages (Vitest), run by the
# compose `test` service against the compose PostgreSQL and Redis. Never deployed.
FROM source AS test
# Vitest writes its config bundle to /app and its cache to node_modules/.vite.
RUN mkdir -p node_modules/.vite && chown node:node /app node_modules/.vite
# Keeps the test output to the tests: no "new npm version" notice.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
USER node
CMD ["sh", "-c", "npm test && npm run test:e2e"]

FROM source AS build
RUN npm run build && npm prune --omit=dev

# The verification flow (scripts/verify.sh), run by the compose `verify` service:
# the Docker command line, to stop the worker and read logs and memory, and curl.
# Never deployed; a plain `docker build` does not build it.
FROM node:24.22.2-alpine AS verify
RUN apk add --no-cache docker-cli docker-cli-compose curl
WORKDIR /project
ENTRYPOINT ["scripts/verify.sh"]

# The production image (the last stage, built by default): compiled code and
# production packages only.

FROM node:24.22.2-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./
# Prepared export files (EXPORT_FILES_DIR). docker-compose mounts a volume here,
# which takes this directory's owner, so the node user can write to it.
RUN mkdir -p /data/exports && chown node:node /data/exports
EXPOSE 13400
# The node image ships an unprivileged user; the app does not need root.
USER node
# Migrations are a separate step that runs before the app starts (DB-19):
# docker compose runs them in the migrate service with the same image.
CMD ["node", "dist/src/main"]
