# Public amem shop (Stripe Checkout → signed license). Not part of the CLI image.
FROM node:20-bookworm-slim

WORKDIR /app

COPY shop/package.json shop/package-lock.json ./shop/
RUN cd shop && npm ci --omit=dev

COPY shop/*.mjs ./shop/
COPY shop/public ./shop/public
# Signing only needs these two compiled modules (no native sqlite).
COPY dist/license.js dist/paths.js ./dist/

ENV NODE_ENV=production
ENV AMEM_SHOP_HOST=0.0.0.0
ENV AMEM_SHOP_PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "shop/server.mjs"]
