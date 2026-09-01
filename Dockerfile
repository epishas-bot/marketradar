# Обычный Node-рантайм Render не подходит: получению "цены на сайте" теперь нужен
# настоящий управляемый браузер (Playwright/Chromium) — Wildberries отдаёт цену только
# после честного выполнения JS-проверки, которую не пройти голым HTTP-запросом (см.
# README → «Откуда берутся две цены»). Chromium требует системных библиотек, которых
# нет в обычном Node-окружении Render — поэтому сервис теперь собирается через Docker.
FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./

# npm install ДО `playwright install`, чтобы версия Chromium подтягивалась ровно под
# версию пакета playwright из package.json (они должны совпадать).
RUN npm install --omit=dev

# Ставит сам Chromium и все системные библиотеки (шрифты, кодеки и т.д.), которые ему
# нужны — именно поэтому обычный (не-Docker) Node-рантайм Render не годится: там нет
# root-доступа для apt-get, а --with-deps как раз его использует.
RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
