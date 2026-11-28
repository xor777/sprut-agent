# Разработка

Нужны **Node.js 24.11+**, `npm` и `git`.

```sh
git clone https://github.com/xor777/sprut-agent.git
cd sprut-agent
npm ci
npm run check
```

## Команды `package.json`

| Команда | Назначение |
| --- | --- |
| `npm run check` | Сборка `dist/plugin`, проверка diff комплекта, `biome check .` и все офлайн-тесты |
| `npm run build:plugin` | Пересборка поставляемого комплекта `dist/plugin` (версия берётся из `package.json`) |
| `npm test` | Офлайн-тесты MCP, SDK, Telegram-бота и research-утилит в изолированном `HOME` |
| `npm run test:codex-install` | Проверка установки плагина реальным Codex CLI (без CLI завершается ошибкой) |
| `npm run telegram:pair` | Привязка Telegram `user_id` в `~/.config/sprut-agent/telegram.env` (`0600`) |
| `npm run telegram:bot` | Запуск локального Telegram-бота поверх `codex app-server` и `sprut-agent` |
| `npm run conformance:sim` | Репетиция сценариев соответствия на локальном симуляторе |
| `npm run conformance:live` | Живая проверка `dist/plugin` на настоящем хабе (создаёт и удаляет временные объекты; запускать только с разрешения владельца) |
| `npm run eval:agent` | Бытовые eval-кейсы внешним агентом (`claude` / `codex`) против симулятора |
| `npm run eval:judge-calibrate` | Калибровка модели-судьи на размеченных ответах (`research/eval-judge-labels.mjs`) |
| `npm run research:diff` / `record` / `snapshot` | Утилиты исследования протокола SprutHub (`research/`) |

## Запуск из checkout и устройство `dist/plugin`

Корневой `.mcp.json` запускает собранный `dist/plugin/dist/server.mjs` при старте из корня репозитория. Из любой другой папки передай абсолютный путь:

```sh
node /absolute/path/to/sprut-agent/dist/plugin/dist/server.mjs
```

`dist/plugin` хранится в Git и пересобирается через `npm run build:plugin` (в `worktree` копируй `node_modules` через `cp -cRp`, не через симлинк, чтобы в бандле не было `../../../`). Внутри комплекта три манифеста под разные правила разрешения путей: `.claude-plugin/plugin.json` и `.mcp.json` используют `${CLAUDE_PLUGIN_ROOT}`, а `.codex-plugin/mcp.json` — `./dist/server.mjs` с `cwd: "."`.

## Изоляция тестов

`npm test` и `npm run test:codex-install` автоматически подгружают `test/support/isolated-home.mjs`: подменяют `HOME` временным каталогом, очищают переменные `SPRUTHUB_*` / `SPRUT_AGENT_*` и ограничивают сеть локальными адресами. Один тестовый файл запускай так же (голый `node --test` использует настоящий `HOME`):

```sh
node --import ./test/support/isolated-home.mjs --test test/dashboards.integration.test.mjs
```

## Локальный Telegram-бот

`telegram/bot.mjs` запускает локального Telegram-бота поверх `codex app-server` (`gpt-6.2-sol`, `effort: "medium"`, `service_tier: "priority"`, `ultrafast_mode = true`, `web_search: "live"`) и собранного `dist/plugin/dist/server.mjs`. Новых npm-зависимостей не требует; нужны вход в Codex CLI (`~/.codex/auth.json`) и токен от `@BotFather`.

Настройки лежат в `~/.config/sprut-agent/telegram.env` (или `SPRUT_TELEGRAM_ENV`, `chmod 600`):

```dotenv
TELEGRAM_BOT_TOKEN=<токен от @BotFather>
TELEGRAM_ALLOWED_USER_IDS=<user_id через запятую>
```

Без непустого `TELEGRAM_ALLOWED_USER_IDS` бот не стартует; посторонние пользователи, боты и групповые чаты игнорируются.

```sh
npm run telegram:pair   # привязывает личный чат (повтори для второго владельца)
npm run telegram:bot    # запускает бота в режиме long polling
```

Состояние бота хранится в `TELEGRAM_STATE_DIR` (по умолчанию подкаталог `telegram/` в каталоге состояния `sprut-agent`):
- `codex-home/` (`0700`) — изолированный `CODEX_HOME` с симлинком на `auth.json`, `apps = false`, `read-only` песочница для хоста и гранулярное одобрение только `mcp_tool_call` сервера `sprut-agent` (руководство `skills/spruthub-master/SKILL.md` встраивается напрямую в `developerInstructions`, без регистрации как Codex skill);
- `workspace/` (`0700`) — изолированный рабочий каталог с симлинком `spruthub-references/` на `skills/spruthub-master/references/`;
- `sessions.json` и `offset.json` (`0600`) — постоянный `threadId` на чат и последний `update_id`.

В личном чате работают `/start`, `/new` (новый тред), `/status` и приём фото до 5 МБ. Офлайн-тест бота:

```sh
node --import ./test/support/isolated-home.mjs --test test/telegram-bot.integration.test.mjs
```

Отдельный экспериментальный голосовой прототип живёт в `voice/` (вне MCP-ядра).

## Логи и ручная проверка хаба

- **Журнал работы:** `work-log.jsonl` (ротация ~1 МБ в `work-log.jsonl.1`) в каталоге состояния (`SPRUT_AGENT_STATE_DIR`, иначе на macOS `~/Library/Application Support/sprut-agent`, на Linux `$XDG_STATE_HOME/sprut-agent` или `~/.local/state/sprut-agent`). Содержимое дома и секреты туда не пишутся.
  ```sh
  jq -Rc 'fromjson? | select(.outcome == "error")' work-log.jsonl
  ```
- **Ручная проверка входа и прошивки:** `node scripts/nightly-check.mjs` (read-only `home_overview`, поддерживает `install` / `uninstall` для macOS `launchd`; детали — в коде скрипта).

## Протокол и прошивка хаба

- Последнюю проверенную прошивку хранит `VERIFIED_FIRMWARE` в `src/tool-state.mjs` — обновлять только после успешного `npm run conformance:live` и датированного наблюдения.
- Датированные наблюдения протокола лежат в [research/protocol/](research/protocol/); исторические черновики — в [research/archive/](research/archive/).
- Правила кода, TDD, ревью и Git — в [AGENTS.md](AGENTS.md); стратегия и текущее состояние — в [PLAN.md](PLAN.md).
