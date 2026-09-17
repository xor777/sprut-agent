# Чтение детей контроллера и штатных окон

W20260916-extension-child-read, 2026-09-16. Цель — зафиксировать рабочий
read-only маршрут к приборам выбранного контроллера вне списка комнат
до поставки MCP-навигации.

## Источники

- Architect, живой read-only прогон 16.09.2026: JSON-RPC без браузера и без
  записей. Подтверждение нативного протокола, не приёмка MCP.
- Официальный frontend `https://beta.spruthub.ru/js/app.16735171810a795a9f2d.js`,
  SHA-256 `81c1ef74ce21eb5ccff583255ba82fe766ff4cf6bc251c0566b7bd67436647f8`
  совпадает со снимком SPRUT-89.
- Protobuf: `research/protocol/2026-09-15-native-inventory/proto/79657-Extension.proto`,
  `69921-ExtensionChild.proto`.
- Обезличенная native-shaped подмена в `test/extension-children.integration.test.mjs`.

Сырые ответы, serial и имена дома в Git не сохранялись.

## Процедура

На живом хабе последовательно вызывались `extension.list`,
`extension.get({extensionKey})`, `extensionChild.list({extensionKey})`,
`extensionChild.get({extensionKey,id})` и `window.get({windowKey})` с ключом
из ответа child. `device.get` и `device.getAccessories` вызывались на той же
identity для контраста. Записей, discovery и pairing не было. VM этот прогон
не повторяла.

## Наблюдение

Каждый ответ приходит в `result.<domain>.<method>`. Список children — объект
`{children:[...]}`. Ключ окна берётся только из ответа.

Проверены CONTROLLER (spaces `main` и `discovery`) и BRIDGE (`main` и
`notConnected`). `online=true` встречается в `notConnected`; подключённый
child в `main` может иметь `online=false` и отдавать окно настроек.

Минимальная форма child без домашних идентификаторов:
`{extensionKey, spaceKey, id, name, online, optionsWindow, features, transports}`.
`groupId` и description optional. Space:
`{key, type: "SPACE_CHILDREN", label: {header, text, button}}`.

В окне связь с аксессуаром — read-only `inputType=ACCESSORY_LIST`,
`value.intValue=0` не является accessory id; связанные id только в
`validValues[].value.intValue`. Имя key не контракт. Writable
ACCESSORY_LIST на хабе не наблюдался: продукт не выдаёт
`linked_accessories` без `read=true` и `write!==true`, а смешанную
форму validValues не помечает частичным confirmed.

`device.get` и `device.getAccessories` ответили `-32601` Module not found.
Ошибка хаба может копировать служебный envelope.

## Подтверждённый вывод

Рабочий MCP-маршрут: list → get extension → list/get extensionChild →
window.get. `space_key` объясняет принадлежность, online — отдельный факт;
в ограниченной выдаче children `space_key` сохраняется в identity части.
ACCESSORY_LIST refs строятся только из read-only validValues.intValue.
device.* не использовать.

## Ограничения

Чтение конфигурации из хаба не доказывает свежий ответ физического прибора.
childCount не заменяет прочитанный список. Пустой список, `-32601`,
`request_rejected` и неполная форма — разные состояния. Наблюдение
успешного пустого `list={}` 17 сентября:
[2026-09-17-extension-child-empty-list.md](2026-09-17-extension-child-empty-list.md).
Офлайн-тесты не являются живой приёмкой.

## Артефакты

Этот файл. Публичный контракт — `skills/spruthub-master/references/spruthub-contract.md`.

## Влияние на дом

Не изменялось.
