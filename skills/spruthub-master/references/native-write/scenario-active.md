# `scenario_active`

Сначала вызови `get_native_change_contract(operation="scenario_active", target_ref=...)` с ref существующего сценария из `inspect_home` или `get_entity`.

- Операция выключает (`value=false`) или включает (`value=true`) существующий
  сценарий любого типа: BLOCK, LOGIC или GLOBAL. `scenario.update` получает
  только `index` и `active`; data, имя, описание, `onStart` и `sync` не
  отправляются. Это не удаление и не запуск: сценарий остаётся на хабе.
  `block_data_update` флаги не меняет, `active` меняется только здесь.
- Выключение не отнимает сценарий у прежних BLOCK, LOGIC и automation
  changes: их проверка владения не сравнивает `active`, поэтому созданный и
  потом выключенный сценарий по-прежнему удаляется своим restore или
  rollback, а restore data не трогает флаг.
- Уже нужное значение не создаёт change. Apply сверяет baseline, readback идёт
  отдельным `scenario.get`; потерянный ответ сверяется чтением без повторной
  отправки. Restore возвращает исходный флаг, только пока текущее значение
  совпадает с применённым; ручное переключение после apply остаётся conflict.
- Поле `active` в `scenario.update` известно по схеме протокола; сохранил ли
  его хаб, показывает readback, а не ACK.
