FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm install -g @anthropic-ai/claude-code@2.1.294 --no-audit --no-fund
COPY . .
RUN mkdir -p /tmp/claude-home
ENV DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
