FROM node:24-alpine AS build
WORKDIR /app
COPY spec ./spec
COPY scripts ./scripts
COPY plugin/wp-mcp-bridge ./plugin/wp-mcp-bridge
COPY gateway/package.json gateway/package-lock.json ./gateway/
RUN cd gateway && npm ci
COPY gateway ./gateway
RUN cd gateway && npm run build

FROM node:24-alpine
ENV NODE_ENV=production WPMCP_DATA_DIR=/data PORT=8787
WORKDIR /app
COPY --from=build /app/gateway/dist ./dist
COPY --from=build /app/gateway/package.json ./package.json
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js", "serve"]
