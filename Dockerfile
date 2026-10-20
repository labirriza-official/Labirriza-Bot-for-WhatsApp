FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data TZ=America/Mexico_City
# Herramientas por si better-sqlite3 necesita compilarse
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Los datos se guardan en /data: en Railway, conecta un Volume con mount path /data
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "src/server.js"]
