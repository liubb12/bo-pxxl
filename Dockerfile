FROM node:alpine

WORKDIR /app

# 先复制依赖配置文件，利用 Docker 缓存加速构建
COPY package.json ./

# 只安装必要的依赖，去掉不必要的系统升级和冗余包
RUN npm install

# 复制源码
COPY index.js index.html ./

EXPOSE 3000

CMD ["node", "index.js"]
