# Orbita in a container, for anyone who would rather not install Node.
#
#   docker build -t orbita . && docker run -p 8788:8788 orbita
#
# Nothing else is needed: no keys, no account, no database. The server reads
# NOAA on a timer and holds it in memory.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY web ./web
COPY ui ./ui
COPY skills ./skills
# Registered farms live here. Mount a volume over it to keep them across runs.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV PORT=8788
EXPOSE 8788
# /health reports how old the NOAA reading in memory is, which is the thing
# that actually matters about this process being up.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8788/health || exit 1
CMD ["node", "dist/server.js"]
