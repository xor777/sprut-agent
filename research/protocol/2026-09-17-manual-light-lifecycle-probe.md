# Ручной приоритет света: протокольный опыт lifecycle LOGIC

P20260917-manual-light-lifecycle-probe. Подготовка к SPRUT-105 / решение
Architect 6639. Это не household automation, не новый MCP и не разрешение на
живую запись. Цель — один запускаемый оператором комплект, который после
отдельного разрешения владельца сможет наблюдать native lifecycle **одного**
назначения LOGIC и `Hub.subscribe` на временном виртуальном Lightbulb.

Бытовой результат 105 по-прежнему открыт: вручную включённая офисная лампа не
должна гаснуть от таймера отсутствия движения. Этот комплект не применяет
правило к реальной лампе и не закрывает приёмку.

## Источник и границы

- Base `3ed37bb58464dd1f467f2e6534fb458e60e6bc17`, комплект 0.1.39.
- SDK hub 3.0.0 revision 20131, 38010 bytes, SHA-256
  `1c54e25f642e8cc82cd774db7ea40f3f9c610d0ec28b78904172d08be085ad6d`.
- Нативные факты из брифа: `Hub.subscribe(handler,...):Task`,
  `setTimeout`/`clearTimeout`/`Task.clear`,
  `Characteristic.getValue/setValue/getType/getUUID/getService/getAccessory`,
  `Accessory.getUUID`. Форма callback `Hub.subscribe` в SDK не описана —
  source только логирует arity/shape, не выдумывает origin.
- `log.list({count})` → `result.log.list.log[]` с `time/level/path/message`.
  Отдельный `log.subscribe` не используется. Logging-level не меняется.
- Записей в реальные датчик/лампу/BLOCK31/очиститель/комнаты/режим дома нет.
  Сервер/хаб не перезапускается.

## Операторские команды

По умолчанию нет сети и нет мутаций:

```sh
node research/protocol/manual-light-lifecycle-probe.mjs
```

Каталог комнат, только чтение. Default VM `connection.env` не читается:

```sh
node research/protocol/manual-light-lifecycle-probe.mjs \
  --list-rooms --connection-env PATH
```

Живой опыт — только после отдельного разрешения владельца и явного
подтверждения. `room-id` берётся из предыдущей команды, не из домашнего
идентификатора в Git:

```sh
node research/protocol/manual-light-lifecycle-probe.mjs \
  --execute-live \
  --i-confirm-owner-permission \
  --room-id ROOM_ID \
  --connection-env PATH
```

Необязательно: `--timer-ms` (по умолчанию 3000, максимум 10000),
`--deadline-ms` (максимум 300000), `--checkpoint-dir`.

## Живой scope будущего разрешения

Создаётся ровно:

1. один временный virtual Lightbulb с optional Brightness, без links;
2. один LOGIC с уникальным маркером `sprut-probe:…` в source и description;
3. одно назначение этого type на созданный Lightbulb.

On — основной trigger. Brightness — искусственный вход для `Hub.subscribe`,
не модель физического датчика. Таймер короткий, не 60 секунд. Предел 5 минут.

Source генерируется **после** `accessory.create` и вшивает созданный numeric
id. До любых `setValue` проверяется `getAccessory().getUUID()`, а не имя.
Потерянный create-ответ не даёт права искать/удалять объект по имени: драйвер
останавливается и пишет компактный checkpoint без секретов и serial.

Очистка удаляет только подтверждённые собственные id. IN/OUT-связи, чужое
назначение, изменённый source или неизвестный id останавливают delete.

## Ожидаемые наблюдения

Пустой набор собственных маркеров — `inconclusive`, не успех и не доказательство
cleanup. Сырой log/context в вывод не попадают.

| Шаг | Положительный контроль | Отрицательный / граница |
| --- | --- | --- |
| `positive_timer` | `event=timer_fired` и/или On=false после короткого таймера | нет маркеров → inconclusive |
| `subscribe_brightness` | `event=subscribe_cb` и shape/arity без сырых значений | callback не разобран → `subscribe_unparsed`, origin не выдумывается |
| `clear_timer` | после On true→false нет нового выключения чужого объекта | поздний `timer_fired` после clear — stale Task |
| `deactivate` | нет новых own-действий на созданном On | `timer_fired` после deactivate — callback пережил inactive |
| `source_replacement` | новый source с тем же маркером; старый subscribe/timer молчит | старый `subscribe_cb`/`timer_fired` — нет auto-cleanup |
| `delete_assignment` | назначение отсутствует в `logic.list` созданного service | событие после delete — stale callback |
| teardown readback | accessory/scenario get отсутствуют | IN/OUT или чужой type → stop, checkpoint |

Не проверяется: реальный 60-секундный таймер, движение, рестарт хаба, два
назначения, variables между двумя service, BLOCK31, физическая лампа.

## Offline smoke

`research/protocol/manual-light-lifecycle-probe.test.mjs` проверяет отказ от
записи в заранее заданные id, отказ delete по имени/при потерянном create,
остановку teardown при чужих links и то, что source фильтрует созданный id.
Это не поддельный JS-runtime хаба и не доказательство native поведения.

## Влияние на дом

В этой подготовке — ноль. Живой запуск этого файла в данном поручении
запрещён. Отдельное разрешение запрашивает Architect после приёмки комплекта.
