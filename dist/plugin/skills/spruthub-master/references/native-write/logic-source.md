# `logic_source_create` и `logic_source_update`

Сначала вызови `get_native_change_contract` для выбранной `logic_source_create`
или `logic_source_update` и точного target.

- `logic_source_create` принимает точный service ref, полный source и явные
  `name`, `description`, `active`, `on_start`, `sync`. Он создаёт native
  `type=LOGIC`, добавляет к отправленному source уникальный JS-комментарий
  владения и читает результат обратно как точный текст. Подтверждённый source
  остаётся `applied` независимо от mapping: `logic_mapping_status` и
  `logic_assignment_ready` отдельно показывают возможность назначения.
  Если хаб вывел `description` из JS или нормализовал create flags, change
  отдельно показывает запрошенные и `observed` metadata с
  `exact_match:false`; сохранённый наблюдённый снимок остаётся границей защиты
  от последующей ручной правки.
  Назначаемый type созданного LOGIC — строка его `scenario_index`
  (SprutHub 3.0.0): `native_logic_type` и `logic_ref` берутся из index, в
  том числе у записей прежних версий. Выбранный сервис показывает этот type
  в `logic.types` только пока LOGIC включён, с именем и описанием сценария,
  поэтому `logic_assignment_ready=true` только тогда; иначе
  `logic_mapping_reason` — `logic_turned_off` (выключен: включи через
  [`scenario_active`](scenario-active.md), если владелец хочет назначить) или
  `logic_type_not_available_on_target` (включён, но этот сервис его не
  показывает, например сервис не из `sourceServices`). Если запись этого type
  названа не как сценарий, mapping нет (`logic_mapping_status=missing`,
  `logic_type_name_mismatch`): `logic_ref` не выдаётся, restore отвечает
  этой ошибкой и не удаляет; при совпадении имён mapping возвращается.
  Restore удаляет созданный LOGIC только включённым: видны ли назначения
  выключенного LOGIC в `logic.list`, на хабе не проверяли, и пустой обход
  этого не доказывает. Выключенный LOGIC restore не удаляет и отвечает
  `logic_off_assignments_unverified` с `next` к `scenario_active`. Скажи
  пользователю, что отменить создание можно после включения LOGIC (он
  начнёт работать на назначенных устройствах, если они есть) или удалив его
  в приложении SprutHub. Если delete записи уже отправила прежняя версия,
  проверив назначения другого type, отсутствие сценария даёт `restored` с
  `logic_assignments_may_remain=true`: назначения его собственного type могли
  остаться на устройствах. Скажи об этом пользователю. Собственный маркер в source позволяет найти
  именно результат потерянного create без второй отправки и без присвоения
  соседнего совпадающего сценария. В журнале сохраняется точный отправленный
  source, но наружу change возвращает его SHA-256 и результат точного сравнения,
  а не повторяет сохранённый код.
- `logic_source_update` поддержан только для непрерывно наблюдаемого
  пользовательского LOGIC и отправляет только `{index,data}`; отдельный readback
  проверяет точный source и сохраняет фактически наблюдённые metadata. Хаб
  заново выводит из JS `name` и `description`; остальные metadata инструмент
  берёт из фактического readback. Без CAS он не приписывает любое отличие source
  или параллельной правке. Полный снимок до apply
  и применённый снимок до restore остаются строгими guards ручной правки;
  `active` в них не сравнивается, потому что включение и выключение
  принадлежат [`scenario_active`](scenario-active.md) и интерфейсу хаба:
  выключенный после записи LOGIC по-прежнему восстанавливается, а созданный
  удаляется, когда снова включён. После
  обратной записи readback подтверждает точный исходный source и снова сохраняет
  наблюдённые metadata. Predefined source доступен для чтения и клонирования, но
  не изменяется. Restore ещё не применённого create/update даёт
  `not_owned`/`change_was_not_applied`, не пишет в хаб и не отменяет
  последующий apply того же черновика: это не ручная правка. `not_owned`
  после отклонённой отправки не присваивает чужой source и не откатывает
  его, даже если текст совпал с requested. Restore
  update не затирает ручную правку. Conflict без
  applied snapshot не становится applied по совпадению с requested, а
  повторный apply уже подтверждённого change не перезаписывает ручной откат;
  новое намерение идёт через свежий prepare. Restore create перед delete сканирует текущие
  назначения его type (index) по сервисам дома; omitted `services`
  трактуется как пустое repeated-поле, а present malformed ответ отклоняется.
  Любое назначение блокирует удаление и даёт `logic_assignments_present` со
  свежим списком назначений; это не рецепт готовить новый LOGIC. Снятие
  чужого назначения — отдельное разрешённое изменение. Ручная правка source
  или уже снятые назначения заменяют сохранённую причину текущим наблюдением.
  Так же удаление блокирует BLOCK, который запускает этот LOGIC целью
  `scenario`: conflict `scenario_targets_present` называет его в
  `referencing_scenario_targets` с указателем узла; сначала измени или убери
  эту цель (`block_data_update`), затем повтори restore. После снятия дочерних source/options/active changes и назначений созданный
  неизменённый LOGIC можно явно restore. Сохранённое отсутствие proven create
  по записанному index через `get_native_change`, `apply_native_change` или
  `restore_native_change` прекращает delete этого change: точная копия под
  тем же index не удаляется, `restore_supported=false`. `get_entity` и
  `home_overview` этот факт не записывают; ошибка чтения не считается
  отсутствием, а `local_state.saved=false` не обещает память после рестарта.
  Source readback не подтверждает callback lifecycle или физический эффект; JS
  локально не исполняется и не проходит обещанный полный static analysis.
