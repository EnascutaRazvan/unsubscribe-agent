FROM mcr.microsoft.com/playwright:v1.44.1-jammy

# Install pnpm globally
RUN npm install -g pnpm

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile

CMD ["pnpm", "start"]