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
