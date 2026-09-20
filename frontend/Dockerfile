# GridShift dashboard.
#
# Build context is the REPOSITORY ROOT, same as the backend's, so one compose
# file can build both:
#
#   docker build -f frontend/Dockerfile -t gridshift-frontend .
#
# NEXT_PUBLIC_* is inlined at build time, not read at run time, so the API URL
# has to be a build argument. It is also the URL the BROWSER will use, not one
# resolved inside the compose network: the fetch happens on the viewer's
# machine, so a compose service name like http://backend:8000 would be a host
# their browser cannot resolve. Leave it pointing at the published port.
#
#   docker build -f frontend/Dockerfile -t gridshift-frontend \
#     --build-arg NEXT_PUBLIC_API_BASE_URL=http://localhost:8001 .

FROM node:22-alpine AS deps
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
# `npm ci` needs the lockfile; fall back for a checkout that has none rather
# than failing the build outright.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY frontend/ ./

ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8001
ARG NEXT_PUBLIC_USE_MOCK=partial
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    NEXT_PUBLIC_USE_MOCK=$NEXT_PUBLIC_USE_MOCK

# A .env.local committed by a developer would override the build args above and
# bake someone's laptop port into the image. Drop it before building.
RUN rm -f .env.local .env.development.local && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Nothing here writes to disk; the server only needs to read its own bundle.
RUN addgroup -g 10001 -S gridshift && adduser -u 10001 -S gridshift -G gridshift

# `output: 'standalone'` in next.config.ts puts the server and the node_modules
# it actually reaches under .next/standalone. static/ and public/ are not
# included in it and have to be copied alongside, or every asset 404s.
COPY --from=build --chown=gridshift:gridshift /app/.next/standalone ./
COPY --from=build --chown=gridshift:gridshift /app/.next/static ./.next/static
COPY --from=build --chown=gridshift:gridshift /app/public ./public

USER gridshift
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3000',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
