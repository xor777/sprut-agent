# Теневой кандидат ручного приоритета офисного света

P20260917-manual-light-shadow. Подготовка SPRUT-105 / решение Architect 6701.
Это не household apply, не новый MCP и не разрешение на живую запись. Main
0.1.39 / `3ed37bb58464dd1f467f2e6534fb458e60e6bc17` не менялся.

Бытовой вопрос, который этот кандидат должен уметь показать на виртуальной
лампе: ручное On держится до ручного Off; автоматическое On от движения гаснет
через 60 с без движения; `SecuritySystemTargetState = 2` (NIGHT) остаётся
условием и само свет не включает.

## Источник

- Upstream MotionLightAutomation
  [`99a852fd12567720730c05e11032f3cafc1a020d`](https://github.com/KirillAshikhmin/Sprut.Hub_Tools/blob/99a852fd12567720730c05e11032f3cafc1a020d/MotionLightAutomation/source/MotionLightAutomation.js),
  SHA-256 `4737a6b455ae5c86e795c2b5f59057872736293dbf64f295eef78cc9184d1244`.
  MIT, Copyright (c) 2025 Kirill Ashikhmin. Файл вендорится без правок в
  `manual-light-shadow-upstream.txt`; текст лицензии —
  `manual-light-shadow-LICENSE.txt`.
- Две узкие правки NIGHT из разбора 6658, без новых опций:
  1. picker `gateAutoSwitch` принимает `SecuritySystem` /
     `SecuritySystemTargetState`;
  2. `isAutoAutomationAllowed` для этого типа разрешает только значение `2`.
     Смена режима не вызывает `tryAutoTurnOn`.
- Параметры назначения, не кода: `noAutoOffWhenManualOn=true`,
  `manualHoldSafetyOffDelayMinutes=0`, `offDelaySeconds=60`, manual/lux пустые,
  `debug=false`, `noAutoOnAfterManualOff=false`.
- Исследовательская изоляция в `fillManualLightShadowSource`: IDs и `expiresAt`
  подставляются после create+readback, не с первого события. Все native
  `setValue` в source идут через `setLightOn`; обёртка пишет только заполненный
  service UUID `aId.sId` и только до expiry/disposal. `Hub.subscribeWithCondition`
  и `setTimeout` сохраняются как Task; `disposeShadow` снимает их через
  `Task.clear()` или `clearTimeout`. Callback после expiry/disposal не пишет и
  не логирует. Это не production lifecycle и не обещание, что native disable
  освобождает runtime.

SDK хаба 3.0.0/revision 20131, SHA-256
`1c54e25f642e8cc82cd774db7ea40f3f9c610d0ec28b78904172d08be085ad6d`
([2026-09-09-automations.md](2026-09-09-automations.md), факты 6675):
`Hub.getAccessory(id).getService(id).getCharacteristic(id)`;
`Hub.getCharacteristic(aid, cid)`; `subscribeWithCondition` и `setTimeout`
возвращают `Task` с `clear()`. Форма callback `subscribeWithCondition` и
`context` для `isSelfChanged` этим текстом не доказаны. Кандидат сохраняет
community-вызов библиотеки и совместимый `clearTimeout`/`Task.clear`; live
расхождение — incomplete, не догадка.

## Offline evidence

`research/protocol/manual-light-shadow-source.test.mjs` гоняет заполненный
source в стандартном `node:vm`. Проверяет: NIGHT как условие; смена NIGHT не
включает свет; safety=0 не гасит внешнее On; чужой Lightbulb не получает
запись; после `expiresAt` нет write/log. Это подмена native границы, не хаб.
Авто-Off после авто-On в тесте использует community-форму
`LOGIC… <- C… <- LOGIC…`. Если живой `context` не таков, авто-On станет
ручным удержанием — это условие остановки пути, не чинится здесь.

## Объекты будущего разрешения

Ровно: один временный unlinked virtual Lightbulb On/Brightness в комнате офиса;
один LOGIC source; одно назначение этого type на созданный service, активация
последней. Реальные MotionDetected и SecuritySystem только как LIST-refs
чтения. Физическая лампа, BLOCK31, датчики, режим, комнаты и очиститель не
меняются.

В 0.1.39 нет публичного unlinked Lightbulb. `virtual_light_group` создаёт
links на реальные лампы и для тени запрещён. Create/delete — существующий
`SprutHubClient` по наблюдённому
[2026-09-11-virtual-light-group.md](2026-09-11-virtual-light-group.md), не новый
транспорт:

```js
createAccessory({
  name, // native trims to 30 chars
  roomId, // office room, numeric hub id
  services: [{ type: "Lightbulb", name, optional: ["Brightness"] }],
})
```

После `createAccessory` сразу `get_entity(accessory_ref)` с relations и
`assigned_logics`. Стоп, без удаления по имени, если: нет returned id;
`virtual === false`; есть links; есть любое назначение, которого этот прогон
не создавал. Штатные типы вроде `SmoothBrightnessChange` / `LightbulbControl`
могут быть в `available_logic_types`; их наличие не есть назначение. Поведение
активного default assignment на новом виртуальном объекте не объявляем
известным — при таком назначении опыт останавливается.

Lost create не повторять и не искать объект по имени.

## Группы вызовов будущего опыта

Это предложение scope до 30 мин, не разрешение. Счёт идёт группами смысла,
не сырыми RPC. Каждая публичная запись: свежий
`get_native_change_contract` той же `operation` и точного target, затем
prepare/apply. Повтор контракта на уже подтверждённом том же ключе не
добавляет отдельную группу.

| Группа | Действие | Вызовы | Обязательное ожидание |
| --- | --- | --- | --- |
| R1 | Каталог: `list_homes`, `inspect_home`, адресные `get_entity`/`read_services` офисного Motion, SecuritySystem, текущей лампы/BLOCK31 | 1 list + 1 inspect + 3–5 чтений | нет |
| C1 | Operator `createAccessory` + `get_entity` identity/relations/assigned_logics | 1 client create + 1 MCP read | нет |
| L0 | Локально `fillManualLightShadowSource({aId,sId,On cId,expiresAt})`. `expiresAt` = время C1 + 30 мин | 0 | нет |
| W1 | `logic_source_create` на service виртуальной лампы, `active=true`, `on_start=true`, `sync=false` | 1 write-group | readback |
| R2 | Mapping / `available_logic_types` | 1 read | нет; нет mapping — стоп |
| W2 | `logic_assignment` неактивным | 1 write-group | readback |
| R3 | `get_entity(logic_ref, include=["options"])` фактические LIST/NUMBER/CHECKBOX | 1 read | нет |
| W3 | До 5 `logic_option`, только отличия от прочитанного: `motion1`, `gateAutoSwitch`, `offDelaySeconds=60`, `noAutoOffWhenManualOn=true`, `manualHoldSafetyOffDelayMinutes=0` | ≤5 write-groups | readback каждого |
| W4 | `logic_active=true` последней | 1 write-group | readback |
| O1 | `start_native_observation` на virtual On, MotionDetected, SecuritySystem target и `scenario_ref` своего LOGIC, 300 с / 500 событий. Забрать через `get_native_observation` до следующего observation или выхода MCP. Учитывать `completion_reason`, `connection`, `truncated` | 1 start + poll `wait_seconds≤20` до конца | до 300 с; внутри — живое движение и 60 с тишины |
| W5 | Внешнее On виртуальной лампы: `characteristic_value` | 1 write-group | нет секундомера apply |
| O2 | Второе такое же observation-окно | 1 start + poll | до 300 с; движение/тишина при удержании |
| W6 | Внешнее Off виртуальной лампы | 1 write-group | нет |
| K1 | Cleanup: `restore_native_change` owned change_refs newest-first (`logic_active`, options, assignment, source), then `deleteAccessory(returned id)` | restore of W1–W4 groups + 1 client delete | нет reboot |

Сумма строк таблицы, не отдельный прогноз «N tools»: W1–W6 ≤10 write-groups;
K1 возвращает те же owned change_refs; 2 operator client (create+delete);
чтения R1/R2/R3; два окна O1/O2. Обязательных ожиданий два: O1 и O2 ≤300 с.
Отдельного 40-секундного apply нет. Active-delete не используется: назначение
снимается уже неактивным. Сырой `log.list` не читается. Отсутствие события не
доказывает отсутствие команды: для отрицательного вывода нужны живой вход,
различимое исходное значение, полное окно и не `connection_lost`/`truncated`.

Если к старту O1 режим не NIGHT или естественного движения нет — `incomplete`,
без смены режима, без записи в датчик и без бесконечного ожидания. Native
disable наблюдать только если эпизод доступен внутри этих окон; он не блокер.

## Конечная проверка после отдельного согласия

1. Контроль: реальное движение при NIGHT → virtual On=true; после исчезновения
   движения → On=false спустя ~60 с.
2. Внешнее On удерживается через движение и тишину >60 с; снимается внешним Off.
3. NIGHT не изменён этим прогоном и сам не создаёт On.

Не проверяем физическую офисную лампу. Не обещаем, что `logic_active=false`
убил callback; изоляция — expiry/disposal source. Отсутствие подписки после
delete не доказано.

## Cleanup и остаток runtime

Удалять только свои объекты по returned IDs после checks. Restore source
блокируется, пока есть назначения. После delete не считать runtime свободным.
Reboot запрещён.

## Что этот комплект не обещает

- Бытовой PASS на настоящей лампе и отключение BLOCK31.
- Native форму `context` / `isSelfChanged`.
- Что disable/delete назначения останавливает Task.
- Поведение штатных predefined LOGIC, если хаб назначит их сам.
- Что `service.getUUID()` на живом хабе равен `aId.sId`; при расхождении
  изоляция fail-closed (нет записи), опыт incomplete.
