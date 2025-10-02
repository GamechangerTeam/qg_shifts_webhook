qg_shifts_webhook

Сервис для Bitrix24, который по входящему запросу проверяет рабочий ли день по двум фиксированным графикам (ID 6 и 4) на указанную дату и, если день рабочий, запускает бизнес-процесс на лиде, передавая параметр smena.

Особенности:

Параметры приходят в query-строке (а не в body).

scheduleId1/2 — это строки вида Имя Сотрудника [123456]; из них берётся ID пользователя (нужно только для логов).

«Рабочий день» определяется только по исключениям графика: если дата не попала в CALENDAR.EXCLUSIONS, считаем её рабочей.

Строгая работа по календарной дате без сдвигов таймзон.

Логи пишутся через ваш logger.js (не логируется полный URL вебхука, только host).

Параметр БП smena = 1, если сработал график 6; = 2, если сработал график 4.

Требования

Node.js 18+

Доступ к Bitrix24 с правами на:

timeman.schedule.get

bizproc.workflow.start

CRM (для документа лида)

Установка и запуск

# 1) Клонируем репо и переходим в папку проекта

npm ci

# 2) Создаём .env

cp .env.example .env

# правим при необходимости

# 3) Запуск

npm start

# или в dev-режиме (с перезапуском на изменения)

npm run dev

.env (пример):

PORT=3000
BP_TEMPLATE_ID=45
NODE_ENV=production

BP*TEMPLATE_ID — ID шаблона БП, который будет запускаться на лиде.
Документ для БП формируется из leadId: ["crm","CCrmDocumentLead","LEAD*<leadId>"].

Docker
Dockerfile (у тебя уже есть)

Сборка и запуск:

docker build -t qg_shifts_webhook .
docker run --env-file .env -p 3000:3000 -v "$(pwd)/logs:/app/logs" --name qg_shifts_webhook qg_shifts_webhook

docker-compose
name: qg_shifts_webhook
version: "3.9"

services:
qg_shifts_webhook:
container_name: qg_shifts_webhook
build:
context: .
dockerfile: Dockerfile
image: qg_shifts_webhook:latest
env_file: - .env
ports: - "3000:3000"
volumes: - ./logs:/app/logs
logging:
driver: json-file
options:
max-size: "10m"
max-file: "5"

networks:
default:
name: qg_shifts_webhook-net

Запуск:

docker compose up -d --build

API
Эндпоинт
GET/POST /qg_shifts_webhook/shift-check

Параметры читаются из query-строки, даже если это POST.

Параметры (query)
Параметр Тип Обязат. Пример Описание
b24WebhookUrl string да https://portal.bitrix24.kz/rest/<user>/<token>/ Входящий вебхук Bitrix24. В логах пишется только хост.
leadId number да 398494 Лид, на котором будет запущен БП.
scheduleId1 string да Сергей Интегратор [243822] Сотрудник 1 (используется для логов; ID берётся из [...]).
scheduleId2 string да Game Changer [150300] Сотрудник 2 (для логов).
date string да 2025-10-03 или 03.10.2025 00:00:00 Дата проверки. Интерпретируется как календарная дата без TZ.
bpTemplateId number нет 45 Переопределяет BP_TEMPLATE_ID из .env.
Примеры запросов

GET:

http://localhost:3000/qg_shifts_webhook/shift-check
?b24WebhookUrl=https://your.bitrix24.kz/rest/123/abcdef/
&leadId=398494
&scheduleId1=Сергей%20Интегратор%20[243822]
&scheduleId2=Game%20Changer%20[150300]
&date=03.10.2025%2000:00:00
&bpTemplateId=45

curl (GET):

curl "http://localhost:3000/qg_shifts_webhook/shift-check?b24WebhookUrl=https://your.bitrix24.kz/rest/123/abcdef/&leadId=398494&scheduleId1=Сергей%20Интегратор%20[243822]&scheduleId2=Game%20Changer%20[150300]&date=2025-10-03&bpTemplateId=45"

Ответы

Успех (найдён первый «рабочий» график из [6, 4]):

{
"ok": true,
"workingScheduleId": 6,
"workflowId": "123abc456",
"documentId": ["crm","CCrmDocumentLead","LEAD_398494"],
"users": [243822, 150300],
"date": "2025-10-03"
}

Выходной в обоих графиках:

{
"ok": true,
"workingScheduleId": null,
"message": "Выходной по обоим графикам (6 и 4)",
"documentId": ["crm","CCrmDocumentLead","LEAD_398494"],
"users": [243822, 150300],
"date": "2025-10-03"
}

Ошибка валидации:

{ "error": "Required query params: b24WebhookUrl, leadId, scheduleId1, scheduleId2, date" }

Логика определения «рабочего дня»

Запрашивается график timeman.schedule.get для ID 6, затем для 4.

Из ответа используется блок CALENDAR.EXCLUSIONS.

Форматы EXCLUSIONS, которые поддерживаются:

Массив строк: ["YYYY-MM-DD", ...]

Массив объектов: { "DATE": "YYYY-MM-DD" }

Диапазоны: { "DATE_FROM": "YYYY-MM-DD", "DATE_TO": "YYYY-MM-DD" }

Строковые JSON: "[]", "[{...}]" и т.п.

null, "", {} → трактуются как отсутствие исключений.

Правило: если указанная дата входит в исключения — это выходной; иначе — рабочий.

Запуск БП

Метод: bizproc.workflow.start

Документ: ["crm","CCrmDocumentLead","LEAD_<leadId>"]

Шаблон: bpTemplateId (из query или .env)

Параметры:

smena — числовой флаг: 1, если сработал график 6; 2, если сработал график 4.

В коде:

PARAMETERS: { smena: Number(scheduleId == 6 ? 1 : 2) }

Если нужно передавать именно ID графика (6/4), поменяй на Number(scheduleId).

Логи

Логирует access (каждый запрос), info (шаги и решения), error (исключения) через ваш logger.js.
Хост Bitrix24 фиксируется (для диагностики), полный URL вебхука не пишется.

Примеры сообщений:

Request received: host=qazakgrill.bitrix24.kz, leadId=..., date=2025-10-03

Schedule check: scheduleId=6, date=2025-10-03, working=true

Bizproc started: workflowId=..., scheduleId=6, leadId=...

Тестирование

Простой health-check:

curl http://localhost:3000/health

Позитивный сценарий (подставь свой вебхук/дату/лид):

curl "http://localhost:3000/qg_shifts_webhook/shift-check?b24WebhookUrl=https://your.bitrix24.kz/rest/123/abcdef/&leadId=123&scheduleId1=User%20One%20[111]&scheduleId2=User%20Two%20[222]&date=2025-10-03"

Траблшутинг

TypeError: excl.some is not a function
Встречалось, когда EXCLUSIONS приходили строкой ("[]") или объектом. В проекте это исправлено нормализацией (normalizeExclusions).

Даты «съезжают» накануне в логах
В проекте дата приводится к YYYY-MM-DD без таймзон, функция parseDateParts + печать через fmtYMD. Сдвигов быть не должно.

Bizproc start error
Проверь права вебхука на bizproc и корректность BP_TEMPLATE_ID. Убедись, что шаблон привязан к типу документа «Лид».

Безопасность

Не логируй и не кэшируй полный b24WebhookUrl.

Если публикуешь сервис наружу — ограничь доступ IP-фильтрами/прокси.

Добавь rate-limit при необходимости.

Структура проекта
.
├─ server.js # основной код сервиса (эндпоинт, логика)
├─ logger.js # ваш логгер, который импортируется как { logMessage }
├─ .env # переменные окружения
├─ Dockerfile
├─ docker-compose.yml
└─ logs/ # папка для логов (монтируется наружу)
