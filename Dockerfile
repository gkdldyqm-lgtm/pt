FROM nvidia/cuda:12.4.1-base-ubuntu22.04

ARG GITHUB_REPOSITORY=unknown/huesteria-cloud

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=4000 \
    CHROME_EXECUTABLE=/usr/bin/google-chrome \
    HUESTERIA_RESULT_ROOT=/workspace/huesteria-results

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      libvulkan1 vulkan-tools \
      libgbm1 libnss3 libxss1 libasound2 \
      libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 \
      libgtk-3-0 libxcomposite1 libxdamage1 libxfixes3 \
      libxkbcommon0 libxrandr2 fonts-liberation \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs google-chrome-stable \
 && npm install -g npm@latest \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/huesteria
RUN npm init -y >/dev/null 2>&1 \
 && npm install --omit=dev --save-exact playwright-core@1.54.2 \
 && npm cache clean --force

COPY worker.mjs /opt/huesteria/worker.mjs

LABEL org.opencontainers.image.title="Huesteria Cloud Renderer" \
      org.opencontainers.image.description="Prebuilt RTX 4090 Huesteria WebGL path tracing worker" \
      org.opencontainers.image.source="https://github.com/${GITHUB_REPOSITORY}"

EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=12 CMD curl -fsS http://127.0.0.1:4000/health || exit 1

CMD ["node", "/opt/huesteria/worker.mjs"]
