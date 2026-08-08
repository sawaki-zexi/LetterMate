FROM node:24-alpine AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json

RUN npm ci

FROM dependencies AS build

COPY . .
RUN npm run db:generate
RUN npm run build

FROM dependencies AS api

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/config/src packages/config/src
COPY --from=build /app/packages/contracts/src packages/contracts/src
COPY --from=build /app/packages/domain/src packages/domain/src
COPY --from=build /app/prisma prisma
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client node_modules/@prisma/client
COPY --from=build /app/package.json package.json
COPY --from=build /app/package-lock.json package-lock.json

USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "apps/api/dist/main.js"]

FROM dependencies AS worker

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/packages/config/src packages/config/src
COPY --from=build /app/packages/contracts/src packages/contracts/src
COPY --from=build /app/packages/domain/src packages/domain/src
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client node_modules/@prisma/client
COPY --from=build /app/package.json package.json
COPY --from=build /app/package-lock.json package-lock.json

USER node
EXPOSE 9464
CMD ["node", "--import", "tsx", "apps/worker/dist/main.js"]

FROM api AS postgres-ops

USER root
RUN apk add --no-cache postgresql17-client \
    && mkdir -p /backups \
    && chown node:node /backups
USER node

VOLUME ["/backups"]
CMD ["node", "--import", "tsx", "apps/api/dist/postgres-backup-cli.js", "direct", "--directory", "/backups"]

FROM nginx:1.29-alpine AS web

COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080
