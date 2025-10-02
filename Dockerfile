FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=6832

# зависимости
COPY package*.json ./
RUN npm ci --omit=dev

# исходники
COPY server.js ./
COPY logger.js ./

# папка логов (logger.js сам создаст /logs при первом логировании; папку удобно смонтировать наружу)
RUN mkdir -p /app/logs

EXPOSE 6832
CMD ["node", "server.js"]
