# Ручной приоритет света: малый lifecycle-протокол LOGIC

P20260917-manual-light-lifecycle-probe. Подготовка к SPRUT-105 / решение
Architect 6659. Это не household automation, не новый MCP и не разрешение на
живую запись. Один вопрос: после `logic_active=false` и после удаления
назначения продолжают ли ранее созданные timeout или
`Hub.subscribeWithCondition` менять собственный On?

Бытовой результат 105 открыт. Этот комплект не трогает реальную лампу, BLOCK31,
NIGHT, датчики, комнаты и очиститель.

## Источник и границы

- Base `3ed37bb58464dd1f467f2e6534fb458e60e6bc17`, комплект 0.1.39.
- Source: `research/protocol/manual-light-lifecycle-source.mjs`. IDs
  подставляются **после** `get_entity` созданного accessory, не с первого
  события. Trigger на On только регистрирует подписку и не пишет On.
- Brightness 11 — немедленный On=true (callback). Brightness 22 — через 5 с
  On=false (timeout). Brightness 33 — сброс своего timer Task, без снятия
  subscribe. Все записи только пока `Date.now() - startedAt < 5 мин`.
- `Hub.subscribeWithCondition("", "", [HS.Lightbulb], [HC.Brightness], cb)` —
  форма из community MotionLightAutomation `99a852fd`, не из живого
  `get_scenario_sdk` этого поручения. Если native вызов бросит — шаг
  inconclusive, не PASS остановки.
- Наблюдение — `get_entity` On и время шага. `log.list`, `log.subscribe`, raw
  RPC, CLI-driver, checkpoint и source-replacement не используются.
- Offline-тесты подменяют native границу. Они не доказывают остановку хабом.

## Недостающий публичный вызов

В 0.1.39 нет операции несвязанного virtual Lightbulb. Наблюдённый native
`accessory.create({name, roomId, services:[{type:'Lightbulb', name,
optional:['Brightness']}]})` есть в
[2026-09-11-virtual-light-group.md](2026-09-11-virtual-light-group.md);
`virtual_light_group` требует ≥2 участников и создаёт links — для этого опыта
нельзя. Платформу и raw RPC не добавляем. Живой старт после отдельного
разрешения возможен только когда Architect откроет публичный create (и его
restore) либо явно разрешит другой путь создания **одного** unlinked
Lightbulb. Пока объекта нет, шаги ниже не выполняют.

## Объекты будущего разрешения

Ровно: один временный virtual Lightbulb On/Brightness без links; один LOGIC
source; одно назначение этого type на созданный Lightbulb service.

## Последовательность существующих tools

После появления accessory с известным ref. Каждый шаг: tool, аргумент, время,
прочитанное On. Пустой/сбойный read — inconclusive.

1. `list_homes` → `inspect_home` → `get_entity(room_ref)`.
2. `get_entity(accessory_ref, include=["relations"])`. Из refs скопировать
   aid/sid/On cid/Brightness cid. Links, IN/OUT или чужое назначение — стоп,
   не delete по имени.
3. `fillLifecycleSource({accessoryId, serviceId, onCharacteristicId,
   brightnessCharacteristicId})`.
4. `get_native_change_contract` + `prepare_native_change`/`apply_native_change`
   `logic_source_create` на service ref, `active=false`, `on_start=true`,
   `sync=false`, source из шага 3. Дождаться mapping /
   `logic_assignment_ready`.
5. `logic_assignment` неактивным на созданный service; `logic_active=true`
   последним.
6. `get_native_change_contract(characteristic_value)` для On и Brightness.
7. Положительный callback: `characteristic_value` On=false, Brightness=11,
   сразу `get_entity(On)` → true. Не ждать таймер.
8. Положительный timeout: On=true, Brightness=22, сразу On ещё true; через ≥5 с
   и до expiry On=false.
9. `logic_active=false`. Исходное On=true, Brightness=22, через ≥5 с On всё ещё
   true. Затем On=false, Brightness=11, сразу On всё ещё false. Любая запись —
   runtime не остановился; Brightness=33 только гасит свой timer, это не
   teardown хаба.
10. Снова `logic_active=true`. Повторить шаг 7 или 8 — доказать активный
    экземпляр. Иначе delete не отдельный факт.
11. До restore: source и назначение свои, relations без чужих links. Restore
    в обратном порядке: `logic_active`, `logic_assignment`,
    `logic_source_create`. Accessory — restore будущего create-change, не
    поиск по имени. Наблюдения после delete — до 5 мин от startedAt.

Оставшийся инертный runtime без записи — ограничение, не доказанный cleanup.
Reboot не требуется и не засчитывается. Уборка операторская.
