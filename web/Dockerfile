ARG NODE_VERSION=20-alpine

# 1. deps — install full dep tree for the build stage.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# 2. builder — produce the standalone bundle.
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_TCP_EXECUTION=server
ENV NEXT_PUBLIC_TCP_EXECUTION=${NEXT_PUBLIC_TCP_EXECUTION}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN yarn build

# 3. runner — minimal image with just the standalone output.
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=9999
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Public assets and static chunks are not included in the standalone output;
# copy them in alongside server.js.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/template ./template
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 9999

CMD ["node", "server.js"]
