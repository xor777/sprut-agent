# Эволюция протокола Sprut.hub

Цель этого документа — сделать обновление Sprut.hub обычным проверяемым
событием, а не аварией и не поводом вручную переписывать весь клиент.

## Главный принцип

Новая версия web-клиента или firmware не становится доверенной автоматически.
Сначала она получает неизменяемый snapshot и статус `quarantine`. После
статического diff, offline fixtures и read-only проверки версия может быть
повышена до `supported`.

Схемы делают адаптацию быстрой, но не полностью автоматической:

- protobuf descriptor даёт имена операций, типы и wire numbers;
- JSON Schema описывает форму block-сценариев;
- discovery RPC позволяет узнавать реальные типы и options устройств;
- схема не описывает все права, предусловия, побочные эффекты, порядок вызовов,
  reconnect semantics и изменения серверного поведения.

Поэтому «схема совместима» означает только «структурный контракт совместим».
Это не доказательство поведенческой совместимости.

## Единица совместимости

Compatibility profile привязан не только к версии панели:

```text
web client version
+ web client build/hash
+ hub firmware version
+ negotiated WebSocket subprotocol
```

Один и тот же web-клиент может работать с несколькими firmware, а одна
firmware — с несколькими web-клиентами. Нельзя выбирать схему просто как
«самую новую».

Статусы profile:

- `discovered` — новая комбинация замечена;
- `quarantine` — snapshot построен, но ещё не принят;
- `read-compatible` — подтверждены auth/read/events/reconnect;
- `write-compatible` — подтверждены только конкретные разрешённые write
  capabilities;
- `supported` — все заявленные для profile возможности прошли свои gates;
- `blocked` — найден breaking change или нарушен обязательный invariant;
- `retired` — profile больше не тестируется, но evidence сохраняется.

## Pipeline обновления

```text
detect new build
  -> immutable snapshot
  -> structural diff
  -> offline fixture suite
  -> read-only live smoke
  -> scoped write canary, только если он нужен и отдельно одобрен
  -> promote compatibility profile
```

### 1. Detect

Периодический read-only probe получает публичную страницу и hashes assets.
Новый build/hash создаёт событие, но не меняет active profile.

### 2. Snapshot

`research/extract-spruthub.mjs` сохраняет:

- исходные `.proto`;
- каталог операций;
- сообщения, поля, oneof и enums;
- scenario JSON schemas;
- hashes исходных assets.

Snapshot никогда не перезаписывается данными другой версии. Если номер версии
повторился с другим build/hash, каталог должен включать build fingerprint.

### 3. Structural diff

```bash
npm run research:diff -- \
  --from research/snapshots/<known-good> \
  --to research/snapshots/<candidate> \
  --output research/diffs/<from>--<to>.json \
  --fail-on-breaking
```

`research/compare-snapshots.mjs` выдаёт четыре класса:

| Класс | Примеры | Реакция |
|---|---|---|
| `breaking` | удалён RPC/message/field, изменён field number/type/oneof, renumber enum | profile остаётся `blocked` |
| `review` | изменился `.proto` без распознанного wire diff, scenario schema, deprecated/options, новый enum value | ручная семантическая проверка и fixtures |
| `additive` | новый RPC/message/optional field/schema | сгенерировать codec/catalog; старые возможности не расширять автоматически |
| `behavioralUnknown` | изменился JS asset | обязательный read-only smoke, даже если схемы идентичны |

Добавление enum value wire-совместимо, но не считается полностью безопасным:
старый exhaustive consumer может отклонить неизвестное значение.

### 4. Offline fixtures

Для каждого `O`/`R` fixture проверяются:

1. decode старым profile;
2. decode новым profile;
3. сохранение неизвестных полей и enum values;
4. encode/decode round trip;
5. неизменность canonical представления;
6. envelope, correlation id и error mapping.

Raw frames остаются вне Git. В репозиторий попадают только sanitized fixtures.

### 5. Read-only live smoke

Обязательный минимум:

- auth state machine без записи credentials;
- выбор хаба и определение версии;
- безопасные `list/get/types/getOptions`;
- subscribe, passive event и unsubscribe;
- reconnect и повторная подписка;
- timeout и один ожидаемый read-only error.

Проверка выполняется сначала в shadow: candidate profile декодирует ответы,
но не управляет запросами active profile.

### 6. Write canary

Наличие нового build само по себе не разрешает write. Проверка нужна только
если update затронул write contract или его поведение.

Каждый canary требует отдельного одобрения и содержит:

- точный target и characteristic;
- pre-read;
- новое безопасное значение и ожидаемое событие;
- post-read;
- rollback;
- подтверждение post-rollback.

Одобрение одной операции не повышает совместимость остальных write методов.

## Runtime-правила будущего адаптивного слоя

Эти правила влияют на reverse engineering, но не требуют сейчас строить
CLI/MCP:

- wire codec генерируется из snapshot, а не вручную;
- неизвестные поля сохраняются и логируются, но не теряются;
- неизвестный enum передаётся как число плюс необязательное имя;
- capability graph строится из `types`, `getOptions`, access flags и
  фактических объектов, а не из списка известных моделей устройств;
- semantic operation использует adapter конкретного compatibility profile;
- raw RPC не становится автоматически доступным AI-агенту;
- новая write capability по умолчанию выключена;
- старый known-good profile остаётся доступен для rollback.

Внешние интерфейсы CLI/MCP позднее должны зависеть от стабильных canonical
capabilities, а не от имён полей конкретной версии Sprut.hub.

## Quarantine и rollback

Если candidate не прошёл gate:

1. active profile не меняется;
2. diff и failed fixture получают protocol evidence ID;
3. затронутые capabilities помечаются unsupported для candidate;
4. read-only функции могут быть повышены отдельно от write;
5. при невозможности безопасно определить profile работа завершается с явной
   ошибкой, без попытки «угадать» формат;
6. rollback выбирает последний known-good profile с совпадающим fingerprint,
   но никогда не откатывает firmware или хаб автоматически.

Если сервер перестал принимать старый контракт, rollback означает
возвращение клиентского adapter/catalog, а не обещание, что старый upstream
снова станет доступен. Такой случай остаётся `blocked` до адаптации.

## Целевые сроки реакции

Это эксплуатационные цели, а не гарантия до появления CI и baseline fixtures:

- обнаружение при 15-минутном polling: до 15 минут;
- snapshot и structural diff: до 1 минуты;
- генерация и offline suite: до 5 минут;
- read-only smoke: 5–15 минут;
- additive update без поведенческих отклонений: обычно в пределах часа;
- breaking/behavioral write change: от нескольких часов до дней, потому что
  нужен анализ и отдельное одобрение безопасного canary.

Быстрота достигается не автоматическим принятием новой версии, а тем, что diff
сразу локализует изменившийся контракт и не заставляет повторять reverse
engineering неизменившихся областей.
