# --- Сборка ---
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# --- Прод-зависимости ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate

# --- Рантайм ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY prisma ./prisma
COPY package.json ./

USER node
EXPOSE 3000

CMD ["node", "dist/main.js"]
