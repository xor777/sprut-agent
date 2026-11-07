# Карта действий владельца в веб-клиенте SprutHub

S20260924-web-client-action-map, 2026-09-24. Цель: перечислить, что владелец
делает в официальном веб-клиенте, какой нативный RPC отправляет каждое действие
и что из этого агент может сделать через sprut-agent. Доказательство RPC везде
`S` (client code). Живой хаб и облако не вызывались.

Колонка sprut-agent сверена с кодом на `main` a311bb6 (2026-11-06), живой хаб
при сверке не вызывался: есть 44, частично 22, нет 17, вне цели 15. Частота не
менялась. «Итог», п. 4 процедуры и «Ограничения» описывают прежний срез 1bd4c68.

Пометки о проверке взяты из заметок `research/protocol/`: «проверено на хабе» —
запись на своих временных объектах; «хаб только сохранил» — запись прочитана как
отправлена, исполнение не наблюдалось; «только по коду клиента» — записи на хабе
в заметках нет. Строка без пометки сверена только с кодом sprut-agent.

Ответы на отдельные вопросы о формате BLOCK, журнале, уведомлениях,
сопряжении и резервных копиях — в
[2026-09-24-web-client-evidence.md](2026-09-24-web-client-evidence.md).

## Источник

Публичная страница `https://beta.spruthub.ru/` без входа. HTML
`Last-Modified: Mon, 31 Aug 2026 11:05:16 GMT`. Файлы скачаны во временный
каталог сессии, в Git не сохранялись.

| URL | Байт | SHA-256 |
| --- | ---: | --- |
| `https://beta.spruthub.ru/` (HTML) | 2098 | `fb087214884dc9d1a5d000210534ddd184e06d0a16229c846957cd4f06eb9029` |
| `https://beta.spruthub.ru/js/runtime.74a7f4ffc5bcf4eddfff.js` | 2827 | `6e8bef12e60a1b401acf94b8d4d149015ab4b07faef2018a400a56785c34a206` |
| `https://beta.spruthub.ru/js/vendors.6502ff82393a9f4f45b5.js` | 7911146 | `f9813a51e9a7f86d334f025b90b5668c1aca01cddb12cdee4bb83c63d999fcec` |
| `https://beta.spruthub.ru/js/app.16735171810a795a9f2d.js` | 1348618 | `81c1ef74ce21eb5ccff583255ba82fe766ff4cf6bc251c0566b7bd67436647f8` |
| `https://beta.spruthub.ru/css/vendors.bc63d0bc9b71a87d66b9.css` | 138819 | `3fbf248da1a81d4b409ecc86f675459c82ce779bca73d17c37351a09cc0bb400` |
| `https://beta.spruthub.ru/css/app.e1511c32b1b6447097e7.css` | 395805 | `7510a52c8f4b6cf6fa8a1ff4dcfb6017986292622354268d119f09fb6f3a5bd3` |

Три JS-файла совпадают по URL и хэшу с
[2026-09-15-native-inventory/manifest.json](2026-09-15-native-inventory/manifest.json):
новой сборки с 15 сентября нет. Runtime подгружает только chunk 96
(`js/96.f801a781daf8b582d871.js`), это загрузчики языков Monaco; он не
скачивался. CSS не анализировался.

## Процедура

1. `app.js` переформатирован локальным esbuild без изменения смысла. Имена
   Vue-компонентов сохранены в `__name` (477 вхождений), они и служат
   ссылками «где в UI».
2. Все запросы идут через TanStack Query: `queryKey: ["domain.op", params]`
   для чтения и `mutationKey: ["domain.op"]` для записи. Общий `queryFn` и
   `mutationFn` передают ключ как метод, а JSON-кодек отправляет
   `params: {domain: {op: payload}}` и разворачивает ответ на два уровня.
   Найдено 59 мест `mutationKey` (58 методов), 60 мест `queryKey`
   (39 методов) и один прямой вызов `request("hub.connection")`. Обёртка
   опций `$X` отправляет `{...ids, options:[{key, value}]}` для
   `window.update`, `characteristic.setOptions` и `logic.setOptions`.
3. Для каждого `mutate` найден владеющий компонент и payload. Подписи взяты
   из встроенных `en-US.json`/`ru-RU.json`.
4. Покрытие сверено с `src/server.mjs`, перечнем операций
   `prepare_native_change`, `src/block-model.mjs`,
   `src/native-option-contract.mjs` и клиентскими вызовами в
   `src/spruthub-client.mjs` на 1bd4c68.

Большая часть настроек расширений, устройств контроллеров, хаба и сценариев
в 3.x приходит от сервера как окно: `window.get {windowKey}` и
`window.update {windowKey, options:[{key, value}]}`. Клиент рисует поля по
`inputType` (`FOLDER`, `BUTTON`, `BUTTON_DANGER`, `LIST`, `TEXT`, `NUMBER`,
`CHECKBOX`, `ACCESSORY_LIST`, `WINDOW`, `EXTENSION` и др.). Какие именно поля
и кнопки есть в окне, по client code не определить; строка карты описывает
окно как одно действие.

## Обозначения

- Частота — оценка для обычного дома: ежедневно, еженедельно, настройка
  (при появлении устройства или сценария), редко-админ.
- Покрытие: «есть» — инструмент или операция выполняет действие; «частично»
  — только часть вариантов; «нет»; «вне цели» — вид веб-клиента, аккаунт,
  медиапоток или разрушительное действие аккаунта.
- R/W — чтение или запись в доме.

## A. Состояние и управление устройствами

| № | Действие, компонент | RPC и payload | R/W | Частота | sprut-agent |
| --- | --- | --- | --- | --- | --- |
| A1 | Комнаты и карточки с текущими значениями; `Rooms`, `RoomServices`, `ServiceGrid` | `room.list`; `accessory.list {roomId, expand:"services,characteristics"}` | R | ежедневно | есть: `home_overview`, `find_devices` |
| A2 | Включить, яркость, позиция, уставка; `ServiceCard*`, `CharacteristicControl`, `CharacteristicPreviewScreen` | `characteristic.update {aId,sId,cId,control:{value}}` | W | ежедневно | есть: `send_device_commands`, `characteristic_value`; проверено на хабе |
| A3 | Карточка устройства; `AccessoryScreen` | `accessory.get {id, expand:"services,characteristics"}` | R | ежедневно | есть: `get_entity` |
| A4 | Лента событий устройства; `HistoryScreen` | `history.list {filter:{accessories:[{aId}]}, limit:50}`, далее `afterId` = id последней записи | R | еженедельно | нет: `history.list` не вызывается; рядом только короткий буфер `read_hub_log` и свои изменения в `get_native_change`; на этом хабе `history.list` не отдавал данных (live-conformance-2) |
| A5 | График характеристики за час/день/неделю; `CharacteristicPreviewScreen`, `ChartItem` | `history.list {filter:{accessories:[{aId,sId,cId}]}, beforeTimestamp, afterTimestamp, group}` | R | еженедельно | нет: `history.list` не вызывается; `read_hub_log` `watch` видит только события вперёд |
| A6 | Видео камеры, PTZ, снимок; `Camera` | `accessory.stream {id, action, sdp, candidates, mid, streamId, session, ptz}` | R/W | ежедневно при камерах | вне цели (медиапоток) |
| A7 | Громкость динамика и микрофона камеры; `CameraControl` | `characteristic.update {…, control:{value}}` | W | редко | есть: `characteristic_value`, `send_device_commands`; на камере не проверялось |
| A8 | Информация об устройстве и характеристике; `AccessoryInfoScreen`, `CharacteristicInfoScreen` | данные `accessory.get` | R | редко | есть: `get_entity` |
| A9 | Скопировать support info устройства; `CopyAccessoryInfo` | `accessory.supportInfo {id}` | R | редко-админ | нет |
| A10 | Сценарии с этим устройством; `ScenariosScreen` | `scenario.list {aId}` | R | еженедельно | есть: `get_entity` include `relations` |

## B. Настройка устройства (меню `SettingsScreen`)

| № | Действие, компонент | RPC и payload | R/W | Частота | sprut-agent |
| --- | --- | --- | --- | --- | --- |
| B1 | Перенести в комнату; `AccessoryRoomScreen` | `accessory.update {id, roomId}` | W | настройка | есть: `accessory_placement`; проверено на хабе |
| B2 | Переименовать устройство; `RenameScreen` | `accessory.update {id, name}` | W | настройка | есть: `accessory_placement`; проверено на хабе |
| B3 | Переименовать сервис; `RenameScreen` | `service.update {aId,sId,name}` | W | настройка | есть: `service_name`; проверено на хабе |
| B4 | Скрыть или показать сервис («Рабочий стол»); `GridSettingsScreen` | `service.update {aId,sId,visible}` | W | настройка | есть: `service_visible`; только по коду клиента |
| B5 | Настройки аксессуара (характеристики-опции); `OptionsScreen` | `characteristic.update {…, control:{value}}` | W | настройка | есть: `characteristic_value` |
| B6 | Настройка характеристики; `CharacteristicOptionsScreen` | `characteristic.getOptions`; `characteristic.setOptions {aId,sId,cId,options:[{key,value}]}` | W | настройка | есть: `characteristic_option` (NUMBER, CHECKBOX, LIST); только по коду клиента |
| B7 | Настройки физического устройства; `SettingsScreen` → `WindowScreen(deviceWindow)` | `window.get`/`window.update {windowKey, options:[{key,value}]}` | W | настройка | частично: чтение `physical_configuration`; `window_option` пишет только NUMBER, CHECKBOX, LIST, запись проверена на хабе на одной лампе; TEXT и кнопок нет |
| B8 | Уведомлять об изменении характеристики и о выходе из сети; `NotificationsScreen` | `characteristic.update {aId,sId,cId,notify}`, для «в сети» — характеристика `C_Online` | W | настройка | есть: `characteristic_notify` (и `C_Online`), чтение `find_devices` `notify`; проверено на хабе на своём виртуальном аксессуаре; доставка сообщения не наблюдалась |
| B9 | Назначить логику сервису; `ServiceLogicsScreen` | `logic.types`, `logic.list {aId,sId}`; `logic.create {aId,sId,type}` | W | настройка | есть: `logic_assignment`; проверено на хабе |
| B10 | Включить или выключить логику; `LogicOptionsScreen` | `logic.update {aId,sId,type,active}` | W | еженедельно | есть: `logic_active`; проверено на хабе сырой записью `logic.update` |
| B11 | Параметры логики; `LogicOptionsScreen` | `logic.getOptions`; `logic.setOptions {aId,sId,type,options}` | W | настройка | есть: `logic_option`; `logic.setOptions` воспроизведён на хабе (2026-09-10-native-logic) |
| B12 | Удалить логику; `LogicOptionsScreen` | `logic.delete {aId,sId,type}` | W | редко | частично: только restore своей `logic_assignment` |
| B13 | Экспорт устройства в мост; `BridgesScreen` → окно `<extensionKey, «:» заменено на «/»>/Child/<aId>/` | `extension.list {bundleType:"BRIDGE"}`; `window.get`/`window.update` | W | настройка | есть: `get_entity` include `bridges` даёт `window_ref` и ключи `s:<sId>`, пишет `window_option`; проверено на хабе на своём виртуальном Switch (через продукт — незапущенные мосты, сырой записью — работающий Яндекс); физические устройства и приложение ассистента не проверялись |
| B14 | Связать характеристики; `CharacteristicLinksScreen`, `CharacteristicLinkScreen` | `link.list`; `link.addVirtual {aId,sId,cId,tAId,tSId,tCId}`; `link.remove {linkId,aId,sId,cId}`; `characteristic.update {hasLinks}` | W | настройка | частично: только группа света `virtual_light_group` (создание, смена ламп), проверено на хабе; произвольной связи нет |
| B15 | Обработка связей (последнее, мин., макс., среднее, синхронизация); `CharacteristicLinksScreen` | `characteristic.update {linkProcessing}` | W | редко | нет (`linkProcessing` только читается) |
| B16 | Создать виртуальное устройство; `VirtualMainScreen`, `VirtualServiceConfigScreen` | `accessory.create {name, roomId, services:[{type,name,optional}]}` | W | настройка | частично: `virtual_device` (12 типов, один сервис, без дополнительных характеристик) и `virtual_light_group`, проверено на хабе; остальных несистемных типов и нескольких сервисов нет |
| B17 | Пределы и допустимые значения виртуальной характеристики; `CharacteristicVirtualSettingsScreen` | `characteristic.update {control:{minValue,maxValue,minStep}}` или `{control:{validValues}}` | W | редко | нет |
| B18 | Удалить устройство; `DeleteAccessory` | `accessory.delete {id}` | W | редко | частично: `virtual_device_delete` только виртуальные, проверено на хабе; физические — отказ `not_a_virtual_device` |
| B19 | Характеристики в строке состояния; `StatusBarSettingsScreen` | `characteristic.update {statusVisible}` | W | настройка | вне цели (вид UI) |
| B20 | Характеристика как опция на экране управления; `ShowAsOptionScreen` | `characteristic.update {option}` | W | настройка | вне цели (вид UI) |
| B21 | Порядок сервисов в устройстве; `ReorderScreen` | `service.orders {orders:[{aId,sId,order}]}`, order с 0 | W | редко | вне цели (вид UI) |
| B22 | Размер плитки камеры; `GridTileSizeScreen` | `service.update {aId,sId,grid:{width,height}}` | W | редко | вне цели (вид UI) |

## C. Комнаты

| № | Действие, компонент | RPC и payload | R/W | Частота | sprut-agent |
| --- | --- | --- | --- | --- | --- |
| C1 | Создать комнату; `CreateRoomModal` | `room.create {name}` | W | настройка | есть: `room_create`; проверено на хабе |
| C2 | Переименовать комнату; `UpdateRoomModal` | `room.update {id, name}` | W | настройка | есть: `room_name`; проверено на хабе |
| C3 | Удалить комнату; `UpdateRoomModal` | `room.delete {id}` | W | редко | частично: только restore комнаты, созданной агентом |
| C4 | Показывать комнату; `UpdateRoomModal` | `room.update {id, visible}` | W | редко | вне цели (вид UI) |
| C5 | Порядок комнат; `Rooms` | `room.orders {orders:[{id,order}]}`, order с 1 | W | редко | вне цели (вид UI) |
| C6 | Порядок карточек в комнате; `ServiceGrid` | `service.orders {orders:[{aId,sId,grid:{order}}]}`, order с 1 | W | редко | вне цели (вид UI) |
| C7 | Группировка и скрытые устройства; `RoomViewConfigModal` | локальные настройки клиента | — | редко | вне цели (вид UI) |

## D. Сценарии

| № | Действие, компонент | RPC и payload | R/W | Частота | sprut-agent |
| --- | --- | --- | --- | --- | --- |
| D1 | Список сценариев, отметка активности; `Scenarios`, `ScenarioItem` | `scenario.list` | R | еженедельно | есть: `home_overview` с `list=scenarios` |
| D2 | Создать BLOCK; `ScenariosPlusModal` | `scenario.create {type:"BLOCK", name:"", desc:"", onStart:true, active:true, sync:false, data:""}` | W | настройка | есть: `block_create`; проверено на хабе |
| D3 | BLOCK: триггер по характеристике и «держится N»; `Condition` | узел `characteristic` в `data` | W | настройка | есть: `block_create`, `block_data_update`: `timeCond` `">"` и `"<"`; хаб только сохранил |
| D4 | BLOCK: время по дням недели; `Cron` | `cron:"0 MM HH ? * DAYS *"`, `mode:"NONE"` | W | настройка | есть: `time_trigger` `days_at_time`; хаб сохранил, сработка наблюдалась для ежедневного времени |
| D5 | BLOCK: восход или закат со смещением; `Cron`, `TimeOffset` | `mode:"SUNRISE"/"SUNSET"`, `cron:"0 0 0 ? * DAYS *"`, `offset` в секундах | W | настройка | есть: `time_trigger` `sun`, `offset` в секундах; хаб только сохранил |
| D6 | BLOCK: каждые N часов, минут или секунд; `Cron` | `mode:"NONE"`, `0/N` в поле часов, минут или секунд | W | настройка | есть: `time_trigger` `every_n_hours`, `every_n_minutes`, `every_n_seconds`; хаб только сохранил минуты, часы и секунды только по коду клиента |
| D7 | BLOCK: интервал времени по дням недели; `Interval` | `interval.start`/`end` cron с DAYS | W | настройка | частично: только ежедневный интервал, один на BLOCK |
| D8 | BLOCK: условие или действие «Код»; `Code` | `{type:"code", code}` | W | настройка | частично: `code` в действиях, проверено на хабе на своём BLOCK; код в условии не пишется, только сохраняется при правке |
| D9 | BLOCK: установить, переключить, увеличить, уменьшить; `Operation` | `service.characteristics[].type` = `set`/`toggle`/`inc`/`dec` | W | настройка | есть: `set`, `toggle`, `inc`, `dec`; `set` исполнялся, остальные хаб только сохранил |
| D10 | BLOCK: установить значение из другой характеристики; `FromService` | `type:"from"`, `from_aId`, `from_sId`, `from_cId`, `from_hs`, `from_hc` | W | настройка | есть: `from`; хаб только сохранил |
| D11 | BLOCK: задержка и её сброс; `Delay`, `ClearDelay` | `{type:"delay", index, mode, time, targets}`, `{type:"clear_delay", index}` | W | настройка | есть: `delay`, `clear_delay`, в том числе `index:0`; хаб только сохранил, `index:0` только по коду клиента |
| D12 | BLOCK: если/иначе, EVERY или ONCE; `Fork` | `{type:"if", mode, if, then, else}` | W | настройка | есть: `if`, `EVERY`, `ONCE`; `ONCE` хаб только сохранил |
| D13 | BLOCK: повторять ветку каждые N; `Fork` | `then_delay`, `else_delay` в мс | W | настройка | есть: `then_delay`, `else_delay` от 1000 мс; хаб только сохранил |
| D14 | BLOCK: запустить другой сценарий; `RunScenario` | `{type:"scenario", index, mode:"FIRE"}` | W | настройка | есть: `scenario` `FIRE`; хаб только сохранил |
| D15 | BLOCK: активировать, деактивировать, активировать и запустить, сбросить другой сценарий; `RunScenario` | `mode` = `ACTIVATE`/`DEACTIVATE`/`ACTIVATE_AND_FIRE`/`RESET` | W | настройка | есть: `scenario` `ACTIVATE`, `DEACTIVATE`, `ACTIVATE_AND_FIRE`, `RESET`; хаб только сохранил |
| D16 | BLOCK: уведомление; `Notify` | `{type:"notify", text, mode, to}` | W | настройка | есть: `notify` `MESSAGE`, `PUSH`; хаб только сохранил, отправка не наблюдалась |
| D17 | BLOCK: HTTP-запрос; `Http` | `{type:"http", method, url}` | W | настройка | есть: `http`; URL с логином или паролем отклоняется; хаб только сохранил, запрос не наблюдался |
| D18 | Сохранить BLOCK; `Edit` | `scenario.update {index, data}` (JSON-строка), `name` только при изменении | W | еженедельно | есть: `block_data_update`; проверено на хабе |
| D19 | Название и описание; `ScenarioSettings` (окно `optionsWindow`) | `window.update {windowKey, options:[{key,value}]}` | W | редко | частично: BLOCK и GLOBAL — `window_option` Name/Desc, LOGIC — `info` через `logic_source_update`; проверено на хабе; TEMPLATE, SKILL, встроенные — отказ |
| D20 | Включить или выключить сценарий; `ScenarioSettings` | `window.update` одной опции окна сценария | W | еженедельно | есть: `scenario_active` пишет опцию `Active` окна, как веб-клиент; проверено на хабе для BLOCK и LOGIC; встроенные — отказ |
| D21 | Остальные опции окна сценария (запуск при старте, синхронность и др.); `ScenarioSettings` | `window.update` | W | редко | частично: `window_option` OnStart, Sync (у LOGIC OnStart — в `info` кода, Sync — в окне); проверено на хабе сырой записью; TEMPLATE, SKILL, встроенные — отказ |
| D22 | Запустить сейчас; `ScenarioBlock` (play), `ScenarioCode` («Запустить») | `scenario.run {index}` | W | еженедельно | частично: `scenario_run` только для включённых BLOCK и пользовательских LOGIC, UI это не проверяет; GLOBAL, встроенные и другие — отказ; проверено на хабе для BLOCK |
| D23 | LOGIC: создать и править код; `ScenariosPlusModal`, `ScenarioCode` | `scenario.create {type:"LOGIC", …}`; `scenario.update {index, data}` | W | настройка | есть: `logic_source_create`, `logic_source_update`; проверено на хабе |
| D24 | GLOBAL, TEMPLATE, SKILL: создать и править; `ScenariosPlusModal`, `ScenarioCode` | `scenario.create {type}`; `scenario.update {index, data}` | W | редко | частично: `logic_source_update` правит код существующего GLOBAL, проверено на хабе; создания GLOBAL, TEMPLATE, SKILL нет |
| D25 | Удалить сценарий; `Edit` | `scenario.delete {index}` | W | редко | частично: `scenario_delete` BLOCK, LOGIC, GLOBAL, проверено на хабе; встроенные и другие типы — отказ |
| D26 | Импорт из файла; `ScenariosPlusModal` | `scenario.create(scenarioTemplate)` после проверки JSON-схемой | W | редко | частично: `block_create` в рамках контракта, `logic_source_create` с готовыми данными; GLOBAL, TEMPLATE, SKILL нет |
| D27 | Экспорт шаблона, файл, картинка; `Edit` | без RPC | R | редко | есть: `get_entity` include `configuration`; URL HTTP и похожее на секрет скрыты |
| D28 | Живая подсветка сработавших блоков; `Edit` | `scenario.subscribe {index}`; `scenario.unsubscribe {uuid}` | R | еженедельно | есть: `read_hub_log` `watch` |
| D29 | JavaScript API сценариев; `ScenarioBlock`, `ScenarioCode` | `scenario.sdk` | R | редко | есть: `get_entity` include `sdk` |

## E. Расширения, контроллеры, сопряжение

| № | Действие, компонент | RPC и payload | R/W | Частота | sprut-agent |
| --- | --- | --- | --- | --- | --- |
| E1 | Список расширений и их состояние; `ExtensionList` | `extension.list` | R | еженедельно | есть: `home_overview` `list=extensions` |
| E2 | Настройки расширения; `ExtensionSettings` | `window.get`/`window.update {windowKey: extension.optionsWindow}` | W | настройка | частично: `window_option` NUMBER, CHECKBOX, LIST; TEXT и кнопок нет; `AutoAddNewAccessory` моста закрыт |
| E3 | Рабочее окно плагина; `ExtensionSpacePlugin` | `window.get`/`window.update {windowKey: extension.mainWindow}` | W | настройка | частично: скаляры `window_option`; TEXT и кнопок нет |
| E4 | Устройства контроллера, в сети ли, прогресс; `ExtensionSpaceGeneric` | `extensionChild.list {extensionKey}`, события `extensionChild` | R | еженедельно | есть: `get_entity` include `children` |
| E5 | Окно устройства контроллера; `ExtensionChild` | `window.get`/`window.update {windowKey: child.optionsWindow}` | W | настройка | частично: скаляры `window_option`; TEXT и кнопок нет |
| E6 | Кнопки пространства: поиск, сопряжение, переключатели; `ExtensionSpaceGeneric` | `extension.action {extensionKey, spaceKey, actionId, state?}` | W | настройка | частично: `device_search` (старт и стоп `ACTION_DISCOVERY` вкладки `main`), `get_device_search`; старт и стоп проверены на хабе без устройства, настоящее сопряжение нет; ZLL-поиск — отказ, остальных кнопок нет; нужен и физический шаг |
| E7 | Диалог действия `ACTION_OPTIONS`; `ExtensionSpaceGeneric` → `WindowScreen(action.windowKey)` | `window.get`/`window.update` | W | настройка | частично: `get_entity` отдаёт `window_ref` действия, скаляры `window_option`; TEXT и кнопок нет; только по коду клиента, окно на хабе не открывалось |
| E8 | Кнопки окон (`BUTTON`, `BUTTON_DANGER`): удалить, лечить, прошивка, проверка; `OptionControl` | `window.update {windowKey, options:[{key,value}]}` | W | редко | нет: `get_entity` показывает кнопки в `commands`, `window_option` отказывает (`unsupported_input_type`) |
| E9 | Установить расширение из магазина; `BundlesModal`, `BundleListScreen` | `bundle.install {bundleId}`; корень `bundle` в proto помечен удалённым | W | редко-админ | нет |
| E10 | Обновить расширение, добавить экземпляр, перезапуск; `BundleConfigScreen` | `bundle.update {bundleId}`; `bundle.createInstance {bundleId}`; `hub.restart {}` | W | редко-админ | нет |

## F. Уведомления

| № | Действие, компонент | RPC и payload | R/W | Частота | sprut-agent |
| --- | --- | --- | --- | --- | --- |
| F1 | Службы уведомлений и получатели; `ExtensionSpaceGeneric`, `ExtensionChild` | `extension.list {bundleType:"NOTIFICATION"}`; `extensionChild.list {extensionKey:"Notification:<index>"}`; окна детей | R/W | настройка | частично: чтение `home_overview`, `get_entity` include `children`; настройка окон только скаляры; кнопок (`TestSend`, вход и выход) нет |

Отправка из сценария — D16, флаги уведомлений устройства — B8.

## G. Хаб и обслуживание

| № | Действие, компонент | RPC и payload | R/W | Частота | sprut-agent |
| --- | --- | --- | --- | --- | --- |
| G1 | Настройки хаба по разделам; `Settings`, `SettingsSection` | `window.get`/`window.update {windowKey: hub.optionsWindow}` | W | редко-админ | частично: чтение есть, запись закрыта намеренно |
| G2 | Сведения о хабе; `HubAdminInfo` | `hub.list`, `hub.get` | R | редко | есть: `home_overview` (прошивка) |
| G3 | Обновить ПО; `HubAdmin` | `hub.upgrade {serial}` | W | редко-админ | нет |
| G4 | Перезагрузить; `HubAdmin` | `hub.restart {serial}` | W | редко-админ | нет |
| G5 | Скачать резервную копию; `MenuHubActions` → `SystemDownloadModal` | `file.backups {}`, событие `file`, `file.filePart {path,start,length}`, `file.complete {path}` | R | редко-админ | нет |
| G6 | Скачать логи и отладочную информацию; `SystemDownloadModal` | `file.logs {}`, `file.devInfo {}`, тот же поток | R | редко-админ | нет |
| G7 | Скопировать support info хаба; `MenuHubActions` | `hub.supportInfo {serial}` | R | редко | нет |
| G8 | Мониторинг системы; `SystemMonitorScreen` | `hub.pool` | R | редко | нет |
| G9 | Панель «Отладка»; `SystemLogger` | `log.list {count:200}`; `log.subscribe {}`; `log.unsubscribe {uuid}` | R | еженедельно | есть: `read_hub_log`, `watch` |
| G10 | Записать строку в журнал; `SystemLogger` | `log.print {level:"LOG_LEVEL_INFO", path:"", message}` | W | редко | нет |
| G11 | Справка по разделу; `MenuHubActions` | `window.get {windowKey:"Help<путь>"}` | R | редко | нет: `get_entity` прочитал бы окно, но ключ `Help…` ни один инструмент не выдаёт |
| G12 | Справочник типов; `ServiceTypes`, `ServiceType` | `service.types`, `characteristic.types` | R | редко | частично: типы видны у сущностей; `service.types` только внутри создания виртуальных, справочника нет |
| G13 | Шаблоны устройств; `Catalogs`, `CatalogTemplate`, `CatalogCreateModal` | `catalog.list/get/types/scheme`; `catalog.create {controller, template}`; `catalog.update {template, store, controller, file}`; `catalog.delete {store, controller, file}` | W | редко-админ | нет |
| G14 | Отвязать хаб от аккаунта; `HubAdmin` | `hub.delete {serial}` | W | редко | вне цели (разрушительно для доступа) |
| G15 | Привязать хаб по QR; `Hubs`, `NewHubListener` | `hub.addCheck`, `hub.add {hwMac, hwSerial}` | W | настройка | вне цели (облако, QR на корпусе) |

## H. Вид веб-клиента и аккаунт

| № | Действие, компонент | RPC и payload | R/W | Частота | sprut-agent |
| --- | --- | --- | --- | --- | --- |
| H1 | Дашборды; `CreateDashboardModal`, `UpdateDashboardModal` | `dashboard.create/update/delete` | W | редко | вне цели |
| H2 | Колонки и виджеты; `Dashboard`, `WidgetConfigModal`, `ReorderScreen` | `dashboardColumn.create/delete/orders`, `dashboardWidget.create/update/delete/orders` | W | редко | вне цели |
| H3 | Вход, профиль, выход; `LoginForm`, `SettingsUser` | `account.auth`, `account.answer`, `account.get` | W | редко | вне цели |
| H4 | Тема, язык, уведомления браузера, имя клиента; `SettingsPersonal`, `SettingsNotifications`, `SettingsOther` | `server.clientName`, `server.clientInfo`, `server.notificationDisabled`, `server.enableProto`, локально | W | редко | вне цели |

## Итог

98 действий: есть 34, частично 21, нет 28, вне цели 15.

Самые частые из отсутствующих (оценка частоты, не измерение):

1. A4 — лента событий устройства (`history.list` по `aId`).
2. A5 — история значений характеристики за период (`history.list` с `group`).
3. D16 — уведомление из BLOCK.
4. B8 — уведомлять об изменении характеристики и о выходе устройства из сети.
5. E6 — поиск и сопряжение нового устройства (`extension.action`).
6. E7 — диалоги действий расширения (`ACTION_OPTIONS`).
7. E8 — кнопки окон: удалить устройство из сети, лечить, обновить прошивку.
8. D6 — периодический триггер «каждые N».
9. D15 — включить или выключить другой сценарий из BLOCK.
10. D10 — установить значение из другой характеристики.
11. D13 — повтор ветки «каждые N».
12. D17 — HTTP-запрос из BLOCK.
13. D8 — блоки «Код».
14. G5 — резервная копия.
15. G3 — обновление ПО хаба.

Среди частичных самое важное — D5: смещение восхода и заката. Клиент хранит
его в секундах, sprut-agent публикует минуты (подробно в evidence, п. 1).
Остальные частичные строки — ограничения охвата, а не расхождения формата.

`history.list` в proto имеет `includeContexts` с цепочкой причин события
(`HistoryContext`); веб-клиент его не передаёт. Это кандидат для ответа
«почему включился свет», но поведение не наблюдалось.

## Ограничения

- Только client code одной сборки. Нет живых наблюдений, нет проверки, что хаб
  принимает все payload так, как их шлёт клиент.
- Содержимое серверных окон (поля, кнопки, ключи опций) из client code не
  выводится. Строки B7, B13, D19–D21, E2–E8, F1, G1 зависят от окон конкретного
  дома и расширений.
- Покрытие оценено по коду и описаниям инструментов на 1bd4c68, без прогона
  агента.
- Частота — оценка.

## Артефакты

Этот файл и [2026-09-24-web-client-evidence.md](2026-09-24-web-client-evidence.md).
Скачанные файлы и переформатированный `app.js` в Git не сохранялись.

## Влияние на дом

Не изменялось. Хаб, облако и аккаунт не вызывались.
