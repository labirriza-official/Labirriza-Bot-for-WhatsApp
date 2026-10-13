FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data TZ=America/Mexico_City
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "src/server.js"]
