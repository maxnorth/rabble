# Build stage: install the full workspace and build all packages
FROM node:22-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/e2e/package.json packages/e2e/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Runtime stage: production dependencies for the server only, plus built
# artifacts. The server serves the web build and migrates on boot.
FROM node:22-alpine
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/e2e/package.json packages/e2e/
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter @rabble/server...

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist

EXPOSE 3080
CMD ["sh", "-c", "node packages/server/dist/db/migrate.js && exec node packages/server/dist/index.js"]
