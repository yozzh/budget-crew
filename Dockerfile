FROM node:24-slim AS build
RUN npm install -g pnpm@12.15.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm deploy --filter @budget-crew/api --prod --legacy /out

FROM node:24-slim
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /app/apps/web/dist ./web
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
