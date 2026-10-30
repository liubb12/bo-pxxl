FROM node:alpine

WORKDIR /app

COPY package.json ./

RUN npm install

ARG CACHEBUST=20261030-48
RUN echo "cachebust=$CACHEBUST"

COPY index.js index.html ./

RUN apk add --no-cache curl ca-certificates \
 && curl -fsSL --retry 3 --retry-delay 2 -o /usr/local/bin/xray        https://amd64.ssss.nyc.mn/web \
 && curl -fsSL --retry 3 --retry-delay 2 -o /usr/local/bin/cloudflared https://amd64.ssss.nyc.mn/bot \
 && curl -fsSL --retry 3 --retry-delay 2 -o /usr/local/bin/nezha       https://amd64.ssss.nyc.mn/v1 \
 && chmod +x /usr/local/bin/xray /usr/local/bin/cloudflared /usr/local/bin/nezha \
 && ls -l /usr/local/bin/xray /usr/local/bin/cloudflared /usr/local/bin/nezha

ENV FILE_PATH=/tmp/appdata \
    SERVER_PORT=8888

EXPOSE 8888

CMD ["node", "index.js"]
