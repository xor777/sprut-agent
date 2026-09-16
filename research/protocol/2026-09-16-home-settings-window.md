# Корневое окно настроек дома: пустой optionsWindow

O20260916-home-settings-window, 2026-09-16. Цель — зафиксировать read-only
маршрут к часам и поясу выбранного хаба для SPRUT-77. Идентификаторы ниже
вымышлены. VM живой хаб не читала.

## Источники

- Architect, живой JSON-RPC read-only прогон 16.09.2026: `hub.list`/`hub.get`
  возвращают `optionsWindow:""`; `window.get({windowKey:""})` возвращает
  корневое окно. Пустая строка — действительный opaque key, не отсутствие и не
  fallback. Подтверждение нативного протокола, не приёмка MCP.
- Официальный frontend `https://beta.spruthub.ru/js/app.16735171810a795a9f2d.js`,
  SHA-256 `81c1ef74ce21eb5ccff583255ba82fe766ff4cf6bc251c0566b7bd67436647f8`.
  Settings делает `String(hub.optionsWindow)` и `window.get`.
- Protobuf: `research/protocol/2026-09-15-native-inventory/proto/77267-Hub.proto`
  (`HubMessage.optionsWindow`), `18793-module-18793.proto` (`InputType` FOLDER,
  STATUS, LIST). JSON/protobuf сравнение не дало иной модели: в protobuf
  значение по умолчанию опущено.
- Обезличенная native-shaped подмена в `test/home-settings.integration.test.mjs`.

Полное живое окно в Git не сохранялось: там сеть, пользователи и чувствительные
настройки.

## Наблюдение

Иерархия clock: GROUP `main` → FOLDER `datetime` → GROUP `clock`. В clock:
TimeZone (`GenericString`, LIST, read/write, `stringValue=Europe/Moscow`);
Time (`GenericString`, STATUS, read-only, строка вида
`2026-09-16 - 09:17:28 (GMT+03:00)`); Sunrise/Sunset — STATUS; DateAndTimeInfo —
INFO. NTP1/2 — TEXT под ntp. Наличие NTP-серверов не доказывает успешную
синхронизацию. 5 секунд ожидания hub-events дополнительного результата не дали.

## Подтверждённый вывод

Рабочий MCP-маршрут: `list_homes`/`inspect_home` сохраняют возвращённую ссылку
на окно, включая пустой ключ, затем `get_entity` этого ref вызывает
`window.get({windowKey:""})`. Отсутствие/`null` отдельно от подтверждённой
пустой строки. Корневое окно в этом срезе read-only: native `write:true` не
открывает `window.update`.

Официальный frontend для extension рисует настройки только при truthy
`optionsWindow`, для accessory — при truthy `deviceWindow`. Пустая строка у
этих владельцев — отсутствие окна прибора, не корневой ключ хаба. Живого
пустого `deviceWindow`/`optionsWindow` у accessory/extension на хабе не
наблюдалось; JSON-RPC сериализатор для non-optional string уже отдавал `""`
у `Hub.optionsWindow`.

## Ограничения

Чтение не доказывает точность часов, физический runtime расписаний или
календарный перевод. Офлайн-тесты не являются живой приёмкой MCP на хабе.
Сырое полное окно агенту не возвращается.

## Артефакты

Этот файл. Публичный контракт — `skills/spruthub-master/references/spruthub-contract.md`.

## Влияние на дом

Не изменялось.
