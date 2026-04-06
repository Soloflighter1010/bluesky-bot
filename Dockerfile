FROM node:20-alpine

# sharp needs these for image processing
RUN apk add --no-cache libc6-compat vips-dev python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/
COPY dashboard/ ./dashboard/

# State file and logs live in a mounted volume
VOLUME ["/app/data"]

ENV NODE_ENV=production

CMD ["node", "src/bot.js"]
