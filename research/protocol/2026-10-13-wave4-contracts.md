# Волна 4: окно сценария, виртуальные устройства, связи, мосты, резервная копия

O20261013-wave4-contracts, 2026-10-13. Цель — до реализации волны 4
проверить на хабе контракты, которые продукт пока знает только из кода
веб-клиента: переименование LOGIC и GLOBAL через окно опций, «запуск при
старте» и синхронизацию, виртуальные устройства кроме ламп и связи между
ними, окно экспорта в мосты (только чтение) и резервную копию (только код).

## Источники

- Живой хаб владельца: Sprut.hub 2, прошивка 3.0.0, ревизия 20131, ветка
  beta. Уровень `O`.
- Клиент продукта `SprutHubConnection` (`src/spruthub-connection.mjs`) на
  `2e1c36e`: учётные данные и выбор дома — его; запросы — отдельный
  JSON-RPC сокет в том же конверте, как `historyList` в
  `research/live-conformance.mjs`. Скрипты лежали во временном каталоге
  сессии, в Git не сохранялись.
- Веб-клиент `app.16735171810a795a9f2d.js`, SHA-256
  `81c1ef74ce21eb5ccff583255ba82fe766ff4cf6bc251c0566b7bd67436647f8` (та же
  сборка, что в [карте действий](2026-09-24-web-client-action-map.md)), и
  схемы [2026-09-15-native-inventory/proto](2026-09-15-native-inventory/proto/).
  Уровень `S`.

## Полномочия и процедура

- Правило владельца: читать всё; создавать только свои временные объекты с
  префиксом прогона `zz-w4-<MMДДччмм>` и удалять их; свои сценарии включать,
  только если они действуют лишь на свои виртуальные устройства; окна мостов
  только читать; `extension.action`, кнопки окон и `file.*` не вызывать.
- Охрана скрипта пропускала чтения и только такие записи: `room.create` и
  `accessory.create` с префиксом (аксессуар — в своей комнате и только если
  у всех мостов `AutoAddNewAccessory=false`), `characteristic.update`,
  `link.addVirtual`, `link.remove` на своих аксессуарах, `scenario.create`
  выключенным, `scenario.update` и `window.update` окна опций своего
  сценария (`Name` с префиксом, `Desc`, `OnStart`, `Sync`; `Active=true`
  только своему LOGIC или GLOBAL, чей сохранённый код ничего не делает),
  удаление своих объектов. LOGIC прогона — объект `info` и пустой
  `trigger`; GLOBAL — только комментарий; BLOCK — дата 2030 года и
  выключение своей виртуальной лампы.
- Перед прогонами скрипт репетировался на симуляторе (`apartment`), затем:
  чтения без записи; прогон 1 (комната, 9 виртуальных аксессуаров, LOGIC,
  GLOBAL, BLOCK); прогон 2 (комната, Switch и Lightbulb, по одному сценарию
  каждого типа) для оставшихся вопросов. После записи — пауза 0,4–1,2 с и
  чтение `scenario.get`, `scenario.list`, `window.get`, `accessory.get`,
  `characteristic.get`, `link.list`, `logic.types`.

## Наблюдения

### 1. Окно опций сценария

| № | Запрос | Наблюдение | Ур. |
| --- | --- | --- | --- |
| 1.1 | `window.get {windowKey: scenario.optionsWindow}` у BLOCK, LOGIC, GLOBAL и встроенного LOGIC | Ключи одинаковы: группы `main`, `primary`, `footer`; `Name` TEXT «Название»; `Active` CHECKBOX «Активный»; `OnStart` CHECKBOX «Выполнить на старте хаба»; `Sync` CHECKBOX «Последовательное выполнение»; `Desc` TEXT_MULTILINE «Описание»; `Remove` BUTTON_DANGER с подтверждением. Все `write=true`, не `disabled`. Ключ окна равен индексу сценария | O |
| 1.2 | то же у 16 пользовательских сценариев владельца | `Name`, `Active`, `OnStart`, `Sync` окна совпадают с `scenario.get`. `sync=true` у 9 из 14 BLOCK; `onStart=true` у GLOBAL и 3 встроенных LOGIC | O |
| 1.3 | `scenario.update {index, name}`, `{desc}`, `{onStart}`, `{sync}` для своих BLOCK, LOGIC, GLOBAL; `{data, name}` как в редакторе BLOCK | ACK, но ни одно поле не изменилось ни в `scenario.get`, ни в окне. `{data}` применяется. `{active}` хаб так же игнорирует ([прогон 2](2026-09-24-live-conformance-2.md), 3a) | O |
| 1.4 | `window.update {Name}` своего LOGIC | `scenario.get` и `scenario.list` сразу показывают новое имя; исходник не меняется (`info.name` прежний). У включённого LOGIC имя типа в `logic.types` следует за новым именем | O |
| 1.5 | `scenario.update {data}` своего LOGIC после записи окна | Имя снова становится `info.name` исходника при каждой записи кода, даже если `info.name` не менялся; `onStart` — `info.onStart`, тоже при неизменном значении. `desc` становится `info.description` (проверено с изменённым описанием). `sync` запись кода не трогает | O |
| 1.6 | `scenario.create {type: LOGIC, name ≠ info.name, desc, onStart: true, sync: true}` | `name` = `info.name`, `desc` = `info.description`, `onStart` = `info.onStart` (`false`), `sync` = `true` как отправлено | O |
| 1.7 | Окно своего LOGIC после записей кода | Окно хранит последнее записанное в него или переданное при создании (`Name`, `Desc`, `OnStart`) и не показывает значения, выведенные из кода: после 1.5 и 1.6 окно и `scenario.get` расходятся | O |
| 1.8 | `window.update {Name}`, `{Desc}`, `{OnStart}`, `{Sync}` своего GLOBAL | Применяются сразу, окно и `scenario.get` совпадают. Запись кода имя не меняет | O |
| 1.9 | `scenario.create {type: GLOBAL, active: false, onStart: false, sync: false, data: "// …"}` | Принят. Веб-клиент создаёт GLOBAL как `{type: "GLOBAL", name: "", desc: "", onStart: true, active: true, sync: false, data: ""}` (`ScenariosPlusModal`) | O, S |
| 1.10 | `window.update {OnStart}`, `{Sync}` своего BLOCK, затем `scenario.update {data}` | Флаги меняются сразу в `scenario.get`, `scenario.list` и окне; запись данных их не сбрасывает | O |
| 1.11 | Окна 7 встроенных LOGIC (только чтение) | Значения окна — заглушки: `Name` = `"name"`, `Desc` = `"desc"`, `OnStart=true` у всех 7, хотя `scenario.get` даёт `onStart=true` только у 3; `Active` совпадает. Имя сценария равно `info.name` его кода. Ключ окна — слово-индекс | O |

### 2. Виртуальные устройства и связи

| № | Запрос | Наблюдение | Ур. |
| --- | --- | --- | --- |
| 2.1 | `accessory.create {name, roomId, services: [{type, name, optional: []}]}` для Switch, Outlet, ContactSensor, OccupancySensor, MotionSensor, TemperatureSensor, Thermostat; Lightbulb с `optional: ["Brightness"]`; один аксессуар с двумя Switch | Все приняты, `virtual: true`. Ответ — аксессуар с `endpoint, id, roomId, online, name, manufacturer, model, manufacturerId, modelId, serial, services`. Информационный сервис: `C_Room`, `Identify`, `Manufacturer`, `Model`, `Name`, `SerialNumber`, `FirmwareRevision`, `C_Online` (`notify: true`) | O |
| 2.2 | Характеристики созданных сервисов (`accessory.get`) | Switch, Outlet: `On` bool rw; Outlet `OutletInUse` bool r. ContactSensor `ContactSensorState`, OccupancySensor `OccupancyDetected`: int 0..1, 2 допустимых значения, r. MotionSensor `MotionDetected` bool r. `CurrentTemperature` double −1000..1000, шаг 0,1, r. Thermostat: `TargetTemperature` double 10..38/0,1 rw (сначала 10); `TargetHeatingCoolingState` int −3..3, 8 значений, rw (сначала −3, ECO); `CurrentHeatingCoolingState` int 0..2 r; `TemperatureDisplayUnits` int 0..1 rw | O |
| 2.3 | `characteristic.update {aId, sId, cId, control: {value}}` основных характеристик | Все записи с ACK прочитаны как отправлены, в том числе характеристики с `write: false`: состояние контакта, присутствия, движения, температура, `OutletInUse`, `CurrentHeatingCoolingState`. Значение `TargetHeatingCoolingState` −666666 (`LAST_VALUE`, `checked: false`) — ACK без изменения | O |
| 2.4 | `characteristic.getOptions` виртуального Switch `On` | `ShowAllEvents` CHECKBOX, `Inversed` CHECKBOX, `SwitchOffTime` NUMBER | O |
| 2.5 | `link.addVirtual {aId, sId, cId: On выключателя, tAId, tSId, tCId: On своей лампы}` | ACK; ответ `{type: "IN", index (строка), controller, characteristics: [лампа]}`. `link.list`: у выключателя IN, у лампы OUT. `hasLinks: true` у обеих сразу, без отдельной записи | O |
| 2.6 | Запись после связи (обработка 0, «Последнее значение») | Выключатель → лампа и лампа → выключатель: значение доходит за ≤ 1,2 с в обе стороны | O |
| 2.7 | `characteristic.update {hasLinks: false}` при живой связи; затем `{hasLinks: true}` | ACK, `hasLinks` остаётся `true`, связь работает. Хаб выводит флаг из наличия связей; запись флага ничего не меняет | O |
| 2.8 | `characteristic.update {linkProcessing: 2, 1, 0}` на стороне IN | `accessory.get` показывает записанное значение у выключателя; у лампы остаётся 0. `characteristic.get` не возвращает ни `hasLinks`, ни `linkProcessing` | O |
| 2.9 | `link.remove {aId, sId, cId выключателя, linkId}` | ACK; у выключателя связей нет, `hasLinks: false` сам; у лампы остаётся пустой OUT (без характеристик) и `hasLinks: true`; `link.remove` этого OUT на лампе — ACK без изменения. Запись в выключатель больше не доходит до лампы. Пустой OUT оставался до удаления самой лампы | O |
| 2.10 | `characteristic.update {control: {minValue, maxValue, minStep}}`: `TargetTemperature` 10..38/0,1 → 16..28/0,5, `Brightness` 0..100/1 → 10..90/5 | ACK; `characteristic.get` и `accessory.get` показывают отправленное; текущее значение в пределах сохранилось. Запись за пределом — ACK, хранится граница (30 → 28, 95 → 90) | O |
| 2.11 | `characteristic.update {control: {validValues: [2 из 8]}}` у `TargetHeatingCoolingState` | ACK; список остаётся из 8 элементов `{value, key, name, checked}`: отправленные сохраняют свой `checked`, остальные получают `checked: false` | O |

### 3. Экспорт в мосты (только чтение)

| № | Запрос | Наблюдение | Ур. |
| --- | --- | --- | --- |
| 3.1 | `extension.list`, окна опций мостов | 4 моста: `Bridge:google_<n>`, `Bridge:homekit_<n>`, два `Bridge:yandex_<n>`; запущен один, три выключены (`NOT_LOADED`). У всех `AutoAddNewAccessory` CHECKBOX = `false` | O |
| 3.2 | `extensionChild.list {extensionKey}` моста | По ребёнку на каждый аксессуар, который мост может экспортировать (70, 80, 79 и 79 из 81); `id` ребёнка — id аксессуара; `spaceKey` `main` у экспортированных (2, 4, 22, 3), `notConnected` у остальных; `optionsWindow` = `<extensionKey с «/» вместо «:»>/Child/<aId>/`, как собирает `BridgesScreen` | O, S |
| 3.3 | `window.get` дочернего окна моста | Опции: группы `main` и `AccessoryGroup`, `Accessory` ACCESSORY_LIST только чтение, и по CHECKBOX `s:<sId>` на каждый экспортируемый сервис аксессуара; подпись — имя сервиса, `boolValue` — экспортирован ли сервис. Аксессуар с 9 сервисами: 4 флажка `true`. У 8 прочитанных детей: в `main` хотя бы один флажок `true`, в `notConnected` все `false`. Окно читается и у выключенного моста | O |
| 3.4 | То же для своего нового виртуального Switch | Во всех 4 мостах `notConnected`, `s:13` = `false`: при `AutoAddNewAccessory=false` новый аксессуар не экспортируется. После удаления аксессуара его ребёнка нет ни в одном мосте | O |

### 4. Резервная копия

| № | Источник | Наблюдение | Ур. |
| --- | --- | --- | --- |
| 4.1 | `SystemDownloadModal`, `File.proto` | `file.backups {}` → `{loc, path, scope}`; клиент показывает «Архивирование...» до события `file` (`{success, loc, path, length, scope, name}`) с тем же `path`; затем `file.filePart {path, start, length ≤ 131072}` → `{data}` base64, повтор 3 раза через 1 с; в `finally`, и при отмене, `file.complete {path}`; файл `Sprut.Hub_Backup_yyyy.MM.dd-HH_mm_ss.zip`. Запрос заставляет хаб собрать архив, поэтому не вызывался | S |
| 4.2 | `window.get` окна настроек хаба, группа `backup` в `extended` | `CreateBackup` BUTTON «Создать резервную копию» (`validValues` `intValue: 1`, без подтверждения); `BackupProgress` PROGRESS_BAR, скрыт, 0; `UploadBackup` FILE_UPLOAD, `write: false`; `Restore` LIST «Восстановление из резервной копии», текущее значение пустое, 5 вариантов: пустой и 4 сохранённые копии (значение — путь к файлу на хабе с меткой времени, подпись `ДД.ММ.ГГГГ ЧЧ:ММ:СС · <размер>`, у каждой подтверждение о замене данных и перезагрузке хаба). Возраст копий 2, 4, 42 и 132 дня | O |

## Подтверждённые выводы

- BLOCK и GLOBAL переименовываются только записью `Name` в окне опций; LOGIC
  — записью `Name` в окне или `info.name` в коде, действует последняя из них.
  `scenario.update {name}` хаб принимает и игнорирует. То же для описания,
  «запуска при старте» и синхронизации: окно меняет, `scenario.update` — нет.
  Через `scenario.update` меняется только `data`.
- У LOGIC имя, описание и `onStart` после каждой записи кода снова берутся из
  `info`. Устойчивое переименование LOGIC — новый `info.name` в исходнике:
  `Name` окна держится только до следующей записи кода, и
  `logic_source_update` со старым `info.name` вернёт прежнее имя. Окно после
  записи кода показывает своё прежнее значение. У GLOBAL и BLOCK код имя не
  трогает.
- Окно опций LOGIC может не совпадать со сценарием (1.6, 1.7), а у встроенных
  LOGIC показывает заглушки (1.11). Текущие имя, описание и флаги читать из
  `scenario.get`, окно — только как место записи.
- Виртуальные выключатели, розетки, датчики (контакт, присутствие, движение,
  температура) и термостат создаются тем же `accessory.create`, что и лампа;
  несколько сервисов в одном аксессуаре допустимы. Состояние виртуального
  датчика записывается, хотя `write: false`. Продукт на `2e1c36e` требует
  `write: true` для записи значения и действия BLOCK (`characteristicContract`
  в `src/automation-service.mjs`), поэтому сейчас откажет.
- Связь «выключатель управляет лампой» — один `link.addVirtual` со стороны
  выключателя, значение идёт в обе стороны; `characteristic.update {hasLinks}`
  не нужен. Обработку связи
  задаёт `linkProcessing` на стороне IN. Удаление оставляет на цели пустой
  OUT, который `link.remove` не убирает. `hasLinks`, `linkProcessing`, как и
  `notify`, есть только в `accessory.get`.
- Пределы виртуальной характеристики пишутся `control.minValue/maxValue/minStep`,
  допустимые значения — `control.validValues` с флагом `checked`; запись за
  пределом хаб принимает и ограничивает границей, ответ этого не сообщает.
- Экспорт в мост — флажки `s:<sId>` в `<мост>/Child/<aId>/`; состояние по всем
  аксессуарам даёт `extensionChild.list` (`spaceKey`), по сервисам — окно.
  Запись флажка не проверялась.
- «Когда была последняя резервная копия» читается без записи из `Restore` окна
  настроек хаба. Создание — кнопка `CreateBackup` или `file.backups`; оба
  создают файл на хабе.

## Расхождения симулятора с хабом

Репетиция на `test/support/simulated-hub.mjs` показала поведение, которого на
хабе нет: симулятор отклоняет запись состояния виртуальных датчиков; не
применяет `control.minValue/maxValue/minStep`; применяет `scenario.update
{name, desc, onStart}` у LOGIC; не поддерживает `window.update` `Name`,
`OnStart`, `Sync`, `Desc` у LOGIC и `OnStart`, `Sync` у BLOCK; отдаёт
`hasLinks`, `linkProcessing` в `characteristic.get` и не выводит `hasLinks` из
связей; не оставляет пустой OUT после `link.remove`; не создаёт GLOBAL и
аксессуар с двумя сервисами; не отдаёт дочерние окна мостов.

## Ограничения

- Один хаб, одна прошивка, по одному прогону. Паузы чтения 0,4–1,2 с.
- Только виртуальные аксессуары. Пределы, допустимые значения и связи на
  физических устройствах не проверялись; запись значения, снятого из
  допустимых, тоже.
- `scenario.update` отправлялся без `type`, как это делает веб-клиент.
- Смысл `Sync` («Последовательное выполнение») и `OnStart` при работе
  сценария не проверялся: свои BLOCK не включались, хаб не перезапускался.
- Переименование LOGIC, назначенного сервису, не проверялось; имя типа
  следует за окном у включённого неназначенного LOGIC.
- Окна встроенных LOGIC только прочитаны.
- Запись экспорта (`s:<sId>`) и поведение моста с `AutoAddNewAccessory=true`
  не проверялись: нужно согласие владельца.
- Резервная копия: файл не создавался; ответ `file.backups`, событие `file` и
  загрузка частями известны только из кода.

## Артефакты

Этот файл. Скрипты пробы и их вывод — во временном каталоге сессии, в Git не
сохранялись; serial, токен, cid, имена и id дома не записывались.

## Влияние на дом

- Снимок имён и id комнат, аксессуаров (с сервисами), сценариев (с флагами) и
  ключей расширений до и после каждого прогона совпал: sha256 `c1a2ebe9aaad`;
  13 комнат, 81 аксессуар, 23 сценария, 9 расширений; объектов с префиксом
  прогона после уборки 0.
- Прогон 1: 290 запросов, из них 87 записей; прогон 2: 160 и 48. Все записи —
  в свои объекты: 2 комнаты, 11 виртуальных аксессуаров, 6 сценариев; всё
  удалено, удаление подтверждено по `room.list`, `accessory.list`,
  `scenario.list` и детям мостов. Чтения без записи: 0 записей.
- Свой LOGIC включался только с ничего не делающим кодом и без назначений;
  свои BLOCK не включались. Объекты владельца, окна мостов и настройки хаба
  не записывались; `extension.action` и `file.*` не вызывались.
