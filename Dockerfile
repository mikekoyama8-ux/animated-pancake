FROM node:20-alpine

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server.js fetch-rates.js backfill-history.js ./

# server.js is the default; docker-compose overrides `command` for the
# worker services to run fetch-rates.js on a loop instead.
CMD ["node", "server.js"]
