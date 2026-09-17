# Пустой каталог extensionChild и статус провайдера

W20260917-extension-child-empty-list, 2026-09-17. Цель — зафиксировать
наблюдённую успешную пустую форму `extensionChild.list` и отличие от отказа
чтения, без приёмки MCP на живом хабе.

## Источники

- Architect, живой read-only прогон 17.09.2026 12:14–12:16 UTC: штатный
  вход/сессия и короткий исследовательский transport. Только
  `extension.list`/`get`, `extensionChild.list` и один
  `notificationClient.list`. Записей, createDialog, окон действий, подписок
  и writes не было. Подтверждение нативного протокола, не приёмка MCP и не
  прогон свежего агента.
- Официальный frontend `https://beta.spruthub.ru/js/app.16735171810a795a9f2d.js`,
  SHA-256 `81c1ef74ce21eb5ccff583255ba82fe766ff4cf6bc251c0566b7bd67436647f8`,
  1348618 байт, совпадает со снимком SPRUT-89 и прогоном 16 сентября.
- Предыдущий маршрут children:
  [2026-09-16-extension-child-read.md](2026-09-16-extension-child-read.md).

Сырые ответы, serial, имена дома, токены и адресаты в Git не сохранялись.

## Процедура

На живом хабе для выбранного Telegram вызывались `extension.get` и дважды
`extensionChild.list({extensionKey})`, затем один `notificationClient.list`.
Повтор live дал ту же форму списка. VM этот прогон не повторяла.

## Наблюдение

Для выбранного Telegram: `enabled=true`, `state=FAILED`, `childCount=0`;
одно space `type=SPACE_CHILDREN`, `key=main`.

`extensionChild.list` возвращает успешный
`{"id":1,"result":{"extensionChild":{"list":{}}}}` (дважды). Это не JSON-RPC
error и не отсутствие `result`/envelope. Поле `children` в валидном объекте
списка отсутствует.

Официальный app читает тот же общий каталог extension-space через
`extensionChild.list` и нормализует отсутствующее `children` в пустой массив.
Пустая выдача каталога совместима с нативным UI.

`notificationClient.list` отвечает `-32601`. Старые proto-декларации на этом
хабе не означают рабочий API; отдельный adapter для него не нужен.

## Подтверждённый вывод

Успешный пустой контейнер списка и явный `children:[]` — прочитанный пустой
каталог выбранной extension. Отсутствующие `result`/`extensionChild`/`list`,
`null` или не-массив `children`, чужая child identity, RPC-отказ и timeout —
не пустой каталог. `childCount` не заменяет прочитанный список. Наблюдаемая
пустота каталога данного provider не доказывает отсутствие любых получателей
в доме, причину `FAILED`, корректность реквизитов или доставку.

## Ограничения

Офлайн-тесты и это наблюдение не являются живой приёмкой MCP. Физическая
причина `FAILED` не установлена.

## Артефакты

Этот файл. Публичный контракт — `skills/spruthub-master/references/spruthub-contract.md`.

## Влияние на дом

Не изменялось.
