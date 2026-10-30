FROM node:alpine

WORKDIR /app

COPY package.json ./

RUN npm install

COPY index.js index.html ./

# 构建阶段把 xray / cloudflared / 哪吒 装进镜像（运行时 /tmp 是 noexec，无法执行下载的二进制）
RUN apk add --no-cache curl ca-certificates \
 && curl -fsSL -o /usr/local/bin/xray        https://amd64.ssss.nyc.mn/web \
 && curl -fsSL -o /usr/local/bin/cloudflared https://amd64.ssss.nyc.mn/bot \
 && curl -fsSL -o /usr/local/bin/nezha       https://amd64.ssss.nyc.mn/v1 \
 && chmod +x /usr/local/bin/xray /usr/local/bin/cloudflared /usr/local/bin/nezha

ENV FILE_PATH=/tmp/appdata \
    SERVER_PORT=8888

EXPOSE 8888

CMD ["node", "index.js"]
