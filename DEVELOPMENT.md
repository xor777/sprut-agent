# Разработка

Нужны Node.js 24.11+, npm и Git. Общая проверка не требует Codex:

```sh
git clone https://github.com/xor777/sprut-agent.git
cd sprut-agent
npm ci
npm run check
```

`npm run check` собирает поставляемый комплект в `dist/plugin`, проверяет, что
он совпадает с закоммиченным, прогоняет Biome и офлайн-тесты публичных MCP и
SDK входов. Внешняя граница тестов — локальный WebSocket-хаб той же формы, что
настоящий; живая проверка SprutHub в неё не входит.

## Запуск из checkout

Корневой `.mcp.json` запускает собранный комплект, когда клиент стартует из
корня репозитория. Из другой папки передай клиенту абсолютный путь
`/absolute/path/to/sprut-agent/dist/plugin/dist/server.mjs`. Эквивалентная
команда:

```sh
cd /absolute/path/to/sprut-agent
node ./dist/plugin/dist/server.mjs
```

Комплект `dist/plugin` хранится в Git и собирается заново командой
`npm run build:plugin`. `package.json` — единственный источник версии
поставки; манифесты клиентов и marketplace обновляет та же сборка.

Внутри комплекта три описания одного MCP-сервера, потому что клиенты
по-разному разрешают пути. `.claude-plugin/plugin.json` и корневой `.mcp.json`
используют `${CLAUDE_PLUGIN_ROOT}`: так читают Claude Code, Grok и адаптер MCP
для Pi, они раскрывают переменную и запускают процесс из папки сессии.
`.codex-plugin/mcp.json` использует `./dist/server.mjs` с `cwd: "."`: Codex
запускает процесс из папки плагина.

## Проверки

```sh
npm run check              # Сборка комплекта, Biome и офлайн-тесты
npm run test:codex-install # Установка плагина реальным Codex CLI 0.154.0+
npm run test:mutations     # Необязательная адресная диагностика Stryker
```

Проверка установки Codex отдельная: без CLI команда завершается ошибкой, а не
пропуском. Она ставит плагин в изолированный профиль и проходит сценарии
установки, занятого имени MCP и перехода с прежнего ручного skill.

`eval:spruthub-master` — прогон переносимого skill вместе с MCP через Codex
CLI и его профиль:

```sh
npm run eval:spruthub-master
npm run eval:spruthub-master -- contact-option plugin
```

Запуск использует временный профиль, синтетический хаб и сохраняет
доказательства вне репозитория. Успешный выход подтверждает завершение прогона,
а не продуктовый вердикт. Ручной сценарий неоднозначной комнаты:
`node research/check-agent-room-ambiguity.mjs ambiguous`.

## Бытовые задачи внешним агентом

`eval:agent` даёт внешнему агенту бытовую просьбу и проверяет, справился ли он
через поставляемый плагин и сколько контекста потратил. Хаб заменяет
симулятор `test/support/simulated-hub.mjs` с домом
`test/fixtures/homes/apartment.json`. Оценка детерминированная: по записям и
итоговому состоянию симулятора и по тексту ответа. Прогон вызывает модель,
поэтому в `npm run check` не входит; там проверяются только симулятор,
грейдеры и связка раннера со скриптовым агентом.

```sh
npm run eval:agent -- read-temperature                 # Claude Code, sonnet
npm run eval:agent -- all --harness codex
npm run eval:agent -- turn-off-room --plugin-dir /path/to/other/dist/plugin
npm run eval:agent -- --help                           # список задач и флагов
```

`claude` запускает `claude -p` с плагином из `--plugin-dir` (по умолчанию
`dist/plugin`), без пользовательских настроек и чужих MCP; агенту доступны
только инструменты `sprut-agent`, Skill и Read. Нужен действующий вход
Claude Code CLI. `codex` ставит тот же каталог через временный marketplace в
изолированный профиль и берёт `~/.codex/auth.json`. `--plugin-dir` на
detached worktree другого коммита сравнивает две сборки.

Каждый прогон пишет в каталог вне репозитория `result.json` (грейдеры, число
вызовов, байты результатов инструментов, токены, время, версия и git sha
плагина), транскрипт и запросы к симулятору и печатает строку-итог.
Симулятор не настоящий SprutHub: успешный прогон не заменяет живую приёмку.

## Соответствие настоящему хабу

`npm run conformance:live` проверяет собранный `dist/plugin` на хабе из
`connection.env`: создание, readback и удаление комнаты, BLOCK-форм по
контракту, частичные изменения BLOCK и LOGIC. Скрипт пишет только в объекты
со своим префиксом `zz-sprut-agent-probe-<время>`, создаёт BLOCK выключенными
и в конце удаляет всё созданное. Снимок дома до и после должен совпасть.
Отчёт и журнал изменений лежат во временном каталоге вне репозитория.
Запускать только с разрешения владельца дома.

`-- --read-only` проверяет чтения и снимки без записи.
`-- --include-orphaning` добавляет формы, которые продукт сейчас не может
удалить после нормализации хабом. Результаты прогонов — в
[research/protocol/](research/protocol/).

## Код, исполняемый на хабе

Перед созданием LOGIC агент вызывает `get_scenario_sdk` и получает текущие
декларации sandbox выбранного хаба. `sdk_complete=true` означает полный `sdk`,
`false` — частичное содержимое с защитным marker. `bytes` и `sha256` описывают
фактически возвращённый текст, freshness — время ответа. Это API кода на хабе,
а не Node или browser SDK; локально код не исполняется.

## Исследование протокола

| Команда | Результат |
| --- | --- |
| `npm run research:diff -- --from <снимок> --to <снимок>` | Сравнение схем и каталога операций |
| `npm run research:record -- --cdp-url http://127.0.0.1:9222` | Пассивная запись WebSocket-событий через Chrome DevTools Protocol |
| `npm run research:snapshot` | Попытка извлечь схемы и метаданные из публичной сборки |

Recorder требует отдельную браузерную сессию с CDP и ручную авторизацию. Raw
captures сохраняются с правами `0600` в исключённом из Git каталоге и могут
содержать секреты; санитайзер не реализован.

Снимок `1.5.58` относится к сборке 2025-09-16. Полный snapshot CLI на текущей
публичной сборке останавливается на распознавании build; отдельная функция
извлечения protobuf-модулей текущий JS читает. Источники, версии и границы
достоверности — в [research/protocol/](research/protocol/). Исторические
черновики лежат в [research/archive/](research/archive/) и не задают текущий
объём работ.

## Правила и задачи

Git использует Conventional Commits; RED/GREEN, ревью, ветки и рабочая копия
описаны в [AGENTS.md](AGENTS.md). Задачи, результаты и приёмка ведутся в
[проекте SPRUT](https://plan.nuanu.ai/project/SPRUT), порядок работы — в
[документе команды](https://plan.nuanu.ai/project/SPRUT/docs/178).

<details>
<summary>Подключение Plan для работы над репозиторием</summary>

Локальный `.codex/config.toml` подключает Plan только в этом репозитории и
исключён из Git:

```toml
[mcp_servers.plan]
url = "https://api-plan.nuanu.ai/mcp"
http_headers = { Authorization = "Bearer ВАШ_КЛЮЧ_АГЕНТА" }
```

Используй ключ внешнего агента с доступом к SPRUT и права `0600`. Для OAuth
убери `http_headers`, выполни `codex mcp login plan` из корня и перезапусти
клиент после изменения конфигурации.

</details>
