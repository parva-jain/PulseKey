# One container: the buyer API, the contributor API and the web app, with the pool database on a volume at /data.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run web:build
ENV PGLITE_DIR=/data/pool
CMD ["npm", "start"]
