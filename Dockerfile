FROM node:18-bullseye

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install && npm cache clean --force

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
