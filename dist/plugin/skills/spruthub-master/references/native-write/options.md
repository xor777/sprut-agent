# `characteristic_option`, `logic_option` и `window_option`

Сначала вызови `get_native_change_contract` с точной option-операцией, ref владельца и `option_key`. Ниже — общий проверенный typed-контракт этих трёх операций.

- `characteristic_option`, `logic_option` и `window_option` принимают точный ref
  владельца и один option key. Общий контракт допускает только
  readable/writable/enabled `NUMBER` с `intValue`/`longValue`/`doubleValue`,
  `CHECKBOX` с `boolValue` или `LIST` с непустыми scalar `validValues` того же
  kind. Для подтверждённых `Name` (`TEXT`) и `Desc` (`TEXT_MULTILINE`) BLOCK
  `window_option` принимает scenario-ref: внутри читается свежий
  `optionsWindow`, затем обычный scalar prepare/apply/restore через
  `window.update`. Прямой window-ref не открывает TEXT/TEXT_MULTILINE Name/Desc
  и не обходит marker; если окно принадлежит BLOCK, отказ указывает на
  владельца-сценария, иначе это обычный unsupported TEXT. `Active` окна
  сценария любого типа — его флаг включения: window_option отказывает с
  `scenario_owner_required` и `next` на контракт
  [`scenario_active`](scenario-active.md), который проверяет и
  `scenario.get`. Ключ `Name`, `Desc` или `Active` сам по себе не делает окно
  сценарием: NUMBER/CHECKBOX/LIST с тем же ключом в окне устройства остаются
  обычными window_option. Известный `GenericBoolean`/`GenericInteger`/`GenericLong`/`GenericDouble`
  обязан совпадать с envelope. Явные min/max/step и список сохраняются и
  проверяются; LIST, в котором хотя бы один вариант противоречит явному
  диапазону или шагу, целиком несовместим. Отсутствующие ограничения не
  выводятся из имени. GROUP, кнопки, PASSWORD, чувствительные option,
  произвольный текст и составные значения не записываются; чувствительная
  настройка блокируется до сохранения baseline или истории. В ответе
  чтения `native_change` отдельно показывает native write, поддержку публичной
  операции, причину отказа и точный `get_native_change_contract` next.
  Текущее значение находится в `option.value`, а не в
  `validValues[].checked`. Контракт показывает `restore_supported` по тому же
  scalar-validator сохранённого baseline. Если диапазон, шаг или явный список
  допустимых значений изменился после prepare/apply, `get_native_change`
  показывает `restore_limitation=baseline_not_writable`, а restore не
  отправляет запись. Уже нужное значение не создаёт change. Запись
  отправляет только выбранные key и typed value; readback выполняется отдельным
  `characteristic.getOptions`, `logic.getOptions` или `window.get`.
  Restore возвращает сохранённый baseline только при совпадении текущего
  значения с доказанно применённым; подготовленный или подтверждённо
  отклонённый change не присваивает совпавшую ручную настройку и возвращает
  `not_owned`. Для BLOCK Name/Desc соседние metadata-поля, data и флаги не
  входят в guard выбранного поля; завершённый restore закрыт и не пишет
  снова после get или совпадения с requested. Обычный неизвестный option-write или изменение `logic_active`
  можно повторить после readback неизменённого baseline, пока журнал не
  зафиксировал утрату владения. Уже отправленный `not_owned` требует нового
  prepare и повторно не записывается.
  Третье значение не затирается; conflict возвращает имена
  исходного, применённого и текущего вариантов и эффект нового изменения,
  которое можно подготовить только после решения владельца.

Для `window_option` readback подтверждает сохранённую настройку хаба, но не
доставку до устройства и не физический результат после отключения питания.
Корневое окно настроек дома (пустой native `windowKey`) остаётся read-only:
`native_write` может быть true, но публичная операция не поддерживается и
`window.update` не отправляется. Непустые device/extension windows не меняются.

Значения option не зашиты по имени владельца, модели или ключу. Options
сохраняются по service/type после удаления и пересоздания logic-назначения.
Отмена `logic_option` возвращает наше неизменённое значение по этому адресу даже
после пересоздания; это не даёт права удалить новое назначение.
