# Наблюдение: нативные дашборды SprutHub 3.0 (`dashboard`, `dashboardColumn`, `dashboardWidget`)

- **Дата:** 2026-11-26
- **Источник:** живая самоочищающаяся проба на SprutHub владельца (прошивка `3.0.0`, ревизия `20131`, 0 исходных дашбордов; после пробы снова 0 дашбордов) + схемы [39246-Dashboard.proto](2026-09-15-native-inventory/proto/39246-Dashboard.proto), [57808-DashboardColumn.proto](2026-09-15-native-inventory/proto/57808-DashboardColumn.proto), [88338-DashboardWidget.proto](2026-09-15-native-inventory/proto/88338-DashboardWidget.proto) и [History.proto](2026-09-15-native-inventory/proto/51742-History.proto).
- **Граница достоверности:** проверено на временном дашборде `sprut-probe-tmp-dash` (удалён в `finally`). Виджеты `CAMERA`, `SHORTCUT`, `WEATHER`, `TILE` и переупорядочивание панелей/колонок (`dashboard.orders`, `dashboardColumn.orders`) описаны в proto и списке типов, но вживую не вызывались; вживую проверены `CHARACTERISTIC`, `CHART`, `SERVICE`, `CLOCK`, нормализация имён (`dashboard`, `dashboardColumn`, `dashboardWidget`) и `dashboardWidget.orders`.

## Подтверждённые факты протокола

1. **Список типов виджетов (`dashboardWidget.types: {}`):**
   - Возвращает `dashboardWidget.types.types` со всеми 8 типами: `TILE`, `SERVICE`, `CHARACTERISTIC`, `CHART`, `CAMERA`, `SHORTCUT`, `WEATHER`, `CLOCK`.
2. **Пустой список (`dashboard.list: {}`):**
   - Когда дашбордов нет, proto3 опускает поле `dashboards`: приходит `{ dashboard: { list: {} } }`. То же для пустого `dashboardColumn.list` (`{ dashboardColumn: { list: {} } }`).
3. **Создание панели (`dashboard.create: { name, order? }`):**
   - Возвращает `{ dashboard: { create: { id, order, name } } }`.
   - **Колонки автоматически НЕ создаются:** сразу после `dashboard.create` и `dashboard.get`, и `dashboardColumn.list` возвращают пустой список колонок. Для добавления виджетов нужно создать хотя бы одну колонку через `dashboardColumn.create`.
4. **Колонки (`dashboardColumn.{list,get,create,update,delete}`):**
   - `create: { dashboardId, name?, order? }` возвращает `{ dashboardId, id, order, name }`.
   - `update: { dashboardId, id, name? }` возвращает `{}`.
   - `delete: { dashboardId, id }` **каскадно удаляет непустую колонку вместе со всеми её виджетами**, возвращает `{}` и шлёт `EVENT_REMOVE` для каждого виджета и самой колонки.
5. **Виджеты (`dashboardWidget.{list,get,create,update,delete,types}`):**
   - `create: { dashboardId, columnId, name?, order?, <kind>: {...} }` возвращает созданный `DashboardWidgetMessage` с назначенными `id` и `order`.
   - Подтверждённые полезные нагрузки:
     - `characteristic: { items: [{ aId, sId, cId }] }`
     - `chart: { items: [{ aId, sId, cId }], group?: "MINUTE" | "HOUR" | "DAY" }` (`HistoryGroup` из `History.proto`; на хабе без приложения «История» виджет создаётся без ошибки, но точки истории приходят из «Истории»)
     - `service: { items: [{ aId, sId }], showRooms?: boolean }`
     - `clock: {}` (а также `weather: {}`, `tile: {}`, `camera: { items: [{ aId, sId }] }`, `shortcut: { items: [{ id }] }` по proto)
   - `update: { dashboardId, id, name?, <kind>: {...} }` возвращает `{}`; перечитывание `dashboardWidget.get({ dashboardId, id })` подтверждает новое `name` и payload.
   - `delete: { dashboardId, id }` возвращает `{}`.
6. **Полное чтение панели (`dashboard.get: { id }`):**
   - Возвращает полную вложенную структуру `{ id, order, name, columns: [{ dashboardId, id, order, name, widgets: [...] }] }` за один RPC.
7. **Переименование и удаление панели (`dashboard.update`, `dashboard.delete`):**
   - `update: { id, name }` возвращает `{}`.
   - `delete: { id }` удаляет панель и возвращает `{}`.
8. **Push-события WebSocket и `HomeState`:**
   - Операции с дашбордами пушат события с ключами `dashboard`, `dashboardColumn`, `dashboardWidget` (`EVENT_ADD`, `EVENT_UPDATE`, `EVENT_REMOVE`).
   - Они не затрагивают комнаты и аксессуары дома: `HomeState` должен игнорировать эти события (и считать RPC `dashboard.*` / `dashboardColumn.*` / `dashboardWidget.*` нейтральными для кэша `HomeState`).
9. **Нормализация имён (`dashboard`, `dashboardColumn`, `dashboardWidget` — `create` и `update`):**
   - Проверено живой пробой на SprutHub `3.0.0` rev `20131` (2026-11-26).
   - Хаб сворачивает и обрезает пробелы (`"  ab   cd  "` → `"ab cd"`), удаляет все символы вне букв Юникода (включая `Ёё`), цифр, пробела, `-`, `_`, `'` и `` ` ``, обрезает пробелы по краям и усекает строку до **32 кодовых точек Юникода** (одинаково для латиницы и кириллицы).
   - Удаление пунктуации происходит после сворачивания пробелов, поэтому удалённый символ между пробелами оставляет внутренний двойной пробел (например, `"Гостиная · розетка обогревателя"` → `"Гостиная  розетка обогревателя"`).
   - При перечитывании (`dashboard.get` / `dashboardWidget.get`) хаб возвращает уже нормализованное имя, поэтому строгое сравнение с исходным запросом давало ложный `conflict` после успешной записи.
10. **Перемещение и порядок виджетов (`dashboardWidget.orders`):**
    - Проверено живой пробой на SprutHub `3.0.0` rev `20131` (2026-11-26).
    - Запрос: `{ dashboardWidget: { orders: { orders: [{ dashboardId, columnId, id, order }, ...] } } }`.
    - Ответ: `{ dashboardWidget: { orders: { orders: [...] } } }` (в proto3 поле `order: 0` может опускаться в JSON).
    - Отправка в `orders` только одного переносимого виджета оставляет пропуски `order` в исходной колонке и коллизии `order` в целевой. Отправка полного непрерывного списка `0..N-1` для всех виджетов каждой затронутой колонки поддерживает непрерывный порядок, перенос между колонками, опустошение колонки и переупорядочивание внутри колонки за один RPC.
11. **Наблюдения реального мобильного UI SprutHub 3.0:**
    - Каждая колонка дашборда в мобильном приложении отображается как **отдельный горизонтальный экран (свайп)**, а не вертикальная стопка на одном экране.
    - В виджете `characteristic` каждая строка подписывается **только названием самой характеристики** («Ватт», «°C»), без имени устройства и комнаты. Смешивание одинаковых `characteristic_type` от разных устройств в одном виджете `characteristic` даёт неразличимые строки.

## Проверка реального веб-клиента SprutHub 3.0 и живая проба `service.grid` (2026-11-27)

- **Источники:**
  1. Официальный веб-клиент SprutHub 3.0 (`beta.spruthub.ru/js/app.16735171810a795a9f2d.js`: `Column.vue`, `CreateWidgetScreen`, `WidgetServices`, `ServiceCard`, `WidgetCharacteristics`, `WidgetCharts`, `ChartItem`, `WidgetShortcuts`, `WidgetCamera`, `WidgetClock`, `WidgetWeather`).
  2. Живая самоочищающаяся проба `service.update({ aId, sId, grid })` на SprutHub владельца (`3.0.0`, rev `20131`, временный виртуальный `Switch` `aId=214`, удалён в `finally`).
- **Подтверждённые факты рендеринга 8 типов виджетов:**
  1. **`WidgetServices` (`service`):** 3-колоночная сетка плиток (`grid-template-columns: repeat(3, 1fr)`) через `ServiceCard` (74 типа сервисов, включая все датчики и счётчики: `C_WattMeter`, `C_KiloWattHourMeter`, `TemperatureSensor`, `HumiditySensor`, `CarbonDioxideSensor`, `AirQualitySensor`, `BatteryService`, `LeakSensor`, `ContactSensor`, `MotionSensor`, `SmokeSensor` и др.). Плитка показывает иконку, крупное значение с единицей, `service.name`, `room.name` (при `showRooms: true`) и статус активности/офлайна; тап по датчику открывает его карточку без переключения. Размер плитки в сетке — `w{service.grid.width}_h{service.grid.height}` (`1..3` × `1..3`).
  2. **`WidgetCharacteristics` (`characteristic`):** строки элементов формы (`CharacteristicControl`), подписанные **только `characteristic.control.name`** (без иконки, устройства и комнаты) — подходит для прямых контролов одного устройства, но не для плиток датчиков из разных комнат.
  3. **`WidgetCharts` (`chart`):** стопка `ChartItem` в общей карточке с переключателем периода `Час / Сутки / Неделя`. Заголовок каждого `ChartItem` показывает **только `characteristic.control.name` + текущее значение** (без устройства и комнаты — дублирование `characteristic_type` от `>= 2` устройств даёт одинаковые неразличимые заголовки). Реальная привязка `history_group` в веб-UI: опущенное поле → **Час (1 ч)**, `MINUTE` → **Сутки (24 ч)**, `HOUR` → **Неделя (7 д)**; **`DAY` не привязан и откатывается к «Часу» (1 ч)**.
  4. **`WidgetShortcuts` (`shortcut`):** меню «Дашборды» для навигации между дашбордами: `shortcut_ids` — это **ID других дашбордов**, рендерятся кликабельными строками с `>` и историей возврата (`?from=...`). Это **не** сцены и не сценарии хаба.
  5. **`WidgetCamera` (`camera`):** живые карточки потоков камер.
  6. **`WidgetClock` (`clock`):** живые часы со шкалой рассвета/заката, но жёстко привязаны к `Europe/Moscow` (55.7558, 37.6173).
  7. **`tile` (`DashboardTileWidget`):** **не рендерится** компонентом `Column.vue` (игнорируется; в `CreateWidgetScreen` доступно только 7 типов).
  8. **`WidgetWeather` (`weather`):** текущая реализация — **жёсткая заглушка** (`Москва, 21°, Облачно, от 12° до 22°`, выбор локации отключён).
- **Сетка колонок (`Column.vue`):**
  - `column.name` **не отображается** на дашборде; видимы только `dashboard.name` и `widget.name` (опущенный `widget.name` скрывает заголовок виджета).
  - Каждая колонка имеет ширину **350 px** (+ 20 px зазор), формула числа видимых колонок: `floor((screenWidth + 20) / 370)` — 1 экран-свайп на телефонах (`<720px`), 2–4 колонки рядом на планшетах и десктопах.
- **Живая проба `service.grid` (`SprutHub 3.0.0` rev `20131`):**
  - `service.update({ aId: 214, sId, grid: { order, width, height } })` подтвердил сохранение и перечитывание через `accessory.get` для `1x1`, `2x1`, `3x1`, `2x2` (виртуальный `Switch` удалён в `finally`).
  - `service.grid` также содержит `order`, поэтому при изменении размера плитки нужно сохранять актуальный живой `order`; изменение `service.grid` влияет **одновременно и на `service`-виджеты дашбордов, и на сетку сервисов в комнате**.
