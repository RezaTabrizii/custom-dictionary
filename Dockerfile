FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY lexicon ./lexicon
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "src/server.js"]
