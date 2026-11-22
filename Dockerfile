FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY dashboard/ ./dashboard/

# State file and logs live in a mounted volume
VOLUME ["/app/data"]

ENV NODE_ENV=production

CMD ["node", "src/bot.js"]
