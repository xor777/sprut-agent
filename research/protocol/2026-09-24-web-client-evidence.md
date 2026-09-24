# Ответы веб-клиента на открытые вопросы протокола

S20260924-web-client-evidence, 2026-09-24. Цель: закрыть догадки sprut-agent
о BLOCK, окнах сценариев, журнале, уведомлениях, сопряжении и резервных копиях
тем, что делает официальный веб-клиент. Все выводы — уровень `S` (client
code). На хабе ничего не наблюдалось; что хаб делает с этими payload, остаётся
открытым.

Источник, хэши и процедура — в
[2026-09-24-web-client-action-map.md](2026-09-24-web-client-action-map.md):
`app.16735171810a795a9f2d.js`, SHA-256
`81c1ef74ce21eb5ccff583255ba82fe766ff4cf6bc251c0566b7bd67436647f8`.
Цитаты ниже — минифицированные идентификаторы и литералы этого файла после
переформатирования; подписи — из встроенного `ru-RU.json`.

Кроме компонентов, в клиенте есть JSON-схема данных BLOCK (объекты с
`$id: "http://makesimple.org/schema/…"`). Клиент проверяет ею только импорт
сценария из файла (`ScenariosPlusModal`), не сохранение из редактора.

## 1. Расписание BLOCK (`cron`)

Уровень: S. Компоненты `Cron`, `TimeOffset`, `Interval`, `Operations`.

- Формат — семь полей Quartz, секунды первыми. Новый узел:
  `{ type: "cron", mode: "NONE", cron: "0 0 12 ? * * *", offset: 0 }`.
  Время пишется так: `t3[2] = "" + Number(n3[0]), t3[1] = "" + Number(n3[1])`,
  то есть поле 1 — минуты, поле 2 — часы, поле 0 — секунды.
- Дни недели — только имена в поле 5:
  `(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"])`,
  чтение `_2(o2.data.cron.split(" ")[5])`. Числа 1–7 или 0–6 клиент не пишет
  и не читает. При чтении понимает `*`, списки через запятую и диапазоны
  `A-B`, включая переход через воскресенье. Пишет список через запятую в
  порядке MON..SUN; семь дней записывает как `"*"`
  (`6 === t4.length ? "*"`); снять последний день нельзя.
- Дата одного дня: клиент никогда не пишет поля 3, 4 и 6 и не читает их.
  Форму `0 MM HH D M ? YYYY` интерфейс не создаёт; если такой узел есть,
  интерфейс покажет ноль выбранных дней, а нажатие на день запишет имя в поле
  5 при числе в поле 3. Принимает ли хаб такую строку — из клиента не
  определить.
- Восход и закат: `mode` `"SUNRISE"`/`"SUNSET"`. При выборе режима клиент
  ставит `offset: 0` и обнуляет время: `t3[2] = e3 === Gk ? "12" : "0",
  t3[1] = "0", t3[0] = "0"`, получается `0 0 0 ? * DAYS *`; дни сохраняются.
- `offset` — секунды. `TimeOffset` раскладывает `Math.abs(t2.offset)` на
  часы, минуты и секунды и собирает обратно как
  `n3 * (r3 + 60 * i3 + 60 * o3 * 60)`; поля ввода: часы `min: 0, max: 12`,
  минуты `max: 59`, подписи «ч», «мин», «сек».
- Знак: отрицательный — «До» (`"dec"`), неотрицательный — «После» (`"inc"`):
  `d2 = o2.data.offset < 0 ? "dec" : "inc"`. Переключение на «До» при нуле
  ставит `-3600`, то есть час до события.
- «Каждые N» не имеет отдельного `mode`: остаётся `"NONE"`, а в поле пишется
  `0/N`. Часы: `i3[2] = "0/" + n3, i3[1] = "0", i3[0] = "0"`, N из
  `[1, 2, 3, 4, 6, 8, 12]`. Минуты: `i3[2] = "*", i3[1] = "0/" + n3,
  i3[0] = "0"`; секунды: `i3[2] = "*", i3[1] = "*", i3[0] = "0/" + n3`, N из
  `[1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30]`.
- Интервал (`Interval`) выбирает дни на `start`. Если конец раньше начала
  (через полночь), дни `end` сдвигаются на следующий день:
  `r2.value[(t3 + 6) % 7]`.

Сравнение с 1bd4c68: `src/block-model.mjs` задаёт `SUN_OFFSET` с
`unit: "minutes"`, `minimum: -720`, `maximum: 720`. Клиент хранит секунды,
а поле часов ограничено 12, то есть порядка ±43200. Запрос «за 30 минут до
заката» из sprut-agent даст `offset: -30`, и по клиентской трактовке это
30 секунд. Формы `days_at_time` и `sun` совпадают с клиентом; `one_date`
клиент не создаёт; «каждые N» и дни недели у интервала sprut-agent не
принимает.

## 2. «Держится N» у условия по характеристике

Уровень: S. Компоненты `Condition`, `TimeDelay`, панель условий.

- `timeCond` — строка из трёх значений:
  `j2 = [{ value: "" … }, { value: ">" … }, { value: "<" … }]`. Подписи:
  `""` — «Условие применяется сразу»; `">"` — «Более», подсказка «И не
  менялось в течение»; `"<"` — «Менее», подсказка «И поменялось на обратное
  в течение».
- `time` — миллисекунды. `TimeDelay` показывает минуты
  `Math.floor((t2.time ?? 0) / 6e4)` и секунды остатком `/ 1e3`, пишет
  `6e4 * Math.floor(Number(e3)) + Math.floor(1e3 * s2.value)`.
- Поле показывается только при `null != t2.condition.timeCond`. Условие,
  добавленное из панели условий, получает `timeCond: "", time: 0` и
  `trigger: t2.level <= 1`.

Сравнение с 1bd4c68: `CHARACTERISTIC_HOLD` (`">"`, миллисекунды) совпадает с
клиентом. Вариант `"<"` sprut-agent не принимает.

## 3. Режимы `if` и задержек

Уровень: S. Компоненты `Fork`, `Delay`, `ClearDelay`, `Edit`, `Operations`.

- Новый `if` создаётся без `mode`:
  `{ type: "if", if: { type: "condition", mode: "OR", conditions: [] },
  then: [], else: null }`. Клиент считает режимом ONCE только
  `"ONCE" === t2.fork.mode`, поэтому отсутствие `mode` показывается как EVERY.
  Переключатель пишет `{ mode: y2.value ? "EVERY" : "ONCE" }` и при переходе
  на ONCE добавляет `state: null`.
- Подсказки: EVERY — «Блоки Тогда и Иначе выполняются при каждой проверке
  условия»; ONCE — «Блоки Тогда и Иначе выполняются только при изменении
  условия».
- `then_delay` и `else_delay` — период повтора ветки в миллисекундах: вариант
  «Каждые» включает `1e3`, «Без периода» пишет `0`.
- Задержка: `[{ value: "RESET", text: … }, { value: "CONTINUE", text: … }]`,
  подписи «Один таймер» и «Новый таймер». Новая задержка:
  `{ type: "delay", time: 0, mode: "RESET", targets: [] }`. `time` в
  миллисекундах: `item: { time: 1e3 * e3 }` из того же `TimeOffset` (часы,
  минуты, секунды). `index` редактор назначает сам: наименьшее свободное целое
  от 1 (`let e3 = 1; for (; S2.value.includes(e3); ) e3 += 1`).
- Сброс задержки: `{ type: "clear_delay", index: 0 }` при создании, в списке
  есть «Все задержки» со значением `0` и индексы существующих задержек. При
  удалении задержки редактор удаляет и `clear_delay`, указывающие на неё.

Сравнение с 1bd4c68: EVERY/ONCE совпадают. Текст sprut-agent для CONTINUE —
`new_entry_keeps_the_running_delay_expected_not_observed`; подпись клиента
«Новый таймер» говорит, что новое срабатывание запускает ещё один таймер.
Если это так, действия выполнятся по разу на каждое срабатывание, а не один
раз. Это вывод из подписи, не из поведения хаба. `clear_delay` с `index: 0`
(сброс всех задержек) sprut-agent отклоняет; `then_delay`/`else_delay`
фиксирует нулём.

## 4. Как клиент включает и выключает сценарий

Уровень: S. Компоненты `ScenarioItem`, `ScenarioSettings`, `Edit`,
`ScenarioCode`.

- В списке активность только показывается: точка с подсказкой
  `scenario.list_item.active`/`not_active`, без обработчика.
- `scenario.update` вызывается ровно в двух местах. `Edit` (BLOCK) отправляет
  `{ index: a2.scenarioId }` и только изменённые ключи из
  `tk()(e3, ["name", "data"])`, `data` как JSON-строку. `ScenarioCode`
  отправляет `{ index, data }`.
- Флаги `desc`, `active`, `onStart`, `sync` редактор держит только для
  чтения (`tk()(e3, ["desc", "active", "onStart", "sync"])`). Меняются они в
  `ScenarioSettings`: `{ windowKey: n2.scenario.optionsWindow }`,
  `l2 = Gp(r2)`, `l2.mutate([e3])`, то есть
  `window.update {windowKey, options:[{key, value}]}` по одной опции за раз,
  без других полей.
- Ключ опции активности задаёт сервер; из клиента он не определяется.

Сравнение с 1bd4c68: `scenario_active` пишет `scenario.update {index, active}`.
Поле `active` есть в `ScenarioUpdateRequest`, но клиент этим путём флаг не
меняет. Совпадение результата двух путей на хабе нужно проверить живым
чтением.

## 5. Payload `room.update` и `service.update`

Уровень: S. Компоненты `UpdateRoomModal`, `Rooms`, `RenameScreen`,
`GridSettingsScreen`, `GridTileSizeScreen`, `ReorderScreen`, `ServiceGrid`,
`AccessoryRoomScreen`.

- Комната. Переименование: `c2({ name: e3 || s2.value?.name })` →
  `room.update {id, name}`; пустой ввод отправляет прежнее имя. Показ:
  `room.update {id, visible}`. Порядок:
  `room.orders {orders:[{id, order: n4 + 1}]}` по всем комнатам, скрытые
  дописываются в конец.
- Сервис. Имя: `r2.mutate({ aId, sId, name })` только если имя изменилось и
  не пустое. Видимость: `service.update {aId, sId, visible}`. Размер плитки
  камеры: `service.update {aId, sId, grid:{width, height}}` для каждого
  сервиса камеры.
- Два разных порядка: в устройстве
  `service.orders {orders:[{aId, sId, order: t3}]}` с нуля; в комнате
  `service.orders {orders:[{aId, sId, grid:{order: t3 + 1}}]}` с единицы.
- Устройство: `accessory.update {id, name}` только при изменении и непустом
  имени; `accessory.update {id, roomId}`.
- `visible` сервиса клиент читает из ответа
  `accessory.get {id, expand:"services,characteristics"}` или `accessory.list`
  (`xd`: `queryKey: ["accessory.get", { id: e2 }]`, `Wd` берёт `services`).
  `service.get {aId, sId, expand:"characteristics"}` используется только в
  выборе характеристики (`CharacteristicsSelectorScreen`,
  `CharacteristicLinksScreen`).

Сравнение с 1bd4c68: `renameRoom`, `updateService` и `updateAccessory` шлют
те же поля; порядок, `grid` и видимость комнаты sprut-agent не пишет.

## 6. `log.list` в панели «Отладка»

Уровень: S. Компонент `SystemLogger`, обработчик событий `log`.

- При открытии: `log.list {count: 200}` без `lastTime`, затем
  `log.subscribe {}`, из ответа берётся `uuid`. При закрытии —
  `log.unsubscribe {uuid}`. При смене хаба и переподключении всё
  повторяется.
- Новые записи приходят событием `log` и добавляются в начало:
  `n3.log = n3?.log ? k()([...e5, ...n3.log], 500) : []`, то есть список
  идёт от новых к старым, не больше 500 записей.
- Ответ: кодек снимает два одноключевых уровня (`{log:{list:{…}}}`), хук
  читает `t3.value?.log`. Путь в сыром ответе —
  `result.log.list.log[]`.
- `time` записи — миллисекунды эпохи: клиент форматирует её date-fns
  `(0, ru.GP)(e4.item.time, "dd.MM.yyyy")` и сортирует группы по `-time`.
  Уровни: `LOG_LEVEL_INFO`, `LOG_LEVEL_DEBUG`, `LOG_LEVEL_TRACE`,
  `LOG_LEVEL_WARN`, остальное показывается как ошибка.
- Клиент никогда не отправляет `lastTime`. Направление, включительность и
  единицы `lastTime` из клиента не определить.

Сравнение с 1bd4c68: путь ответа и порядок от новых к старым совпадают с
`src/hub-log.mjs`. Допущение о `lastTime` остаётся непроверенным.

## 7. Когда клиент предлагает `scenario.run`

Уровень: S. Компоненты `Scenario`, `ScenarioBlock`, `ScenarioCode`, `Edit`.

- BLOCK: кнопка `play_circle` вызывает `oe2.mutate({ index: a2.scenarioId })`
  и выключена при `disabled: u2.value || f2.value` — идёт загрузка или есть
  несохранённые изменения.
- `ScenarioCode` показывается для `Logic`, `Template`, `Global` и `Skill`.
  Кнопка «Запустить» (`u2.mutate({ index })`) выключена только пока идёт запуск
  или сохранение.
- Ни одна кнопка не смотрит на `active` или `predefined`; у `predefined`
  выключено только сохранение.
- Выполняет ли хаб выключенный сценарий, из клиента не определить.

Сравнение с 1bd4c68: `scenario_run` принимает только включённые сценарии. Это
ограничение sprut-agent, не клиента.

## 8. Уведомления в модели 3.x

Уровень: S; строка про `notificationClient.list` — живое наблюдение из
[2026-09-17-extension-child-empty-list.md](2026-09-17-extension-child-empty-list.md).

- Клиент не вызывает ни `notification.*`, ни `notificationClient.*`; эти
  имена есть только в тексте встроенных proto. На живом хабе
  `notificationClient.list` ответил `-32601`.
- Службы уведомлений — расширения `bundleType: "NOTIFICATION"`
  (`Gd({ bundleType: Jd })`, `Jd = "NOTIFICATION"`). Получатели — дети
  расширения: `extensionChild.list {extensionKey: "Notification:<index>"}`
  (`` `Notification:${e3}` ``, где `index` — поле `index` расширения).
- Узел BLOCK: `{ type: "notify", text, mode, to }`. `mode` — `"MESSAGE"`
  («Системное») или `"PUSH"` («Отправить»); новый узел
  `{ type: "notify", text: "", mode: "MESSAGE" }`. Для PUSH
  `to: null` — через все службы, иначе
  `to: [{ index: <index расширения>, clients: null | [<id ребёнка>, …] }]`,
  `clients: null` — всем получателям службы. Смена `mode` сбрасывает `to` в
  `null`.
- Встроенная схема импорта задаёт `to: { type: "null" }`. Сценарий с
  выбранными получателями, сохранённый в файл, не пройдёт проверку при
  импорте в тот же клиент (вывод из кода, не проверялся).
- Уведомления об изменении характеристик и о выходе устройства из сети
  включаются флагом: `characteristic.update {aId, sId, cId, notify}`
  (`NotificationsScreen`, для сети — характеристика `C_Online`).
- Тестовой отправки и настройки получателей в клиенте нет. Если они есть, это
  поля или кнопки серверного окна расширения или его ребёнка
  (`window.update`); из клиента не определить.

## 9. Сопряжение устройств в 3.x

Уровень: S. Компоненты `ExtensionList`, `ExtensionSpace`,
`ExtensionSpaceGeneric`, `ExtensionSpacePlugin`, `ExtensionChild`,
`WindowScreen`, обработчики событий.

Клиент не вызывает `hub.discovery`, `extensionChild.createDialog`,
`extensionChild.create`, `extensionChild.delete`, `extensionChild.setOptions`,
`extension.setOptions`, `extension.delete`; `EXT_B_*` и `CHILD_B_*`
встречаются только в тексте proto. Последовательность:

1. `extension.list`, выбор расширения. Для `bundleType: "PLUGIN"` —
   `ExtensionSpacePlugin`, окно `mainWindow`; иначе — `ExtensionSpaceGeneric`.
2. `ExtensionSpaceGeneric`: `extensionChild.list {extensionKey}`, вкладки из
   `extension.spaces[]` (`key`, `label`, `type`, `actions[]`).
3. Кнопки внизу — `space.actions`. Для `ACTION_BUTTON`, `ACTION_SWITCH` и
   `ACTION_DISCOVERY`:
   `extension.action {extensionKey, spaceKey, actionId, state}`, где
   `state: "state" in e4 ? !e4.state : void 0`. Для `ACTION_OPTIONS`
   открывается окно `action.windowKey` (`window.get`/`window.update`). При
   `endTimestamp` на кнопке идёт обратный отсчёт.
4. Новые и меняющиеся устройства приходят событиями `extensionChild`
   (`EVENT_ADD`, `EVENT_UPDATE`, `EVENT_REMOVE`) с `progressBar`, `status`,
   `error`; состояние кнопок — событиями `extension`.
5. Нажатие на устройство открывает `ExtensionChild` с
   `windowKey = child.optionsWindow`. Настройка — `window.update`; поле
   `ACCESSORY_LIST` ведёт к созданному аксессуару. Событие `window` с
   `EVENT_UPDATE` обновляет поля окна, `EVENT_REMOVE` закрывает его; других
   событий `window` обработчик не разбирает, новое окно сам не открывает.

Физический шаг (кнопка на устройстве) в клиенте не отражён. Что делает
каждая кнопка конкретного контроллера, задаёт сервер.

## 10. Резервные копии

Уровень: S. Компоненты `MenuHubActions`, `SystemDownloadModal`, обработчик
события `file`.

- «Скачать резервную копию»: `file.backups {}` → ответ с `path`. Затем клиент
  ждёт событие `file` (`addFile(e4)`, ключ — `path`) с `length`.
- Загрузка частями: `file.filePart {path, start, length}`, `length` не больше
  `131072`, `retry: 3`, `retryDelay: 1e3`. `data` — base64
  (`window.atob`). Имя файла
  `Sprut.Hub_Backup_yyyy.MM.dd-HH_mm_ss.zip`. В `finally`, в том числе после
  отмены, — `file.complete {path}`. `loc` и `scope` клиент не передаёт.
- Логи и отладочная информация идут тем же потоком через `file.logs {}` и
  `file.devInfo {}`.
- Восстановления в клиенте нет: `file.uploadStart`, `uploadPart`,
  `uploadFinish`, `uploadAbort` объявлены в `File.proto`, но не вызываются; в
  перечне `inputType` клиента нет `FILE_UPLOAD`. Порядок восстановления из
  клиента не определить.

## Итог для sprut-agent

- Расхождение, которое меняет результат: единица `offset` у восхода и заката
  (п. 1). По клиенту — секунды.
- Подтверждены клиентом: имена дней недели в поле 5, `">"` и миллисекунды у
  «держится N», миллисекунды у задержек, EVERY/ONCE, путь ответа `log.list`.
- Расходятся с клиентом, но могут давать тот же результат на хабе:
  `scenario_active` через `scenario.update` (п. 4), запуск только включённых
  сценариев (п. 7).
- Требуют живой проверки: смысл CONTINUE (п. 3), `lastTime` (п. 6), запуск
  выключенного сценария (п. 7), приём формы одной даты (п. 1).

## Влияние на дом

Не изменялось. Хаб, облако и аккаунт не вызывались.
