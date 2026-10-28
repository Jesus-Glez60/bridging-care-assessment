# One image for both the app and the simulator (they share the npm workspace).
FROM node:22.20.0-alpine AS client
WORKDIR /repo/app-skeleton/client
COPY app-skeleton/client/package.json app-skeleton/client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app-skeleton/client/ ./
RUN npx ng build

FROM node:22.20.0-alpine
WORKDIR /repo
COPY package.json package-lock.json ./
COPY simulator/package.json simulator/
COPY app-skeleton/server/package.json app-skeleton/server/
RUN npm ci --no-audit --no-fund
COPY seed/ seed/
COPY simulator/ simulator/
COPY app-skeleton/server/ app-skeleton/server/
COPY mockups/ mockups/
COPY --from=client /repo/app-skeleton/client/dist/client/browser app-skeleton/client/dist/client/browser
RUN chown -R node:node /repo
USER node
ENV NODE_ENV=production
EXPOSE 3000 4010
CMD ["npm", "run", "start", "-w", "app-skeleton/server"]
