# Claudia Local in a container. Data lives in the /data volume; the port is published on the host's
# 127.0.0.1 only (see compose.yaml). Build: docker build -t claudia-local .
#   docker run --rm -p 127.0.0.1:3939:3939 -v claudia-local-data:/data claudia-local

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production \
    CLAUDIA_LOCAL_HOME=/data \
    CLAUDIA_LOCAL_PORT=3939 \
    CLAUDIA_LOCAL_DOCKER=1 \
    CLAUDIA_LOCAL_HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dashboard/dist ./dashboard/dist
COPY server ./server
COPY bin ./bin
COPY README.md LICENSE CHANGELOG.md SECURITY.md ./
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 3939
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3939/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
