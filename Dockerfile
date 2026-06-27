FROM node:22-bookworm

WORKDIR /app

COPY package*.json ./

RUN npm install

RUN npx playwright install --with-deps chromium

COPY . .

ENV HEADLESS=true
ENV NODE_ENV=production

CMD ["npm", "start"]