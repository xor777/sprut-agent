# `scenario_active`

Сначала вызови `get_native_change_contract(operation="scenario_active", target_ref=...)` с ref существующего сценария из `inspect_home` или `get_entity`.

- Операция выключает (`value=false`) или включает (`value=true`) существующий
  сценарий любого типа: BLOCK, LOGIC или GLOBAL. Флаг пишется так же, как в
  веб-клиенте SprutHub: `window.update` окна настроек сценария
  (`optionsWindow`) с одной опцией `Active`; data, имя, описание, `onStart` и
  `sync` не отправляются. Это не удаление и не запуск: сценарий остаётся на
  хабе. `block_data_update` флаги не меняет, `active` меняется только здесь.
- SprutHub 3.0.0 принимает `scenario.update {index, active}` с ACK, но флаг
  не меняет, поэтому этот путь не используется. Change, записанный, когда
  операция ещё отправляла `scenario.update`, сверяется тем же чтением, а
  повторный apply пишет уже через окно.
- Если у сценария нет окна настроек или в окне нет опции `Active`, prepare
  отказывает (`options_window_unavailable` или `window_option_not_found`) до
  записи: включить такой сценарий может владелец в приложении SprutHub.
- Результат подтверждается, только когда и `scenario.get`, и опция `Active`
  окна показывают нужное значение. Если они расходятся, change остаётся
  `uncertain` с ошибкой проверки `scenario_active_mismatch`, и ничего больше
  не отправляется; повторное чтение позже покажет итог.
- Новое состояние передаётся в `value`. Параметр `active` задаёт только
  начальный флаг `block_create` и `logic_source_create`; `scenario_active` или
  `logic_active` с `active` без `value` получает `invalid_native_value` с
  готовым `next`.
- Выключение не отнимает сценарий у прежних BLOCK, LOGIC и automation
  changes: их проверка владения не сравнивает `active`, поэтому созданный и
  потом выключенный сценарий по-прежнему удаляется своим restore или
  rollback, а restore data не трогает флаг.
- Уже нужное значение не создаёт change. Apply сверяет baseline; потерянный
  ответ сверяется чтением без повторной отправки. Restore возвращает исходный
  флаг, только пока текущее значение совпадает с применённым; ручное
  переключение после apply остаётся conflict.
