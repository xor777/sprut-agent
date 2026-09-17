# Ручной приоритет света: disable-путь lifecycle-протокола LOGIC

P20260917-manual-light-lifecycle-probe. Подготовка к SPRUT-105 / пересмотр
Architect 6675. Это не household automation, не новый MCP и не разрешение на
живую запись. Один вопрос: после `logic_active=false` продолжают ли ранее
созданные timeout или `Hub.subscribeWithCondition` менять собственный On?

Удаление уже неактивных своих объектов — уборка, не отдельное доказательство
delete активного назначения. Бытовой результат 105 открыт. Реальную лампу,
BLOCK31, NIGHT, датчики, комнаты и очиститель не трогать.

## Источник и границы

- Base `3ed37bb58464dd1f467f2e6534fb458e60e6bc17`, комплект 0.1.39.
- SDK хаба 3.0.0/revision 20131, SHA-1
  `c54e25f642e8cc82cd774db7ea40f3f9c610d0ec28b78904172d08be085ad6d`:
  `Hub.getAccessory(aid).getService(sid).getCharacteristic(cid)`;
  `Hub.getCharacteristic(aid, cid)`; `subscribeWithCondition` и `setTimeout`
  возвращают `Task` с `clear()`. Source использует цепочку accessory/service/
  characteristic, чтобы задействовать все три операторских ID.
- IDs и одно `expiresAt` подставляются в
  `research/protocol/manual-light-lifecycle-source.mjs` **после** create+readback.
  `expiresAt` = время первой setup-записи + 5 мин, без продления новым trigger.
  Проверка границы — до подписки, записи On и arming.
- Brightness 10–19 → немедленный On=true. 20–29 → через 40 с On=false. 30–39 →
  `Task.clear()` своей подписки и своего timer. Каждый стимул — значение,
  отличное от текущего Brightness: повтор той же величины в консервативном
  стенде не даёт события.
- `Hub.subscribeWithCondition("", "", [HS.Lightbulb], [HC.Brightness], cb)` —
  форма community, не доказанная этим SDK-текстом. Если native вызов бросит —
  шаг inconclusive, не PASS остановки.
- Наблюдение — свежий `get_entity` On и время шага. `log.list`, raw RPC,
  CLI-driver и source-replacement не используются.
- Offline-тесты подменяют native границу по SDK. Они не доказывают остановку
  хабом.

## Setup, который ещё требует отдельного разрешения

В 0.1.39 нет публичного unlinked Lightbulb. Существующий
`SprutHubClient.createAccessory` / `deleteAccessory(id)` и наблюдённый payload
есть в [2026-09-11-virtual-light-group.md](2026-09-11-virtual-light-group.md).
После отдельного разрешения Architect создаёт ровно один объект:

```text
client.createAccessory({
  name: "lifecycle-probe",
  roomId: <число из inspect_home выбранной комнаты>,
  services: [{ type: "Lightbulb", name: "probe", optional: ["Brightness"] }]
})
```

Фиксировать returned `id`, `virtual !== false`, readback On/Brightness без
links. Lost create не повторять и не удалять по имени. T0 — эта первая запись.
Если после установки до `expiresAt` осталось меньше 120 с на измерение и
уборку — остановиться, окно не расширять. Удаление только по returned ID после
сверки ownership/relations.

Это не продуктовая MCP-приёмка и не автоматизация JSON-RPC на VM.

## Объекты будущего разрешения

Ровно: один временный unlinked virtual Lightbulb On/Brightness; один LOGIC
source `active=true` без назначения; одно неактивное назначение этого type на
созданный service, активация последней.

## Последовательность существующих tools

Каждый write-шаг: свежий `get_native_change_contract` той же `operation` и
`target_ref`, затем `prepare_native_change` / `apply_native_change`. Пустой или
несвежий read — inconclusive. Same-value `characteristic_value` не использовать
как стимул.

| t | Действие | Tool / аргументы | Стимул | Ожидание |
| --- | --- | --- | --- | --- |
| T0 | create accessory | `createAccessory` как выше | — | returned id; T0+5мин = `expiresAt` |
| T0+ | IDs | `get_entity(accessory_ref, include=["relations"])` | — | aid/sid/On cid/Brightness cid. Links, IN/OUT, чужое назначение — стоп |
| T0+ | fill | `fillLifecycleSource({accessoryId, serviceId, onCharacteristicId, brightnessCharacteristicId, expiresAt})` | — | source с фиксированным cutoff |
| T0+ | source | `prepare_native_change({operation:"logic_source_create", target_ref:service_ref, name:"lifecycle-probe", description:"temporary LOGIC lifecycle probe, not household automation", active:true, on_start:true, sync:false, source, reason})` → apply | — | mapping / `logic_assignment_ready`. Назначений ещё нет |
| T0+ | assignment | `prepare_native_change({operation:"logic_assignment", target_ref:logic_ref из available_logic_types})` → apply | — | создано **неактивным** |
| T0+ | start last | `prepare_native_change({operation:"logic_active", target_ref:assigned_logic_ref, value:true, reason})` → apply | — | запуск последним среди setup |
| T0+ | prepare disable | `prepare_native_change({operation:"logic_active", target_ref:assigned_logic_ref, value:false, reason})` **без apply** | — | change_ref держать до измерения. Уже false change не создаёт |
| T0+ | trigger | `prepare_native_change({operation:"characteristic_value", target_ref:on_ref, value:<смена текущего On>, reason})` → apply | гарантированная смена On | не надеяться только на onStart |
| +cb | callback control | `characteristic_value` Brightness в 10–19 ≠ текущему, сразу `get_entity(on_ref)` | напр. 11 | On=true до cutoff. Иначе abort |
| +tm | timer control | On=true; Brightness в 20–29 ≠ текущему; сразу On ещё true; через ≥40 с `get_entity` | напр. 22 | On=false до cutoff. Иначе abort |
| arm | armed timer | On=true; Brightness в 20–29 ≠ текущему | напр. 23 | On=true; зафиксировать deadline=now+40с |
| dis | disable | `apply_native_change({change_ref})` заранее подготовленного false; `get_entity(assigned_logic_ref)` | — | `active=false` **до** deadline. Позже / нет свежего readback — inconclusive. Не вооружать после disable |
| due | timer contrast | `get_entity(on_ref)` после deadline и до cutoff | — | On=true поддерживает остановку; On=false — живой timer |
| cb2 | callback contrast | On=false; Brightness в 10–19 ≠ текущему; сразу `get_entity` | напр. 12 | On=true — живой callback; false при прошедших контролях и до cutoff поддерживает остановку |
| dsp | explicit dispose | только если runtime продолжился: Brightness 30–39 ≠ текущему, затем свежий стимул/read | напр. 33 | снятие своей подписки+timer. Это **не** PASS native disable |
| cln | cleanup | см. ниже | — | только свои уже неактивные объекты |

Restore / delete, после сверки что source и назначение свои и relations без
чужих links:

1. Назначение уже `active=false` (измеренный disable). Иначе
   `restore_native_change(logic_assignment)` даёт
   `conflict: configuration_changed_after_creation` и delete не выполняется.
2. `restore_native_change` assignment-change — удаляет неактивное своё
   назначение.
3. `restore_native_change` source-change — удаляет source только без назначений
   (`logic_assignments_present` иначе).
4. `deleteAccessory(returned.id)` — не поиск по имени. Unknown/чужая
   конфигурация — остановить это удаление с точным остатком.

`characteristic_value` On/Brightness здесь команда: restore этих change не
использовать как возврат света. Если после удаления назначения/source
виртуальный accessory ещё существует и на нём делают read/stimulus — это только
сохранение уже установленной остановки, не доказательство delete активного
назначения.

## Что этот комплект не обещает

- Остановку runtime хабом. Simulator и vm не равны SprutHub.
- Delete активного назначения, реактивацию, второе окно, context/manualHold,
  NIGHT, MotionLightAutomation.
- Что callback-форма `subscribeWithCondition` совпадёт с живым хабом.
- Бытовой ручной приоритет офисной лампы.

Следующий live-scope — только эта таблица на одном своём unlinked Lightbulb,
после отдельного разрешения владельца. Иначе — нет.
