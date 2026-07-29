FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY public ./public
COPY .env.example ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3010
ENV DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 3010
CMD ["node", "dist/main.js"]
