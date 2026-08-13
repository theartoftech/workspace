FROM node:24.16.0-alpine3.24@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a AS build

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY web ./web
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.31.3-alpine3.24@sha256:334d92979f15aaecd5dd50af5105e1230e2bb70765d45b1e2f964e7c5eda81c3 AS runtime

ARG PORTAL_BUILD_REVISION=development

LABEL org.opencontainers.image.title="Workspace Monitor Portal" \
      org.opencontainers.image.description="Fixture-backed enterprise monitoring portal" \
      org.opencontainers.image.revision="${PORTAL_BUILD_REVISION}"

COPY deploy/portal/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=101:101 /workspace/dist /usr/share/nginx/html

USER 101:101
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD wget -qO- http://127.0.0.1:8080/healthz | grep -q '^healthy$'
