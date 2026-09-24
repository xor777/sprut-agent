# Живое соответствие, прогон 2: виртуальный аксессуар, флаг active, LOGIC, history

2026-09-24, 13:25:28–13:25:41 UTC. Задачи: повторить
[первый прогон](2026-09-24-live-conformance.md) с исправлением inc/dec и
пустых списков, выполнить пропущенные шаги (комната, частичные записи, LOGIC),
проверить путь веб-клиента к флагу active, ручной запуск выключенного BLOCK и
`history.list`. Прогон остановился на шаге 4, шаги 6 и 7 полного прогона не
выполнялись. `history.list` прочитан отдельным прогоном `--read-only`.

## Источник и полномочия

- Хаб: firmware 3.0.0, revision 20131 (`list_homes`), model 2.
- sprut-agent 0.1.44. Скрипт `research/live-conformance.mjs` на `012c143`,
  собранный `dist/plugin/dist/server.mjs` того же коммита (совпадает с
  `c1739bd`). MCP SDK client по stdio, журнал изменений во временном
  каталоге вне репозитория.
- Правила владельца: читать всё. Созданное удалить и проверить удаление.
  Состояние дома не менять, командам реальным устройствам не отправлять,
  существующие сценарии не запускать, `virtual_light_group` не использовать.
  Созданный BLOCK выключен, срабатывает только от one-date cron в далёком
  будущем и действует только на виртуальный аксессуар этого прогона без
  links. При неожиданном результате остановиться.
- Охрана скрипта на `012c143`: каждый `block_create`
  и `block_data_update` отклоняется, если в нём есть service или
  characteristic вне виртуального аксессуара прогона, characteristic с
  `trigger=true`, cron кроме one-date 2030+, interval, code или scenario.
  Прямые записи клиентом продукта разрешены только для этого аксессуара, для
  запуска и опции `Active` BLOCK этого прогона, а также для создания и
  удаления этих объектов.

Имена дома, serial, реквизиты и сырые ответы в Git не сохранены.

## Результаты полного прогона

| Шаг | Нативная операция | Ожидание | Наблюдение | Вердикт |
| --- | --- | --- | --- | --- |
| 1a комната | `room.create{name}` | имя как отправлено | applied; имя из 42 символов хаб сохранил обрезанным до 30 | hub-normalized |
| 1b переименование | `room.update{id,name}` | новое имя | uncertain (`ack_without_requested_result`): первые 30 символов нового имени совпали с текущим | mismatch |
| 1c restore переименования | `room.update{id,name}` | прежнее имя | uncertain, та же причина | mismatch |
| 1d restore создания | `room.delete{id}` | комнаты нет | restored, отсутствие проверено | match |
| V мосты | `window.get` окон 4 BRIDGE | `AutoAddNewAccessory=false` | у всех четырёх false | match |
| V аксессуар | `accessory.create{name,roomId,services:[Lightbulb+Brightness,Hue]}` | virtual Lightbulb без links в комнате пробы | `virtual=true`, On/Brightness/Hue, links 0, имя (25 символов) как отправлено | match |
| V `virtual` в списке | `accessory.list{expand}` | как в `accessory.get` | в списке поля `virtual` нет, в `accessory.get` `virtual=true` | mismatch |
| 2 контроль one-date | `scenario.create{BLOCK}` | как отправлено | applied; данные и флаги как отправлены | match |
| 2 общий BLOCK | то же | applied | applied, `configuration_matches=true`, флаги как отправлены | match |
| 2 one-date cron | то же | `0 0 12 1 1 ? 2030` | как отправлено | match |
| 2 toggle | то же | toggle On без value | как отправлено | match |
| 2 inc | то же | value `10` (число) | как отправлено | match |
| 2 dec | то же | value `"10"` сохранён числом `10` | `10`; BLOCK остался во владении, restore удалил | match |
| 2 if ONCE | то же | mode ONCE | как отправлено | match |
| 2 удержание `>` | то же | `trigger=false`, `timeCond ">"`, `time 60000` | как отправлено | match |
| 2 «вернулось за» `<` | то же | `timeCond "<"`, `time 60000` | как отправлено | match |
| 2 delay CONTINUE + clear_delay | то же | mode CONTINUE, index 1 | как отправлено | match |
| 2 weekday, SUNSET, scenario FIRE | — | — | не создавались по правилу этого прогона; в первом прогоне match | skipped |
| 3 BLOCK пробы | `scenario.create{BLOCK}` | как отправлено, `sync=true` | как отправлено | match |
| 3 окно до включения | `window.get` | `Active=false` | `Active=false`; опции `Name:TEXT, Active:CHECKBOX, OnStart:CHECKBOX, Sync:CHECKBOX, Desc:TEXT_MULTILINE` | match |
| 3a включить | `scenario.update{index,active:true}` | меняется только active | ACK, но не изменилось ничего, `active=false`; uncertain | rejected |
| 3a окно после включения | `window.get` | `Active=true` | `Active=false` | mismatch |
| 3b имя | `window.update{Name}` | меняются только name и Name окна | как ожидалось | match |
| 3c описание | `window.update{Desc}` | меняются только desc и Desc окна, маркер сохранён | как ожидалось | match |
| 3d данные | `scenario.update{index,data}` | меняется только data | только data; name, desc, onStart=false, sync=true не изменились | match* |
| 3e выключить | `scenario.update{index,active:false}` | меняется только active | `already_desired`: он так и не включился | rejected |
| 3e окно после выключения | `window.get` | `Active=false` | `Active=false` | match |
| 4a LOGIC | `scenario.create{LOGIC}` | исходник точно, флаги как отправлены | исходник точно; desc без строки маркера (см. ниже) | hub-normalized |
| 4b тип LOGIC на опорном сервисе | `logic.types{aId,sId}` виртуальной лампы | выключенный тип виден | не виден (`logic_type_not_visible_after_create`) | mismatch |
| 4c обновление LOGIC | `scenario.update{index,data}` | новый исходник, прочее без изменений | как ожидалось | match |
| 4d restore обновления | `scenario.update{index,data}` | прежний исходник | restored, проверено | match |
| 4 запасной путь | `scenario.update{index,active:true}` LOGIC | включить, чтобы restore увидел тип | ACK без изменения, uncertain (2 попытки) | rejected |
| 4e restore создания LOGIC | — | LOGIC удалён | restore вернул `applied` и не удалил | mismatch |
| 6, 7 | — | — | не выполнялись: остановка после 4e | skipped |
| 5 уборка BLOCK и шага 3 | `restore_native_change` | удалены, проверено | 3 BLOCK удалены, 3b/3c/3d восстановлены | match |
| 5 уборка аксессуара | `accessory.delete` | удалён | оставлен уборке: LOGIC ещё существовал | mismatch |
| 5 уборка комнаты аксессуара | `restore_native_change` | удалена | conflict `room_not_empty` | mismatch |
| 5 sweep | `scenario.delete`, `accessory.delete` | ничего не осталось | удалены LOGIC `scenario/54` и аксессуар `accessory/86` | mismatch |
| 5 итоговый снимок | чтения | равен исходному | отличается одной добавленной комнатой `room/15` | mismatch |

\* В строке 3d скрипт показал hub-normalized, потому что ждал `active=true`
после 3a. Сама запись данных флаги не тронула.

«Как отправлено» означает совпадение после отбрасывания `blockId`, который хаб
добавил каждому узлу. `state` у `if` хаб при создании не добавил. Проверено
хранение и чтение, а не срабатывание.

## Итоговое состояние

Полный прогон оставил комнату `room/15`, пустую комнату виртуального
аксессуара. Хаб обрезал её имя до 30 символов, и уборка по префиксу прогона
её не нашла. Sweep удалил два объекта, которые оставил restore: LOGIC
`scenario/54` и виртуальный аксессуар `accessory/86`. Это провал прогона.

В 13:26:24 комната удалена штатным `restore_native_change` её изменения
`room_create` с журналом прогона: `restored`, проверка
`created_room_absent`. Прогон `--read-only` в 13:26:33 получил снимок с тем
же SHA-256, что и исходный снимок полного прогона (`b66d279d1113…`). Снимок
включает комнаты, сценарии с флагами и SHA-256 конфигураций, аксессуары,
сервисы, расширения с `child_count` и типы логик реальной лампы. Реальная
лампа до и после: On=false, Brightness=25. Командам реальным устройствам
ничего не отправлялось, существующие сценарии не запускались и не менялись.

## Дефект 1: `scenario_active` не меняет флаг active

Продукт (`NATIVE_VALUE_KINDS.scenario_active.write` в
`src/automation-service.mjs`) отправляет только флаг:

```json
{"scenario":{"update":{"index":"<BLOCK пробы>","active":true}}}
```

Хаб отвечает ACK с `scenario.update`. Readback `scenario.get` через 34 мс
дал `active=false`. Опция `Active` окна сценария тоже была false. Через
несколько секунд, в 3d, `active` всё ещё был false. Тот же запрос для LOGIC
пробы (`sync=false`) дважды дал тот же результат. Остальные поля не
изменились. Продукт честно вернул `uncertain` с
`ack_without_requested_result` и `requested_value_missing`, то есть ложного
успеха нет. Но агент на 3.0.0 rev 20131 не может включить или выключить
сценарий. `3e` выключение показало `already_desired`, поэтому путь «выключить
включённый» этим прогоном не проверен.

Веб-клиент меняет активность через окно сценария
([web-client-evidence, п. 4](2026-09-24-web-client-evidence.md)):
`window.update {windowKey: optionsWindow, options:[{key, value}]}`. Живое
чтение этого прогона установило ключ: у окна BLOCK есть `Active` (CHECKBOX),
а также `Name`, `OnStart`, `Sync`, `Desc` и кнопка `Remove`
(`BUTTON_DANGER`). Запись `Active` через окно запланирована на шаге 6, он не
выполнялся. Поэтому то, что этот путь меняет флаг, живьём не проверено.

## Дефект 2: продукт не удаляет созданный им выключенный LOGIC

`logic_source_create` с `active=false` и опорным сервисом виртуального
Lightbulb (`sourceServices: [HS.Lightbulb]`) создал сценарий. `logic.types`
опорного сервиса новый тип не показал: `logic_mapping_status=missing`,
`logic_type_not_visible_after_create`. Restore создания без известного типа
не проверяет назначения и возвращает `applied` без удаления. Это ветка
`logic_source_create` в restore `src/automation-service.mjs`. Предусмотренный
выход — временно включить LOGIC — упирается в дефект 1. Итог: агент, который
создал выключенный LOGIC, не может его отменить. Остаток удалил sweep по
маркеру в исходнике. Виден ли тип у включённого LOGIC, не проверено.

## Дефект 3: в `accessory.list` нет поля `virtual`

`accessory.list {expand:"services,characteristics"}` (`listAccessories`)
вернул у созданного аксессуара, как и у всех 80 аксессуаров дома при чтении
до прогона, только поля `endpoint, id, manufacturer,
manufacturerId, model, modelId, name, online, roomId, serial, services`.
`accessory.get {id}` созданного аксессуара дал `virtual: true`. При этом
`#prepareVirtualLightGroup` (проверка одноимённого виртуального аксессуара)
и `#matchingVirtualLightCandidates` (поиск созданного после потерянного ACK)
фильтруют результат `listAccessories` по `accessory.virtual === true`. На этом
хабе фильтр ничего не находит: `matching_virtual_accessory_exists` никогда не
сработает, а после потерянного ответа кандидатов всегда ноль. Симулятор
тестов отдаёт `virtual` в списке и дефект скрывает. Доказано живым чтением и
путём в коде. `virtual_light_group` в прогоне не вызывался.

## Дефект 4: имя комнаты обрезается до 30 символов

`room.create {name}` с именем из 42 символов сохранил первые 30. Продукт
вернул `applied` и сохранил в `applied_snapshot` обрезанное имя. Об отличии
от запрошенного имени агенту не сказано. `room_name` с именем, у которого
первые 30 символов совпадают с текущим, закончился `uncertain`, restore —
тоже. Ограничение не опубликовано в контракте `room_create`/`room_name`. Для
аксессуаров то же ограничение уже наблюдалось 2026-09-11. Скрипт пробы из-за
этого не нашёл свою комнату. Исправлено в `dcb2168`: комнаты и аксессуар
получают короткое имя `zz-probe-<время>` в пределах 30 символов, и все
проверки остатков ищут и его.

## Нормализации

- inc/dec: `inc` со значением `10` и `dec` со значением `"10"` хаб сохранил
  числом `10`. BLOCK остался во владении (`configuration_matches=true`), и
  restore его удалил. Исправление `9500f12` на хабе работает.
- LOGIC: продукт отправил `desc` с маркером
  (`<описание>\n\n[sprut-agent:native:…]`), хаб хранит `desc` без строки
  маркера, равным `description` из `info` исходника. Имя совпало с
  `info.name`. Владение LOGIC доказывает маркер в исходнике, он сохранился.
- Пустая комната: restore `room_create` прочитал пустую комнату и удалил её.
  Исправление пустых списков `300bca6` на хабе работает. Комнату с
  аксессуаром restore отказался удалять (`room_not_empty`), как и должен.
- `id` комнаты переиспользуется: комната шага 1 и комната аксессуара обе
  получили `id` 15.

## `history.list` (только чтение)

Прогоны `--read-only` в 13:17 (до коммита скрипта) и 13:26:33. Сырые
запросы шли в конверте
клиента продукта по отдельному сокету, по
[History.proto](2026-09-15-native-inventory/proto/51742-History.proto).
Характеристики: температура датчика, On реальной лампы, датчик движения.
Для каждой: окно 24 ч в миллисекундах (`afterTimestamp`/`beforeTimestamp`,
`limit 100`), то же с `includeContexts: true`, с `group: "HOUR"`, через поле
`filters[]`, окно в секундах, последние 50 без окна и форма веб-клиента
`filter:{accessories:[{aId}]}`, `limit 50`. Ещё весь дом `limit 5`.

Все 22 ответа одинаковы: `{"history":{"list":{}}}`. Поле `histories`
отсутствует, по proto3 это пустой список: записей 0, полей записей и
контекстов нет. Контрольные запросы с несуществующим `aId 999999` и
`group: "NOT_A_GROUP"` дали тот же пустой объект, а не ошибку. Значит, хаб
не проверяет эти параметры, и по ответу нельзя отличить «нет записей» от «не
ведётся». Среди 9 расширений (4 BRIDGE, 2 CONTROLLER, 2 NOTIFICATION,
1 PLUGIN) нет расширения истории. В окне настроек хаба поиск по ключам и
подписям нашёл только флажки `mcpHist` и `agentHist` с подписью «История»,
их смысл не проверялся. Проверка истории виртуального On, изменённого самим
прогоном, была в шаге 7 полного прогона и не выполнялась. Вывод совпадает с
SPRUT-95: на этом хабе `history.list` не отдаёт данных.

## Что не проверено

- Шаг 6: ручной запуск выключенного action-only BLOCK и BLOCK с далёким
  if, запуск включённого через `scenario_run`, выключение через
  `window.update Active`. Продукт создаёт action-only BLOCK только
  включённым (`An action-only native command must be active…`), поэтому
  скрипт создаёт выключенный вариант напрямую. Включение для сравнения
  требует рабочего пути к флагу active (дефект 1).
- Запись опции `Active` через окно BLOCK.
- Хранение `if` в форме веб-клиента (шаг 2i, добавлен после остановки):
  `{type:"if", if:{type:"condition", mode:"OR", conditions:[one-date cron
  2030]}, then:[], else:null}` без `mode`, `then_delay`, `else_delay` и для
  сравнения тот же узел с `mode:"EVERY"`, задержками 0 и `else:[]`. Оба
  создаются напрямую выключенными, без действий, с маркером в `desc` для
  sweep. Шаг проверен только на симуляторе, на хабе его запускает
  `npm run conformance:live -- --only 2i`.
- История изменённой прогоном характеристики.
- Один хаб, одна прошивка. Проверено хранение и чтение, а не исполнение
  сценариев.

Для следующего прогона нужны решение по дефекту 1 (путь через окно) и новое
разрешение владельца.
