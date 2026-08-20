FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY captcha/node_harness/package.json ./captcha/node_harness/package.json
RUN npm ci \
  && cd captcha/node_harness && npm install --no-package-lock \
  && cd /app
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime

ARG VERSION=1.2.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="yuque-web-mcp" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/n1ngPh/yuque-web-mcp"

ENV NODE_ENV=production \
    HOME=/tmp/home \
    CHROMIUM_EXECUTABLE=/usr/bin/chromium \
    CAPTCHA_PYTHON_PATH=/opt/captcha-venv/bin/python \
    CAPTCHA_BROWSER_PATH=/usr/bin/chromium
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-noto-cjk \
    python3 python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -o node -g node -m 0700 /data
# Package managers are build-time tooling. Excluding them from the runtime image
# removes an unnecessary mutation surface and their transitive vulnerability set.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /opt/yarn-v1.22.22 \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx
# Dedicated venv for the DrissionPage captcha sidecar (SMS login). pip is a
# build-time tool, so it is removed from the venv once the dependency is pinned.
RUN python3 -m venv /opt/captcha-venv \
  && /opt/captcha-venv/bin/pip install --no-cache-dir DrissionPage==4.1.1.2 \
  && rm -rf /opt/captcha-venv/lib/python3*/site-packages/pip* \
            /opt/captcha-venv/lib/python3*/site-packages/setuptools* \
            /opt/captcha-venv/lib/python3*/site-packages/pkg_resources \
            /opt/captcha-venv/lib/python3*/site-packages/wheel*
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node contracts ./contracts
COPY --chown=node:node deploy/lake-runtime.mjs ./deploy/lake-runtime.mjs
COPY --from=build --chown=node:node /app/captcha ./captcha

USER node
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
