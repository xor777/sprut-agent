# Кнопки окон, Telegram, координатор ZigBee и резервные копии на хабе 3.0.0

O20261125-backup-and-window-buttons, 2026-11-25. Цель: зафиксировать живые
наблюдения на хабе владельца перед и во время волны 3 — нажатие кнопки окна,
диагностика и вход Telegram, отличие координатора ZigBee от обычных устройств,
а также реальное поведение `CreateBackup` и `file.backups` без внешней SD-карты.

Продолжает [2026-10-23-window-buttons.md](2026-10-23-window-buttons.md) и п. 4
[2026-10-13-wave4-contracts.md](2026-10-13-wave4-contracts.md).

## Источники и полномочия

- Живой хаб владельца: Sprut.hub 2, прошивка `3.0.0` (ревизия `20131`, ветка
  `beta`). Уровень `O`.
- Чтения и записи выполнялись через `SprutHubConnection` / собранный MCP-сервер
  `dist/plugin/dist/server.mjs` (`main` `588ceef` / `52088d4`); для пробы
  `file.backups` использован один JSON-RPC WebSocket с тем же сеансом.
- Полномочия владельца:
  - read-only чтения окон Telegram, AppStore, термоголовок, Xiaomi и ZigBee;
  - создание и немедленное удаление одного собственного временного GLOBAL-сценария;
  - явное разрешение владельца (25.11.2026) на починку Telegram (`Login`) и
    однократное создание резервной копии.
- Секреты (токены, пароли, логины, serial, IEEE-адреса, IP, SSID) в этот файл
  не записывались.

## Наблюдения

### 1. Протокол нажатия кнопки окна (`window.update`)

| № | Наблюдение | Ур. |
| --- | --- | --- |
| W1 | На собственном временном GLOBAL-сценарии `window.update({windowKey, options: [{key: "Remove", value: {boolValue: true}}]})` вернул пустой ACK (`undefined`). | O |
| W2 | Через 0,8 с `scenario.get` вернул `null` (сценарий удалён), `scenario.list` совпал с начальным списком дома (`23 → 23`), а `window.get` удалённого окна вернул ошибку протокола `request_rejected` (а не `null`). | O |

### 2. Telegram (`Notification:telegram_1`, `v0.3.2`)

| № | Наблюдение | Ур. |
| --- | --- | --- |
| T1 | Окно `Notification/telegram_1/` в состоянии `FAILED` (`enabled: true`, 0 чатов) содержит `label.error: "Ошибка загрузки"`. | O |
| T2 | Кнопка `Login` (`BUTTON` «Войти») имеет `visible: true`, `Logout` (`BUTTON` «Выйти») — `visible: false`. При `ProxyType: "NONE"` поля `ProxyHost`, `ProxyPort`, `ProxyLogin`, `ProxyPassword` имеют `visible: false`. | O |
| T3 | В магазине хаба (`Plugin/appstore_1/apps/notification_telegram/`) для установленного Telegram `0.3.2 (Beta)` видна кнопка `Update` (`BUTTON` «Обновить до 0.4.7», `visible: true`); `Install`, `Restart`, `Add` имеют `visible: false`. | O |
| T4 | Нажатие `Login` через `dist/plugin/dist/server.mjs` (`window_button`) принято хабом за ~20 мс (пустой ACK). Сразу после ACK и через 4 с `state` оставался `FAILED`. | O |
| T5 | Ровно через 10,1 с после ACK в журнале хаба появились две записи: `error` от `com.spruthub.apps.telegram.TelegramPlugin` (содержала путь с токеном бота — скрыта `sprut-agent` как `[REDACTED]`) и `info` от `Notifiers.Notifier`: `"telegram_1: Telegram - Ошибка сервера Telegram: 504"`. При `BotApiUrl: "https://api.telegram.org"` и `ProxyType: "NONE"` прямой запрос уходит в 10-секундный таймаут. | O |

### 3. Координатор ZigBee и термоголовка

| № | Наблюдение | Ур. |
| --- | --- | --- |
| Z1 | Координатор ZigBee (`name: "Sprut.hub"`, `features: null`, `online: true`) присутствует в `Controller:zigbee_1` как обычный ребёнок `Controller/zigbee_1/Child/<ieee>/` и имеет **видимую, активную кнопку `Remove` (`BUTTON_DANGER`)**. | O |
| Z2 | В опции `Info` (`HTML`) координатора указан короткий сетевой адрес `0000`: `Address: <ieee>/0000<br>...` (по стандарту ZigBee `0x0000` всегда координатор). У обычных устройств короткий адрес ненулевой (например, `/73AE`). | O |
| Z3 | У одного недоступного ZigBee-ребёнка и у неподключённого Xiaomi-ребёнка (`discovery`) опция `AccessoriesList` (`ACCESSORY_LIST`) не содержит поля `validValues` (в protobuf3 пустой repeated-список опускается). | O |
| Z4 | В окне термоголовки кнопка `/1/FCC0_ManufacturerSpecific/0270_ThermostatValveCalibration/false` (`BUTTON` «Калибровка клапана`, `boolValue: false`) соседствует с read-only опцией `/1/FCC0_ManufacturerSpecific/027B_ThermostatValveCalibrationStatus/1` (`LIST` «Статус калибровки»: `0` Не готово, `1` Готово, `2` Ошибка, `3` В процессе). | O |

### 4. Резервные копии хаба (`CreateBackup` vs `file.backups`)

| № | Наблюдение | Ур. |
| --- | --- | --- |
| B1 | В окне настроек хаба (`windowKey: ""`) до пробы: `CreateBackup` (`BUTTON`, `read: false`, `write: true`, `validValues: [{name: "Создать", value: {intValue: 1}}]`), `BackupProgress` (`PROGRESS_BAR`, `visible: false`, `0`), `Restore` (`LIST`, 4 старых копии от `11.10`, `09.10`, `01.09`, `03.06.2026`, все с подписью `· 0 МБ`). Внешняя SD-карта на хабе отсутствует (`ExtStorage` скрыт). | O |
| B2 | `window.update({windowKey: "", options: [{key: "CreateBackup", value: {intValue: 1}}]})` вернул пустой ACK за 11 мс. На 0,8–1,9 с `BackupProgress` стал `visible: true, value: 100`, к 4,0 с вернулся в `visible: false, value: 0`, но список `Restore` не изменился (остались те же 4 копии). | O |
| B3 | В журнале хаба в момент пробы `CreateBackup` появилась запись `info` от `Notifiers.Notifier`: `"Резервная копия не записана: внешний накопитель (недоступно) - проверьте подключение накопителя."`. Кнопка `CreateBackup` на хабе без внешнего накопителя молча не создаёт копию. | O |
| B4 | `file.backups {}` без внешней SD-карты сработал за 0,66 с: ответ `file.backups` за 257 мс (`{loc: "LOC_TMP", path: <непустая строка>, scope: "tmp"}`), затем на 661 мс пришло push-событие `file` (`{success: true, loc: "LOC_TMP", path: <совпал>, length: 3241993, scope: "tmp"}`). | O |
| B5 | `file.filePart({loc: "LOC_TMP", path, start: 0, length: 64, scope: "tmp"})` вернул 64 байта в base64 с заголовком ZIP (`504b0304`, `PK\x03\x04`). | O |
| B6 | `file.complete({loc: "LOC_TMP", path, scope: "tmp"})` вернул пустой ACK без ошибок. Список `Restore` на хабе при этом не изменился (`file.backups` создаёт скачиваемый архив во временной области `LOC_TMP`, а не на внешнем накопителе). | O |

## Выводы для реализации волны 3

- **Удаление физического устройства (`3.2`):** обязательно защищать
  координатор ZigBee по `Address: .../0000` в `Info`; отсутствие `validValues`
  в `AccessoriesList` отличать для `discovery` и `main`; при post-ACK чтении
  удалённого окна трактовать `request_rejected` как `window_absent: true`.
- **Резервная копия (`3.4`):** рабочий путь без внешней SD-карты —
  `file.backups` → ожидание события `file` → скачивание частями `file.filePart`
  → обязательный `file.complete` в `finally`, с сохранением ZIP локально
  (`0600`) без чтения содержимого архива агентом. Кнопка `CreateBackup` без
  внешнего накопителя не создаёт копию и не подходит как универсальная страховка.

## Ограничения

- Один хаб, прошивка `3.0.0` rev `20131`, без внешнего накопителя.
- Живое удаление физического ZigBee/Xiaomi-устройства и живая калибровка
  клапана термоголовки не выполнялись.
- При `file.backups` скачивались только первые 64 байта для проверки ZIP-заголовка;
  полная многочастевая загрузка (~25 чанков по 128 КБ) будет проверена при
  приёмке шага 3.4.

## Влияние на дом

- Временный GLOBAL-сценарий удалён нажатием `Remove`; состав сценариев до и
  после совпал (`23 → 23`).
- `Login` в Telegram отправлен с разрешения владельца; состояние осталось
  `FAILED` (`504`).
- `CreateBackup` и `file.backups` выполнены с разрешения владельца; `file.complete`
  удалил временный архив, настройки и список `Restore` не изменились.
