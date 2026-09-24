# `room_name`, `service_name`, `service_visible`

Сначала вызови `get_native_change_contract` с нужной operation и `target_ref`: ref комнаты из `home_overview` для `room_name`, ref сервиса из `get_entity` для `service_name` и `service_visible`.

- `room_name` переименовывает комнату: `room.update` получает только `id` и
  `name`. `service_name` переименовывает один сервис, например канал
  выключателя, а `service_visible=false` скрывает его в интерфейсе, `true` —
  показывает: `service.update` получает `aId`, `sId` и одно поле `name` или
  `visible`. Порядок, сетка, соседние сервисы и accessory не отправляются.
- Имя обрезается по краям, пустое отклоняется. Имя комнаты длиннее 30
  символов `room_name` не готовит (`name_too_long`): хаб сохранил бы только
  начало. Если такое же точное имя уже
  есть у другой комнаты, prepare всё равно готовит change и возвращает
  `warnings` с `room_name_in_use` и refs этих комнат: сообщи пользователю до apply.
- Если хаб не прислал `visible` у сервиса, видимость неизвестна: prepare
  отказывает с `service_visibility_unknown`, а не считает сервис скрытым.
- Уже нужное значение не создаёт change. Readback идёт отдельным `room.get`
  или `accessory.get`; restore возвращает прежнее значение, пока текущее
  совпадает с применённым, ручная правка остаётся conflict.
- `room.update` и `service.update` известны по схеме протокола; сохранил ли хаб
  значение, показывает readback, а не ACK.
- Если хаб сохранил имя не так, как просили, change остаётся `uncertain`, а не
  ручной правкой, и сам имя больше не пишет. Чтобы задать имя заново, подготовь
  новый `room_name` или `service_name` от сохранённого имени.
