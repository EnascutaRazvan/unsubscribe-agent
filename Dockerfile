FROM mcr.microsoft.com/playwright:v1.44.1-jammy

# Install pnpm and TypeScript
RUN npm install -g pnpm typescript

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile

# Compile TypeScript -> JavaScript
RUN pnpm run build

# Start the compiled JS
CMD ["npm", "run", "start"]
