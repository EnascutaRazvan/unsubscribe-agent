FROM mcr.microsoft.com/playwright:v1.44.1-jammy

WORKDIR /app

COPY . .



# Optional: Run Playwright install explicitly if needed
# RUN npx playwright install --with-deps

CMD ["pnpm", "start"]
