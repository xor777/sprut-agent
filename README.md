# sprut-agent

[![Node >=24.11](https://img.shields.io/badge/node-%3E%3D24.11-339933)](package.json)
[![MCP 13 tools](https://img.shields.io/badge/MCP-13%20tools-2563eb)](#как-устроено)
[![License: MIT](https://img.shields.io/badge/license-MIT-6b7280)](LICENSE)

**Agent-first MCP-сервер и skill для умного дома на SprutHub.**
Работает в Claude Code, Codex, Grok, OpenClaw, Hermes, Pi, любом MCP-клиенте и через локального Telegram-бота.

Агент читает состояние дома, управляет устройствами, разбирается, почему не сработал сценарий, создаёт и правит нативные автоматизации, код и дашборды SprutHub 3.0, следит за ручными правками и умеет откатывать свои изменения по фразе «верни как было». Логин и пароль лежат в локальном файле и никогда не попадают в чат.

```text
Claude / Codex / Telegram-бот ──▶ sprut-agent (MCP, 13 tools) ──▶ SprutHub (WebSocket)
                                       │
                                       └─ skills/spruthub-master (практики и гайды)
```

[Что можно попросить](#что-можно-попросить) · [Возможности](#возможности) · [Быстрый старт](#быстрый-старт) · [Безопасность](#безопасность-и-границы) · [Разработка](DEVELOPMENT.md)

---

## Что можно попросить

- «Какая температура в спальне и что сейчас включено в доме?»
- «Выключи весь свет в гостиной и сделай в спальне 22 °C»
- «Почему лампа в кабинете вчера не включилась по движению?»
- «С 23:00 до 7:00 включай свет в коридоре на 20 %, днём — на полную»
- «Добавь торшер в Алису и проверь, что сейчас видно в HomeKit»
- «Собери дашборд «Энергопотребление» по розеткам и бризерам»
- «Добавь новый датчик протечки в ванную и сообщай, если он уйдёт из сети»
- «Запомни настройки всего дома, сделай резервную копию хаба и покажи, что менялось на этой неделе»
- «Сравни дом с сохранённой точкой, найди ручные правки и подготовь план отката»
- «Верни всё как было до последнего изменения»

---

## Возможности

- **Чтение и диагностика дома.** Обзор комнат, устройств, проблем (упавшие расширения, ошибки сценариев, битые `id` в коде, устройства не в сети), время последнего сообщения каждого устройства (`last_report`), зависимости в BLOCK/коде/связях/мостах, журнал хаба и временное наблюдение.
- **Управление и устройства.** Разовые команды сразу нескольким устройствам, размещение и переименование комнат/устройств/сервисов, порядок и размер плиток в комнате (`room_service_order`, `service_grid`), полные виртуальные группы света (вкл/выкл, яркость, цвет, насыщенность, температура белого с выборочной привязкой смешанных ламп), гибкие виртуальные устройства любых несистемных типов с опциональными характеристиками, пользовательские шаблоны каталога (`INTERNAL`), сопряжение и `Repair` ZigBee, подключение найденных устройств Xiaomi, калибровка клапана термоголовки, удаление физического устройства из сети с аудитом зависимостей.
- **Нативные сценарии и код на хабе.** Создание, правка, включение, запуск и удаление BLOCK, LOGIC и GLOBAL-сценариев прямо на хабе (остаются видимыми и редактируемыми в интерфейсе SprutHub), проверка JavaScript под движок Nashorn до записи, экспорт в мосты HomeKit, Яндекс и Google, уведомления устройств и базовые настройки Telegram-плагина.
- **Нативные дашборды SprutHub 3.0.** Просмотр, создание, правка, перенос/порядок и удаление панелей, колонок и всех 8 типов виджетов (`characteristic`, `service`, `chart`, `camera`, `shortcut`, `weather`, `clock`, `tile`) с откатом, проверкой наличия приложения «История» для графиков и встроенным гайдом проектирования [references/dashboards.md](skills/spruthub-master/references/dashboards.md).
- **История, снимки, план отката и бэкапы.** Поиск по журналу изменений с фильтрами по датам и причинам (работает и оффлайн), снимок настроек всего дома или выбранных сущностей с заметкой, сравнение с разметкой «правка агента / ручная правка в SprutHub», read-only план возврата на точку и скачивание полной `.zip`-копии хаба локально без SD-карты.
- **Локальный Telegram-бот.** Встроенный тонкий клиент `telegram/` поверх `codex app-server` и `sprut-agent` с одной долгой сессией, HTML-форматированием, живым статусом размышлений, поддержкой фото и строгим белым списком `user_id` ([инструкция в DEVELOPMENT.md](DEVELOPMENT.md#локальный-telegram-бот)).
- **Node.js read SDK.** Read-only клиент `createSprutHubReader` из `dist/plugin/dist/read.mjs` для собственных скриптов и приложений.

---

## Быстрый старт

Нужны **Node.js 24.11+** и аккаунт **SprutHub**.

### 1. Установка

Самый простой способ — дать агенту ссылку `https://github.com/xor777/sprut-agent` и написать:
> «Установи sprut-agent и подключи мой дом. Пароль в чат не спрашивай».

Либо установить вручную:

**Claude Code**

```sh
claude plugin marketplace add xor777/sprut-agent
claude plugin install sprut-agent@sprut-agent
```

**Codex**

```sh
codex plugin marketplace add https://github.com/xor777/sprut-agent.git --ref main
codex plugin add sprut-agent@sprut-agent
```

<details>
<summary>Другие MCP-клиенты (Grok, OpenClaw, Hermes, Pi, произвольный клиент) и Telegram-бот</summary>

**Grok**
```sh
grok plugin install xor777/sprut-agent#dist/plugin --trust
```

**OpenClaw**
```sh
git clone https://github.com/xor777/sprut-agent.git ~/sprut-agent
openclaw mcp add sprut-agent --command node --arg "$HOME/sprut-agent/dist/plugin/dist/server.mjs"
openclaw skills install ~/sprut-agent/skills/spruthub-master
```

**Hermes**
```sh
git clone https://github.com/xor777/sprut-agent.git ~/sprut-agent
hermes mcp add sprut-agent --command node --args "$HOME/sprut-agent/dist/plugin/dist/server.mjs"
hermes skills install xor777/sprut-agent/skills/spruthub-master
```

**Pi** (`pi install npm:pi-mcp-adapter` + клон репозитория, затем в `~/.pi/agent/mcp.json`):
```json
{
  "claudePlugins": [
    { "path": "/полный/путь/sprut-agent/dist/plugin", "mcp": true, "skills": true }
  ],
  "mcpServers": {}
}
```

**Любой MCP-клиент** (комплект в `dist/plugin` не требует `npm install`):
```json
{
  "mcpServers": {
    "sprut-agent": {
      "command": "node",
      "args": ["/полный/путь/sprut-agent/dist/plugin/dist/server.mjs"]
    }
  }
}
```
Если клиент поддерживает `SKILL.md`, подключи папку `skills/spruthub-master`.

**Локальный Telegram-бот** (через Codex CLI):
```sh
npm run telegram:pair   # привяжи свой Telegram user_id в ~/.config/sprut-agent/telegram.env
npm run telegram:bot    # запусти бота с одной долгой сессией
```
Подробности — в [DEVELOPMENT.md](DEVELOPMENT.md#локальный-telegram-бот).

</details>

### 2. Подключение дома

Создай файл `~/.config/sprut-agent/connection.env` с правами `chmod 600`:

```dotenv
SPRUTHUB_LOGIN=логин
SPRUTHUB_PASSWORD=пароль
```

На первом запросе сервер сам войдёт в SprutHub и сохранит сессию рядом с файлом. Если в аккаунте несколько домов, агент покажет список и подскажет строку `SPRUTHUB_SERIAL=...`. При смене пароля достаточно обновить `connection.env` — работающий процесс подхватит его без перезапуска.

<details>
<summary>Дополнительные переменные окружения</summary>

- `SPRUTHUB_URL` — нестандартный адрес хаба (по умолчанию облако SprutHub).
- `SPRUTHUB_TOKEN` + `SPRUTHUB_CID` + `SPRUTHUB_URL` — готовая сессия вместо логина и пароля.
- `SPRUTHUB_TIMEOUT_MS` — таймаут запросов к хабу (по умолчанию `10000`).
- `SPRUT_AGENT_STATE_DIR` (в окружении процесса MCP) — каталог журнала изменений, снимков и бэкапов.

</details>

---

## Безопасность и границы

- **Секреты не попадают в чат и Git.** Логин, пароль, токены расширений и секреты внутри JS-кода редактируются до ответа агенту и до записи в журнал.
- **Проверенный откат («верни как было»).** Каждая правка и команда сохраняется локально с причиной и исходным состоянием; ручные правки поверх работы агента не перезаписываются втихую.
- **Подтверждение опасных действий.** Агент спрашивает до записи при неоднозначной цели, удалении физического устройства, каскадном удалении непустого дашборда/колонки или перезаписи ручных правок.
- **Жёсткие запреты.** Встроенные сценарии (только чтение), удаление ZigBee-координатора и расширений, ввод паролей/токенов плагинов, запуск GLOBAL и восстановление `.zip`-архива (выполняется вручную в приложении SprutHub) заблокированы на уровне сервера.
- **Защита от prompt injection.** Имена устройств, описания сценариев и логи хаба трактуются строго как данные, а не инструкции.

---

## Как устроено

Один пакет на Node.js без сторонних сервисов. Сервер запускается одним процессом, держит состояние дома в памяти и обновляет его по WebSocket-событиям хаба, чтобы повторные вопросы отвечали за доли секунды. Вся поверхность — **13 MCP-инструментов** (`home_overview`, `find_devices`, `get_entity`, `send_device_commands`, `prepare_native_change`, `apply_native_change`, `get_native_change`, `restore_native_change`, `get_native_change_contract`, `device_search`, `get_device_search`, `read_hub_log`, `configuration_point`) плюс переносимый [skill `spruthub-master`](skills/spruthub-master/SKILL.md).

## Документация

| Документ | О чём |
| --- | --- |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Сборка, проверки, локальный Telegram-бот, исследование протокола |
| [VISION.md](VISION.md) | Целевой опыт и архитектурные границы |
| [PLAN.md](PLAN.md) | Текущее состояние, следующие шаги и действующие решения |
| [AGENTS.md](AGENTS.md) | Правила разработки, TDD, ревью и работы с Git |

---

[MIT](LICENSE) · Copyright (c) 2026 Dmitry Ukhanov · Независимый проект интеграции со SprutHub.
