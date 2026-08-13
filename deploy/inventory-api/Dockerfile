FROM node:24.16.0-alpine3.24@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a AS build

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.server.json ./
COPY shared ./shared
COPY server ./server
RUN npm run build:server

FROM node:24.16.0-alpine3.24@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a AS runtime

ARG PORTAL_BUILD_REVISION=development

LABEL org.opencontainers.image.title="Workspace Monitor Inventory API" \
      org.opencontainers.image.description="Read-only live deployment inventory aggregator" \
      org.opencontainers.image.revision="${PORTAL_BUILD_REVISION}"

RUN addgroup -S -g 10001 inventory && adduser -S -D -H -u 10001 -G inventory inventory

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /workspace/dist-server/server/src ./server/src
COPY --from=build /workspace/dist-server/server/package.json ./server/package.json
COPY --from=build /workspace/dist-server/shared ./shared
COPY catalog ./catalog

USER 10001:10001
EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/src/main.js"]
