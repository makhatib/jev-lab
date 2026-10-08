FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --break-system-packages --no-cache-dir "fastapi==0.143.0" "uvicorn[standard]==0.54.0" "websocket-client==1.9.2" "httpx[http2]==0.28.1" \
 && npm install -g @anthropic-ai/claude-code@2.1.294 --no-audit --no-fund \
 && mkdir -p /tmp/claude-home /runs
WORKDIR /app
COPY . .
ENV PYTHONUNBUFFERED=1
CMD ["python3", "-m", "uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8090", "--ws-max-size", "16777216"]
