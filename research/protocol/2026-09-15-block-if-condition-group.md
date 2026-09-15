# Форма `if.if` штатного BLOCK-редактора: 2026-09-15

## Источник и область

Статическое чтение официального frontend asset
`https://beta.spruthub.ru/js/app.16735171810a795a9f2d.js`, SHA256
`81c1ef74ce21eb5ccff583255ba82fe766ff4cf6bc251c0566b7bd67436647f8`
(совпадает с inventory SPRUT-89). Это `S`, не live write. Полный bundle не
хранится.

Дополнительный бытовой контекст — PM C / SPRUT-85 на
`a0d8272d3627eb47df0e3a9616cab0a84af651bd` (0.1.27): два
`block_data_update` с непосредственным `if.if.type=characteristic` вернули
публичный `request_rejected`; последующее создание через boolean lifecycle
сохранило `condition/AND` с одним characteristic. Update и create различались,
поэтому пара не объявляется исчерпывающей причиной отказа.

## Наблюдение схемы

Объект FR `$id http://makesimple.org/schema/if` задаёт `properties.if` как
`$ref http://makesimple.org/schema/condition`. MR condition требует
`type=condition`, `mode` `OR|AND` и массив `conditions`. WR допускает
`characteristic` внутри `conditions`. Add-fork редактора создаёт
`if:{type:condition,mode:OR,conditions:[]}`.

## Вывод и предел

Каноническая форма штатного редактора для предиката ветки — группа condition,
а не непосредственный leaf. AND и OR с одним условием структурно эквивалентны.
Same-index update этой формы на живом хабе этим наблюдением не подтверждён.
Неизвестный узел или соседнее поле из этой схемы не выводятся.
