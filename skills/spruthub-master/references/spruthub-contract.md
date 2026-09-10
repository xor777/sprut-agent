# Проверенный контракт SprutHub

Читайте нужный раздел, когда решение зависит от адресации, семантики native данных, доступного инструмента или версии. Это не полный API.

## Дома и сущности

Наблюдение: Sprut.hub 2, firmware `3.0.0b (20131)`, 2026-09-09; принятый runtime sprut-agent привязан к base `5d1372d40c4a8eb3b3a5c73f09303f9c0e885e50`, `src/server.mjs` SHA-256 `6733c8eab427821b15a93a8abeab0355edfe14a455b6f2088a763c9fd498f911` и `src/spruthub-client.mjs` SHA-256 `6f33a6bfa6e0863a82f3de8bc523750445249b17116ed697ef2ce9f69d135d6b`.

- `list_homes` возвращает доступные дома. Все дальнейшие refs содержат percent-encoded serial выбранного дома; локальные ID разных домов нельзя смешивать.
- `inspect_home(home_ref)` даёт компактный каталог комнат, сценариев и extensions и честную `coverage`. Успешный list не доказывает, что соответствующий get также сработал.
- `get_entity(entity_ref, include)` читает room, accessory, service, characteristic, scenario, extension, назначенную logic или окно физических настроек. Room даёт компактную иерархию физических accessory и вложенных service с их собственными ref/name/type без чтения значений; выбранный service затем раскрывается отдельно. `include` относится к указанной сущности и не является рекурсивным обходом её детей.
- У настройки есть конкретный владелец. `include=options` раскрывает native options только для characteristic ref. Безопасная характеристика возвращает `option_scope`: native `true`/`false`/`null`, статус `not_read`/`found`/`checked_empty` и точный следующий вызов. Только совместимый `characteristic.getOptions` с явным массивом подтверждает `found` или `checked_empty`; отсутствующий или неверный operation container даёт `incompatible_response`. Container include не запускает рекурсивное чтение: `include_resolution.not_applied` возвращает причину и безопасный следующий вызов, когда его можно построить по возвращённой ссылке, иначе явное ограничение. Terminal redacted marker не раскрывает refs, availability или include metadata.
- Physical window и назначенная logic — отдельные области: читайте возвращённый window ref или logic ref самостоятельно. Пустой `physical_configuration.options` не означает, что у характеристики нет options; пустой результат характеристики не говорит о window или logic. В выводе различайте «найдено», «эта область проверена и пуста» и «область не исследована».
- Запрашивайте только нужные `options`, `relations`, `physical_configuration`, `diagnostics`. Каждый requested include для принятой сущности перечисляется как `applied` или `not_applied`; успешный ответ без такого исхода не считается полным обследованием устройства.
- `list_rooms` → `read_room` — компактный совместимый путь. Исходное имя остаётся рядом с показаниями; одинаковые значения разных комнат не объединяются.
- Native identity характеристики задают дом и `aId/sId/cId`; identity extension instance — непустой `extensionKey`, не общий `type`.

Официальное описание модели: [SprutHub Wiki, аксессуары, сервисы и характеристики, oldid 3538](https://wiki.spruthub.ru/index.php?title=%D0%90%D0%BA%D1%81%D0%B5%D1%81%D1%81%D1%83%D0%B0%D1%80%D1%8B,_%D1%81%D0%B5%D1%80%D0%B2%D0%B8%D1%81%D1%8B_%D0%B8_%D1%85%D0%B0%D1%80%D0%B0%D0%BA%D1%82%D0%B5%D1%80%D0%B8%D1%81%D1%82%D0%B8%D0%BA%D0%B8&oldid=3538). Это модель/UI, не транспортная спецификация.

## Автоматизации и зависимости

- Тип сценария устанавливается по native полям, не по имени. На целевом хабе наблюдались BLOCK/GLOBAL/LOGIC; BLOCK раскрывается как JSON-дерево, а GLOBAL/LOGIC может содержать код. Другие имена из proto enum не доказывают доступный механизм создания.
- Для проверки существующего поведения нужны реальный source, условия, actions и targets. Отфильтрованный список по accessory может быть пуст, хотя ссылка скрыта внутри произвольного кода.
- Наблюдённый native `logic.list` показывает назначенные logic, а `logic.types` — доступные типы. Публичный агент получает эти сведения через `get_entity`/preview и не вызывает raw RPC; наличие типа не означает назначение.
- `link.list` с SYSTEM-связью контроллера не доказывает связь двух устройств.
- Наблюдённый native `characteristic.getOptions` может вернуть, например, `SwitchOffTime`; публичный `get_entity` раскрывает это через `include=options`. Это настройка собственного состояния датчика, не правило другой лампы.
- Наблюдённый native `scenario.sdk` с текущего хаба — протокольный источник API исполняемого на хабе кода, а не публичный MCP-tool. Старый snapshot/frontend schema остаётся кандидатом до проверки.

Официальная Wiki различает визуальные BLOCK, назначаемые logic, GLOBAL и код в sandbox: [основные элементы сценариев, oldid 2988](https://wiki.spruthub.ru/index.php?title=%D0%A1%D1%86%D0%B5%D0%BD%D0%B0%D1%80%D0%B8%D0%B8_%D0%B2_Sprut.hub_-_%D0%BE%D1%81%D0%BD%D0%BE%D0%B2%D0%BD%D1%8B%D0%B5_%D1%8D%D0%BB%D0%B5%D0%BC%D0%B5%D0%BD%D1%82%D1%8B_%D1%83%D0%BF%D1%80%D0%B0%D0%B2%D0%BB%D0%B5%D0%BD%D0%B8%D1%8F&oldid=2988). Проверенное обезличенное наблюдение за хабом: [sprut-agent, automation context at 5d1372d](https://github.com/xor777/sprut-agent/blob/5d1372d40c4a8eb3b3a5c73f09303f9c0e885e50/research/protocol/2026-09-09-automations.md).

## Значения, свежесть и диагностика

- `freshness.hubResponseReceivedAt` — время получения ответа. `measurementAt: null` или `source_timestamp: null` означает, что время источника неизвестно.
- Сохранённое `MotionDetected=true` не доказывает новое физическое движение. Configured value, диагностический report и `pending: unknown` не выводятся друг из друга.
- GROUP layout, BUTTON command и NUMBER setting — разные классы данных. Нельзя объявлять команду текущей конфигурацией.
- Диагностика и код раскрываются только по явному include. Sensitive native entity возвращается терминальным redacted marker; не пытайтесь восстановить скрытых потомков или identifiers.

## Поддержанная запись

Общий публичный write-path сначала раскрывает версионный контракт через
`get_native_change_contract`, затем разделяет `prepare_native_change`,
`apply_native_change`, `get_native_change` и `restore_native_change`.
`list_native_changes` даёт ограниченную историю по дому и точной entity ref,
включая старые automation changes. `recorded_status` в этой истории — сохранённый
исход на `updated_at`, а не текущая проверка; для неё используется возвращённый
`next`. Для BLOCK история индексирует canonical refs
сценария и участвующих accessory/service/characteristic до и после update;
старые unqualified refs привязываются только к fingerprint текущего журнала.
Это поиск, а не разрешение на запись.

- `characteristic_value` проверяет фактический native type, права, kind,
  диапазон, шаг, длину и перечисление. Readback — наблюдение значения, а не
  доказательство физической причинности; автоматического отката нет.
- `window_option` принимает существующий window ref и точный option key. В этом
  срезе поддержан только readable/writable/enabled `GenericInteger/LIST` с
  `intValue` и непустыми `validValues`; текущее значение находится в
  `option.value`, а не в `validValues[].checked`. Уже нужное значение не создаёт
  change. Запись отправляет один option и подтверждается отдельным `window.get`.
  Restore возвращает сохранённый baseline только при совпадении текущего
  значения с применённым; третье значение не затирается.
- `block_create` требует явные `name`, `description`, `active`, `onStart`,
  `sync`, `type=BLOCK` и `data`. После неопределённого create маркер позволяет
  сверить хаб без повторной отправки.
- `block_data_update` заменяет полное `data` и отправляет только `{index,data}`:
  изменение имени и runtime-флагов этим контрактом не поддержано. Ответ хаба
  может не содержать data, поэтому обязательна отдельная сверка.
- BLOCK manifest версии `2026-09-10` допускает `root.targets`, вложенные `if`
  (`EVERY`, нулевые branch delays), `AND`/`OR`, characteristic conditions с
  опубликованными comparisons, service/set и delay `RESET`. Нужен хотя бы один
  `trigger=true`; одна характеристика не может быть условием и действием.
- Все `aId/sId/cId` и native types проверяются в настроенном доме. Новый BLOCK
  не принимает неизвестные поля; update обязан сохранить их без изменений.
  Семантическая сверка игнорирует `blockId` и runtime `if.state` только на
  известных путях BLOCK; одноимённые поля vendor-поддерева не отбрасываются.
- В API нет compare-and-set. Проверка baseline снижает риск, но не закрывает
  гонку между последним чтением и записью. Перед apply и восстановлением data
  заново проверяются применимые права, bindings и значения. Restore BLOCK
  разрешён только при совпадении текущей конфигурации с применённым снимком;
  ручная правка даёт conflict и сохраняется. Завершённый `restored` терминален
  для change ref; повторное изменение требует нового prepare.
- Сохранённое намерение различает apply и restore, а ACK относится только к
  текущей попытке. `verification.fresh=false` означает отсутствие нового
  readback: прошлый outcome и последнее наблюдение могут быть показаны, но не
  считаются текущей проверкой.

Специализированная публичная запись boolean source → boolean target остаётся
совместимым путём:

1. `preview_boolean_automation` заново читает source/target и владельцев поведения, строит native BLOCK и возвращает `change_ref`. Он не меняет хаб, но сохраняет локальную историю.
2. `apply_automation_change` повторно сверяет refs и конфликты. Не воспроизводите алгоритм equivalence по памяти: используйте фактический preview/status и его причину. Совместимый существующий BLOCK переиспользуется; близкий сценарий с несовместимыми runtime-флагами или семантикой даёт conflict, а не дубликат. В проверенном runtime `onStart` и `sync` должны быть выключены.
3. После отправки create неопределённый ответ сначала сверяется с хабом. Неизвестный исход остаётся `uncertain`.
4. `get_automation_change` перечитывает актуальный статус без изменения хаба.
5. `rollback_automation_change` удаляет только принадлежащий change объект с ожидаемой семантической конфигурацией. Ручная правка блокирует удаление; rollback сценария не возвращает физическое состояние устройства.

Для motion → light поддержан необязательный `auto_off_after_seconds`: native delay `RESET` переносит действие на полный срок при повторном входе в соответствующий delay-блок. Событие, после которого condition=false и delay не посещён, само по себе таймер не перезапускает. Это не доказательство времени последнего физического движения. [SprutHub Wiki о задержке, oldid 1333](https://wiki.spruthub.ru/index.php?title=%D0%97%D0%B0%D0%B4%D0%B5%D1%80%D0%B6%D0%BA%D0%B0_%D0%B2%D1%8B%D0%BF%D0%BE%D0%BB%D0%BD%D0%B5%D0%BD%D0%B8%D1%8F&oldid=1333).

Запись других options, logic, pairing, backup и произвольного кода/GLOBAL этим
контрактом не поддерживается. `window_option` подтверждает настройку хаба, но не
доставку до устройства и не физический результат после отключения питания.
Первый login настраивается локальным credential-файлом и не является native
change. Не подменяйте отсутствующие операции raw RPC или `write: true` в данных.
