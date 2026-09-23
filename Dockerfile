# Image de production pour interfaces/web/server (API + webhook Telegram).
# Conteneur standard : portable vers n'importe quel hébergeur (Cloud Run,
# Railway, Fly, un VPS...), pas seulement Cloud Run.

FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY core ./core
COPY interfaces ./interfaces

ENV NODE_ENV=production
# Cloud Run fournit automatiquement la variable PORT (8080 par défaut) ;
# interfaces/web/server/index.js la lit déjà via process.env.PORT.
EXPOSE 8080

CMD ["node", "interfaces/web/server/index.js"]
