# Reverse engineering API Sprut.hub

> Архив исследования. Текущий объём работ и ограничения — в [README](../../README.md).
> Эти планы и версии не являются текущим контрактом или обязательным backlog.

Статус: design draft, 2026-07-27.

Цель этого этапа — восстановить проверенный контракт API Sprut.hub. Реализация
CLI, агентных команд и автоматического управления в этот этап не входит.

## Целевой паритет

Конечный контракт должен покрывать 100% функций обычного web-интерфейса:

- login state machine, account и выбор дома;
- комнаты, accessories, services и characteristics;
- чтение всех свойств, options, типов и допустимых значений;
- поток событий и восстановление состояния после reconnect;
- управление всеми доступными характеристиками;
- создание, редактирование, запуск и удаление сценариев;
- контроллеры, устройства, мосты и notification clients;
- настройки хаба, диагностические файлы и административные операции.

«Есть RPC в схеме» не означает паритет. Для каждой функции должны быть
связаны UI-поведение, endpoint, request/response/event types, ошибки,
версионные ограничения и проверка результата.

Текущий режим исследования — read-only. Любой write-эксперимент требует
отдельного одобрения с точным endpoint, объектом, исходным и новым значением,
ожидаемым эффектом и rollback.

## Что уже подтверждено

Источник фактов — web-клиент `https://beta.spruthub.ru/`, его загруженный
JavaScript bundle и встроенные protobuf-схемы.

- Наблюдаемый web-клиент: `1.5.58`, build `2025-09-16T14:32:15.361Z`.
- Основной транспорт: WebSocket
  `wss://beta.spruthub.ru/spruthub`.
- Клиент предлагает подпротоколы `protobuf` и `json-rpc`. JSON всегда
  поддерживается, protobuf включается отдельной настройкой web-клиента.
- В bundle находятся 26 исходных protobuf-файлов.
- В схемах описаны 23 домена и 168 активных операций.
- Запросы коррелируются целочисленным `id`; timeout web-клиента — 10 секунд.
- Контекст запроса включает `cid`, account token и serial активного хаба.
- Сервер отправляет асинхронные события без request `id`.

Основные домены:

`account`, `hub`, `room`, `accessory`, `service`, `characteristic`, `device`,
`controller`, `bridge`, `scenario`, `logic`, `notification`, `file`, `log` и
другие административные домены.

Стабильная адресация устройства имеет три уровня:

```text
accessory:      aId
service:        aId + sId
characteristic: aId + sId + cId
```

Значение характеристики типизировано через protobuf `oneof`:

```text
boolValue | intValue | longValue | doubleValue | stringValue
```

### JSON envelope

Статически восстановленная форма исходящего запроса:

```json
{
  "id": 1,
  "cid": "<client-id>",
  "token": "<account-token>",
  "serial": "<hub-serial>",
  "params": {
    "accessory": {
      "list": {
        "expand": "services,characteristics"
      }
    }
  }
}
```

Для операции `notification_client.*` имя домена в envelope переводится в
camelCase: `notificationClient`.

Статически восстановленная форма ответа:

```json
{
  "id": 1,
  "result": {
    "accessory": {
      "list": {
        "accessories": []
      }
    }
  }
}
```

Ошибка:

```json
{
  "id": 1,
  "error": {
    "code": -667002,
    "message": "<message>"
  }
}
```

События встречаются в двух совместимых представлениях:

```json
{
  "method": "characteristic.event",
  "params": {}
}
```

```json
{
  "event": {
    "characteristic": {}
  }
}
```

Форма envelope пока имеет статус `schema + client code`. Её нужно подтвердить
реальными WebSocket-фреймами до реализации клиента.

## Модель доказательств

Для каждого endpoint ведём три независимых статуса:

| Статус | Значение |
|---|---|
| `S` — schema | Операция и типы восстановлены из protobuf/client bundle |
| `O` — observed | Запрос, ответ или событие замечены в реальном трафике |
| `R` — replayed | Операция воспроизведена отдельным минимальным клиентом |

Endpoint разрешено использовать в будущем CLI только после `S + O + R`.

Карточка endpoint должна содержать:

```text
operation
request type
response type
event types
required context: cid/token/serial
risk class
observed app and hub versions
sanitized request/response fixtures
error cases
replay result
```

## Лаборатория

### 1. Статический extractor

Extractor получает URL web-клиента и создаёт versioned snapshot:

```text
research/snapshots/<web-version>/
  manifest.json
  proto/
  scenario-schemas/
  methods.generated.json
  types.generated.json
  hashes.txt
```

`manifest.json` фиксирует:

- URL и время получения;
- версию и build web-клиента;
- имена и SHA-256 загруженных bundle;
- число найденных proto-файлов;
- предупреждения extractor.

Extractor не читает browser storage, cookies или авторизационные данные.

### 2. WebSocket recorder

Для динамического исследования используется отдельная сессия Chromium с CDP.
Пользователь входит в Sprut.hub вручную, recorder подписывается только на
события WebSocket.

Текущую авторизованную in-app вкладку нельзя считать источником wire frames:
доступный runtime-журнал показывает версию приложения и служебные
предупреждения, но не request/response payloads. Поэтому динамический capture
выполняется отдельным recorder, без извлечения token из существующей сессии.

Записываем:

- время;
- направление `sent` / `received`;
- URL сокета;
- negotiated subprotocol;
- opcode;
- text payload либо base64 binary payload;
- метку эксперимента.

Не записываем handshake headers, cookies, пароли и содержимое browser storage.
Raw capture хранится вне Git с правами `0600`.

```text
research/captures/raw/          # gitignored, содержит секреты
research/captures/sanitized/    # разрешённые fixtures
```

Sanitizer заменяет:

- token → `<TOKEN>`;
- cid → `<CID>`;
- serial → `<HUB_SERIAL>`;
- имена домов, комнат и устройств → стабильные псевдонимы;
- произвольные пользовательские строки → hash/placeholder.

Числовые `aId/sId/cId` в sanitized fixtures можно сохранять как стабильные
псевдонимы, чтобы не потерять связи между событиями.

Binary payload декодируется только извлечёнными protobuf-схемами
соответствующей версии.

### 3. Experiment runner

Каждый эксперимент имеет:

```text
id
цель
версия web-клиента
версия хаба
начальное состояние
одно действие
ожидаемый результат
фактические frames
изменение состояния
способ восстановления
вывод
```

На первом проходе допускаются только read-only эксперименты.

## Последовательность исследований

### Phase 0 — воспроизводимый snapshot

1. Скачать текущие hashed bundles.
2. Извлечь все proto-файлы без ручного копирования.
3. Построить каталог доменов, операций, request/response/event types.
4. Построить каталог всех messages, fields, enums и oneof.
5. Повторный запуск на том же bundle должен давать идентичный snapshot.

Критерий готовности: 26 схем извлекаются детерминированно, секретов в
snapshot нет.

### Phase 1 — baseline capture

Эксперимент `E001`:

1. Начать запись до загрузки панели.
2. Войти вручную либо открыть уже авторизованную сессию.
3. Дождаться полной загрузки дома.
4. Ничего не нажимать 30–60 секунд.
5. Остановить запись и выполнить sanitization.

Нужно получить реальную bootstrap-последовательность: auth/hub selection,
начальные list/get запросы, подписки и фоновые события.

Критерий готовности: каждый baseline frame декодирован и связан с операцией из
схемы либо явно отмечен как unknown.

### Phase 2 — read-only navigation

Отдельные captures:

- список хабов;
- список комнат;
- список accessories с `expand=services,characteristics`;
- карточка одного accessory;
- типы services/characteristics;
- список сценариев без запуска;
- контроллеры и мосты без открытия форм изменения.

Критерий готовности: минимальный read model дома восстанавливается только из
frames, без чтения DOM.

### Phase 3 — события

1. Записать пассивное изменение датчика.
2. Связать событие с `aId/sId/cId`.
3. Декодировать типизированное значение.
4. Проверить, заменяет ли событие состояние или содержит patch.
5. Проверить поведение reconnect и необходимость явных `subscribe`.

Критерий готовности: после bootstrap локальное состояние корректно
обновляется потоком событий.

### Phase 4 — read-only replay

Отдельный минимальный probe подключается к WebSocket и выполняет только:

- `account.auth` / `account.answer`;
- `hub.list`;
- `room.list`;
- `accessory.list` с `expand=services,characteristics`;
- безопасные `get`/`types`.

Нельзя извлекать token из browser storage. Probe проходит штатную login
state machine и хранит полученный token только в системном Keychain.

Критерий готовности: ответы probe совпадают по форме с observed fixtures, а
web-панель продолжает работать параллельно.

### Phase 5 — одна обратимая команда

Этап выполняется только после отдельного подтверждения пользователя.

Выбирается тестовое или виртуальное устройство. Для него:

1. прочитать текущее значение;
2. отправить один `characteristic.update`;
3. дождаться response и соответствующего event;
4. перечитать значение;
5. вернуть исходное значение;
6. подтвердить восстановление.

Пустой `EmptyResponse` не считается доказательством изменения. Успех
подтверждается событием и последующим чтением состояния.

Критерий готовности: полный цикл воспроизводим и имеет автоматический rollback.

## Risk classes

| Класс | Примеры | Политика |
|---|---|---|
| `R0 read` | `list`, `get`, `types`, `version` | Разрешено в лаборатории |
| `R1 observe` | events, `subscribe`, `unsubscribe` | Разрешено без изменения дома |
| `R2 reversible control` | allowlisted `characteristic.update` | Только после pre-read, с диапазоном и rollback |
| `R3 configuration` | `setOptions`, rename/update, create | Только с явным подтверждением |
| `R4 physical/destructive` | `scenario.run`, delete, reset, restart, upgrade, discovery/exclusion, firmware | Не автоматизировать на этапе reverse engineering |

Будущий AI-агент по умолчанию получает только `R0/R1`. Доступ к `R2`
выдаётся на конкретные `aId/sId/cId`, тип значения и допустимый диапазон.
`R3/R4` не должны быть неявными агентными действиями.

## Auth, versioning и совместимость

Login web-клиента — state machine:

1. `account.auth`;
2. сервер возвращает `question`;
3. клиент отвечает `account.answer`;
4. возможны email, password, captcha, email/SMS PIN и другие вопросы;
5. финальный ответ содержит token.

Неизвестные свойства, которые нужно установить экспериментально:

- срок жизни и отзыв token;
- связь token с account, `cid` и хабом;
- поведение нескольких одновременных клиентов;
- права обычного пользователя и администратора;
- совместимость схемы web-клиента с разными версиями firmware хаба;
- доступен ли тот же `/spruthub` endpoint напрямую в LAN.

Каждый fixture маркируется парой:

```text
web client version + hub firmware version
```

При изменении bundle extractor создаёт diff:

- добавленные/удалённые операции;
- изменение protobuf field number;
- изменение oneof;
- изменение enum;
- изменение deprecated status.

Изменение field number, oneof или wire type считается breaking change.
Изменение client bundle при неизменной схеме считается поведенчески
неизвестным и требует read-only smoke.

Полная политика quarantine, promotion и rollback описана в
`docs/protocol-evolution.md`. Реализованный structural gate:

```bash
npm run research:diff -- \
  --from research/snapshots/<known-good> \
  --to research/snapshots/<candidate> \
  --fail-on-breaking
```

## Артефакты этапа

```text
docs/api-reverse-engineering.md
docs/protocol-evolution.md
research/extract/
research/snapshots/
research/captures/
research/experiments/
research/compare-snapshots.mjs
```

До будущего CLI должны существовать:

1. воспроизводимый extractor;
2. versioned proto snapshot;
3. sanitized baseline capture;
4. endpoint catalog со статусами `S/O/R`;
5. read-only replay probe;
6. документированный auth lifecycle;
7. таблица рисков и allowlist policy;
8. один подтверждённый обратимый write experiment.

## Что не делать

- Не строить контракт по DOM и текстам кнопок.
- Не считать имя метода доказанным только потому, что оно есть в bundle.
- Не коммитить raw frames, token, serial и названия объектов дома.
- Не использовать существующий token из localStorage браузера.
- Не начинать с protobuf: сначала подтвердить логический контракт на JSON.
- Не проверять опасные методы ради полноты покрытия.
- Не связывать будущую агентную команду напрямую с произвольным RPC.

## Следующий практический шаг

Сначала реализуется только Phase 0: extractor и versioned schema snapshot.
После проверки diff и отсутствия секретов — WebSocket recorder для `E001`.

Официальная wiki описывает MQTT-мосты и локальный доступ, но публичного
описания обнаруженного WebSocket API в ней не найдено. MQTT следует позднее
оценить как поддерживаемый альтернативный транспорт, а не смешивать с
контрактом web-панели.
