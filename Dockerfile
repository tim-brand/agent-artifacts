# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# ---- deps ----------------------------------------------------------------
FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS deps
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:${PATH}" \
    CI=1
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack install && pnpm install --frozen-lockfile --prod

# ---- runtime -------------------------------------------------------------
# No build step: Node 24 runs the TypeScript in src/ directly, by stripping the types.
FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app

# Named paths only, so nothing else in the build context can reach the image. .dockerignore keeps
# the *.test.ts files in src/ out. The code stays owned by root, so the app can't change it.
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src

# The artifact store, the only place the app writes. In the cluster a volume is mounted here; a new
# named volume copies this ownership. The `node` user comes with the base image.
RUN mkdir /data && chown node:node /data

USER node
EXPOSE 3000

CMD ["node", "src/server.ts"]
