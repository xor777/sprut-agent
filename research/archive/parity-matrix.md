# Sprut.hub functional parity matrix

> Архив исследования. Текущий объём работ и ограничения — в [README](../../README.md).
> Полный паритет не является условием первого работающего среза.

Статус: первичная матрица из web-клиента `1.5.58`.

Легенда:

- `S` — endpoint и типы есть в snapshot схемы;
- `U` — функция подтверждена интерфейсом;
- `O` — wire frame записан;
- `R` — endpoint воспроизведён отдельным клиентом;
- `W approval` — проверка требует отдельного разрешения пользователя.

На текущем этапе заполнены только `S` и `U`.

| Поверхность | Read / observe | Write / action | Evidence | Следующее доказательство |
|---|---|---|---|---|
| Авторизация | `account.auth`, `account.answer`, `account.get` | `account.changePassword`, `account.delete` | `S`, login UI `U` | Записать login state machine без сохранения credentials |
| Дома / хабы | `hub.list`, `hub.get`, `hub.getOptions`, `hub.pool`, `hub.supportInfo` | `hub.add`, `hub.delete`, `hub.setOptions`, `hub.discovery`, `hub.restart`, `hub.upgrade` | `S`, hub switcher `U` | Baseline frames; write только с approval |
| Комнаты | `room.list`, `room.get`, `room.subscribe` | `room.create`, `room.update`, `room.orders`, `room.delete` | `S`, room UI `U` | Baseline list/events |
| Accessories | `accessory.list`, `accessory.get`, `accessory.subscribe`, `accessory.supportInfo` | `accessory.create`, `accessory.update`, `accessory.delete`, `accessory.stream` | `S`, cards `U` | Read fixture одного обезличенного accessory |
| Services | `service.list`, `service.get`, `service.types`, `service.subscribe` | `service.update`, `service.orders` | `S`, service tiles `U` | Types + expanded accessory fixture |
| Characteristics | `characteristic.list`, `characteristic.get`, `characteristic.types`, `characteristic.getOptions`, `characteristic.subscribe` | `characteristic.update`, `characteristic.setOptions` | `S`, controls/sensors `U` | Passive event; затем approved reversible write |
| История | `history.list` | — | `S`, accessory menu `U` | Sanitized read fixture |
| Связи | `link.list` | `link.add`, `link.addVirtual`, `link.remove` | `S`, accessory settings `U` | Read link graph |
| Логика устройства | `logic.list`, `logic.get`, `logic.types`, `logic.getOptions` | `logic.create`, `logic.update`, `logic.delete`, `logic.setOptions`, `logic.setActive` | `S`, accessory settings `U` | Read logic fixture |
| Контроллеры | `controller.list`, `controller.get`, `controller.types`, `controller.getOptions`, `controller.getScanResult` | create/update/delete/options, discovery, exclusion, scan, mesh/heal operations | `S`, `/controllers` `U` | Controller list frames; actions require approval |
| Controller devices | `device.list`, `device.get`, `device.getInfo`, `device.getMesh`, `device.getOptions`, `device.getAccessories`, `device.supportInfo` | create/delete/options, identify, reset, join, heal, discovery, firmware | `S`, device cards `U` | Read device fixture; no physical actions |
| Мосты | `bridge.list`, `bridge.get`, `bridge.getOptions`, legacy read methods | create/update/delete/options and service links | `S`, `/bridges` `U` | Bridge + bridgeService list frames |
| Bridge services | `bridgeService.list`, `bridgeService.get` | `bridgeService.create`, `bridgeService.delete` | `S`, linked services `U` | Read export graph |
| Сценарии | `scenario.list`, `scenario.get`, `scenario.getOptions`, `scenario.sdk`, subscribe/unsubscribe | create/update/delete/options/orders, `scenario.run` | `S`, `/scenarios` `U` | Read scenario fixtures; run requires approval |
| Уведомления | notification/client list/get/getOptions/types | create/update/delete/setOptions | `S`, `/notifications` `U` | Read provider/client graph |
| Каталог | `catalog.list`, `catalog.get`, `catalog.types`, `catalog.scheme` | `catalog.create`, `catalog.update`, `catalog.delete` | `S`, `/catalogs` `U` | Read schema and item fixture |
| Bundles / extensions | bundle/extension list/get/getOptions | create instance, delete, setOptions | `S`, indirect UI `U` | Map add-extension UI to endpoints |
| Диагностика и файлы | `file.backups`, `file.logs`, `file.devInfo`, `file.filePart`, `log.list`, log subscribe/unsubscribe | file completion, `log.print` | `S`, device menu/settings `U` | Read metadata without downloading sensitive files |
| Server | `server.clientInfo`, `server.version`, `server.pool` | disconnect/restart/upgrade | `S`, settings `U` | Baseline/version frames |
| События | room, accessory, service, characteristic, device, link, logic, server, file, log, scenario, controller, bridge, bridgeService, notification, notificationClient, hub, cloud, extension | — | `S` | Записать пассивный event stream |

## Parity gate

Полный паритет считается достигнутым не по числу реализованных RPC, а когда
для каждой доступной UI-функции:

1. известен endpoint и точный wire type;
2. есть sanitized observed fixture;
3. отдельный клиент воспроизводит read/action;
4. подтверждены error и reconnect semantics;
5. для write известны precondition, postcondition и rollback;
6. функция имеет явную policy для AI-агента.

Опасные действия могут иметь полный контрактный паритет без запуска на
реальном доме: schema + observed UI/client code + безопасный mock/replay.
