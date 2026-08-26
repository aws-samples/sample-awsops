# Stage 1: build Next.js standalone output
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --prefer-offline --no-audit || npm install
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Stage 2: minimal runtime
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# deploy.mjs가 빌드 전 저장소 루트에서 복사해 둔 변경 이력 — /api/changelog가 런타임에 읽음
COPY --from=builder --chown=nextjs:nodejs /app/CHANGELOG.md ./CHANGELOG.md
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
