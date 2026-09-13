# `accessory_placement`

Сначала вызови `get_native_change_contract(operation="accessory_placement", target_ref=...)`. Ниже — дополнительные проверенные границы изменения одного accessory.

- `accessory_placement` принимает точные home-qualified refs одного accessory и
  существующей комнаты, сохраняет исходные имя, комнату и физическую привязку,
  затем отправляет только `accessory.update({id,name,roomId})`. Пустой ACK
  подтверждается отдельным `accessory.get`; requested и observed имя различаются,
  если хаб нормализовал строку. Restore возвращает только имя и комнату при
  совпадении всего применённого снимка и привязки. Соседние accessories с тем же
  `deviceId`, services и сценарии не меняются.
