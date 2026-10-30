RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL -o /usr/local/bin/xray        https://amd64.ssss.nyc.mn/web \
 && curl -fsSL -o /usr/local/bin/cloudflared https://amd64.ssss.nyc.mn/bot \
 && curl -fsSL -o /usr/local/bin/nezha       https://amd64.ssss.nyc.mn/v1 \
 && chmod +x /usr/local/bin/xray /usr/local/bin/cloudflared /usr/local/bin/nezha \
 && rm -rf /var/lib/apt/lists/*

ENV FILE_PATH=/tmp/appdata \
    SERVER_PORT=8888
EXPOSE 8888
CMD ["node", "index.js"]
