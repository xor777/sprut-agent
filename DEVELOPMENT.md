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
