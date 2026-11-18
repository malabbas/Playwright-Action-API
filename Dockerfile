FROM mcr.microsoft.com/playwright:v1.58.1-jammy

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV HOST=0.0.0.0
USER pwuser

EXPOSE 3000

CMD ["node", "server.js"]
