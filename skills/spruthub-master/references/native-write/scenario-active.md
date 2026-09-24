# `scenario_active`

Сначала вызови `get_native_change_contract(operation="scenario_active", target_ref=...)` с ref существующего сценария из `home_overview(list="scenarios")`, `home_overview(query)` или `get_entity`.

- Операция выключает (`value=false`) или включает (`value=true`) существующий
  сценарий любого типа: BLOCK, LOGIC или GLOBAL. Флаг пишется так же, как в
  веб-клиенте SprutHub: `window.update` окна настроек сценария
  (`optionsWindow`) с одной опцией `Active`; data, имя, описание, `onStart` и
  `sync` не отправляются. Это не удаление и не запуск: сценарий остаётся на
  хабе. `block_data_update` флаги не меняет, `active` меняется только здесь:
  `window_option` с ref окна сценария и `option_key=Active` отказывает с
  `scenario_owner_required` и `next` сюда.
- На SprutHub 3.0.0 запись `Active` через окно включает и выключает BLOCK и
  LOGIC, и `scenario.get` сразу совпадает с окном; у GLOBAL и встроенных
  сценариев окно с тем же `Active` только прочитано. `scenario.update
  {index, active}` хаб принимает с ACK, но флаг не меняет, поэтому этот путь
  не используется. Change, записанный, когда
  операция ещё отправляла `scenario.update`, сверяется тем же чтением, а
  повторный apply пишет уже через окно.
- Если у сценария нет окна настроек или в окне нет опции `Active`, prepare
  отказывает (`options_window_unavailable` или `window_option_not_found`) до
  записи: включить такой сценарий может владелец в приложении SprutHub.
- Результат подтверждается, только когда и `scenario.get`, и опция `Active`
  окна показывают нужное значение. Если они расходятся, change остаётся
  `uncertain` с ошибкой проверки `scenario_active_mismatch`, и ничего больше
  не отправляется; повторное чтение позже покажет итог. Если они расходятся
  уже при контракте или prepare, change не создаётся, а та же ошибка ведёт к
  `get_entity` сценария: подготовь change позже, когда значения совпадут.
- Новое состояние передаётся в `value`. Параметр `active` задаёт только
  начальный флаг `block_create` и `logic_source_create`; `scenario_active` или
  `logic_active` с `active` без `value` получает `invalid_native_value` с
  готовым `next`.
- Выключение не отнимает сценарий у прежних BLOCK, LOGIC и automation
  changes: их проверка владения не сравнивает `active`, поэтому созданный и
  потом выключенный BLOCK по-прежнему удаляется своим restore или
  rollback, а restore data и source флаг не трогают. Созданный LOGIC
  restore удаляет и выключенным, если обход не нашёл его назначений и BLOCK,
  которые его запускают, см. [LOGIC](logic-source.md).
- Уже нужное значение не создаёт change. Apply сверяет baseline; потерянный
  ответ сверяется чтением без повторной отправки. Restore возвращает исходный
  флаг, только пока текущее значение совпадает с применённым; ручное
  переключение после apply остаётся conflict.
