// Synthetic two-storey house: the apartment (same room, accessory and
// scenario ids, so its cases grade unchanged) plus a second storey, service
// rooms and a yard. Sizes follow the owner's home at double scale (2026-09-24:
// 13 rooms, 80 accessories, 254 services, 23 scenarios; the home is expected
// to double): 22 rooms, 172 accessories, 505 services, 42 scenarios, with
// its service type mix. Names, ids and values are invented. New rooms avoid
// the words the apartment cases rely on (спальня, гостиная, кухня, ванная,
// коридор, кабинет), so a household request keeps one meaning.

const ZIGBEE = "Controller:zigbee";

const ROOMS = [
  [9, "Холл второго этажа"],
  [10, "Лестница"],
  [11, "Гостевая комната"],
  [12, "Комната Маши"],
  [13, "Комната Коли"],
  [14, "Гардеробная"],
  [15, "Санузел второго этажа"],
  [16, "Постирочная"],
  [17, "Котельная"],
  [18, "Мастерская"],
  [19, "Терраса"],
  [20, "Гараж"],
  [21, "Двор"],
  [22, "Сауна"],
];

let nextId = 101;

function accessory(roomId, name, services, extra = {}) {
  const id = nextId++;
  return {
    id,
    roomId,
    name,
    extensionKey: ZIGBEE,
    deviceId: `00158d0005${id.toString(16).padStart(6, "0")}`,
    manufacturer: extra.manufacturer ?? "Sprut",
    model: extra.model ?? "SIM-1",
    ...(extra.battery === undefined ? {} : { battery: extra.battery }),
    services: services.map((service, index) => {
      const sId = 13 + index * 10;
      return {
        sId,
        type: service.type,
        name: service.name,
        characteristics: service.characteristics.map(([type, value], at) => ({
          cId: sId + 1 + at,
          type,
          value,
        })),
      };
    }),
  };
}

const light = (name, on = false, brightness = 80) => ({
  type: "Lightbulb",
  name,
  characteristics: [
    ["On", on],
    ["Brightness", brightness],
  ],
});
const colorLight = (name, on = false) => ({
  type: "Lightbulb",
  name,
  characteristics: [
    ["On", on],
    ["Brightness", 60],
    ["Hue", 30],
    ["Saturation", 50],
    ["ColorTemperature", 370],
  ],
});
const relay = (name, on = false) => ({
  type: "Switch",
  name,
  characteristics: [["On", on]],
});
const button = (index) => ({
  type: "StatelessProgrammableSwitch",
  name: `Кнопка ${index}`,
  characteristics: [
    ["ProgrammableSwitchEvent", 0],
    ["ServiceLabelIndex", index],
  ],
});
const thermostat = (name, current, target = 24) => ({
  type: "Thermostat",
  name,
  characteristics: [
    ["CurrentHeatingCoolingState", 0],
    ["TargetHeatingCoolingState", 0],
    ["CurrentTemperature", current],
    ["TargetTemperature", target],
  ],
});
const slat = (name, angle = 0) => ({
  type: "Slat",
  name,
  characteristics: [
    ["SlatType", 0],
    ["CurrentSlatState", 0],
    ["CurrentTiltAngle", angle],
    ["TargetTiltAngle", angle],
  ],
});
const temperature = (value) => ({
  type: "TemperatureSensor",
  name: "Температура",
  characteristics: [["CurrentTemperature", value]],
});
const humidity = (value) => ({
  type: "HumiditySensor",
  name: "Влажность",
  characteristics: [["CurrentRelativeHumidity", value]],
});
const contact = (name) => ({
  type: "ContactSensor",
  name,
  characteristics: [["ContactSensorState", 0]],
});
const motion = () => ({
  type: "MotionSensor",
  name: "Движение",
  characteristics: [["MotionDetected", false]],
});
const leak = () => ({
  type: "LeakSensor",
  name: "Протечка",
  characteristics: [["LeakDetected", 0]],
});
const airQuality = (quality, pm) => ({
  type: "AirQualitySensor",
  name: "Воздух",
  characteristics: [
    ["AirQuality", quality],
    ["PM2_5Density", pm],
  ],
});
const filter = (life) => ({
  type: "FilterMaintenance",
  name: "Фильтр",
  characteristics: [
    ["FilterChangeIndication", life < 10 ? 1 : 0],
    ["FilterLifeLevel", life],
  ],
});
const meter = (watt, kwh) => ({
  type: "C_WattMeter",
  name: "Счётчик",
  characteristics: [
    ["C_Watt", watt],
    ["C_Volt", 229],
    ["C_KiloWattHour", kwh],
  ],
});
const outlet = (name, on = false) => ({
  type: "Outlet",
  name,
  characteristics: [
    ["On", on],
    ["OutletInUse", on],
  ],
});
const fan = (name) => ({
  type: "Fan",
  name,
  characteristics: [["On", false]],
});

function namedDevices() {
  return [
    // Existing rooms get devices that do not change their cases' answers,
    // except the living room: spots are on and a non-light ventilation
    // relay sits on the same switch as the lights.
    accessory(3, "Выключатель гостиной", [
      relay("Споты", true),
      relay("Подсветка ниши"),
      relay("Вентиляция"),
    ]),
    accessory(3, "Кнопка у дивана", [button(1), button(2), button(3)], {
      battery: 71,
    }),
    accessory(3, "Датчик воздуха в гостиной", [airQuality(2, 9)]),
    accessory(1, "Кнопка у входа", [button(1), button(2)], { battery: 83 }),
    accessory(4, "Счётчик плиты", [meter(0, 412.6)]),
    accessory(9, "Люстра в холле", [light("Люстра", false, 70)]),
    accessory(9, "Выключатель холла", [relay("Споты"), relay("Бра")]),
    accessory(9, "Датчик движения в холле", [motion()], { battery: 58 }),
    accessory(10, "Подсветка лестницы", [colorLight("Подсветка", true)]),
    accessory(10, "Датчик движения на лестнице", [motion()], { battery: 66 }),
    accessory(11, "Потолочный свет в гостевой", [light("Свет")]),
    accessory(11, "Бра в гостевой", [light("Левое"), light("Правое")]),
    accessory(11, "Тёплый пол в гостевой", [thermostat("Тёплый пол", 22.1)]),
    accessory(11, "Жалюзи в гостевой", [slat("Жалюзи")]),
    accessory(11, "Датчик окна в гостевой", [contact("Окно")], {
      battery: 92,
    }),
    accessory(12, "Потолочный свет у Маши", [light("Свет")]),
    accessory(12, "Гирлянда у Маши", [colorLight("Гирлянда")]),
    accessory(12, "Очиститель воздуха", [
      {
        type: "AirPurifier",
        name: "Очиститель",
        characteristics: [
          ["Active", 1],
          ["CurrentAirPurifierState", 2],
          ["TargetAirPurifierState", 1],
          ["C_FanSpeed", 2],
        ],
      },
      filter(64),
    ]),
    accessory(12, "Датчик воздуха у Маши", [
      airQuality(1, 4),
      temperature(22.6),
      humidity(48),
    ]),
    accessory(13, "Потолочный свет у Коли", [light("Свет")]),
    accessory(13, "Подсветка стола у Коли", [light("Подсветка")]),
    accessory(13, "Датчик климата у Коли", [temperature(22.9), humidity(47)], {
      battery: 44,
    }),
    accessory(13, "Жалюзи у Коли", [slat("Жалюзи", 30)]),
    accessory(14, "Свет в гардеробной", [light("Свет")]),
    accessory(14, "Датчик двери гардеробной", [contact("Дверь")], {
      battery: 77,
    }),
    accessory(15, "Свет в санузле", [relay("Свет"), relay("Зеркало")]),
    accessory(15, "Вентилятор в санузле", [fan("Вентилятор")]),
    accessory(15, "Датчик протечки в санузле", [leak()], { battery: 88 }),
    accessory(15, "Тёплый пол в санузле", [thermostat("Тёплый пол", 23.4)]),
    accessory(15, "Полотенцесушитель", [outlet("Розетка"), meter(0, 96.2)]),
    accessory(16, "Свет в постирочной", [light("Свет")]),
    accessory(16, "Розетка стиральной машины", [
      outlet("Розетка"),
      meter(0, 231.9),
    ]),
    accessory(16, "Датчик протечки у стиральной машины", [leak()], {
      battery: 81,
    }),
    accessory(17, "Бойлер", [relay("Нагрев", true), meter(1480, 1873.4)]),
    accessory(17, "Насос отопления", [relay("Насос")]),
    accessory(17, "Датчик температуры в котельной", [temperature(19.8)]),
    accessory(17, "Рекуператор", [fan("Приток"), filter(7)]),
    accessory(18, "Свет в мастерской", [
      relay("Верхний свет"),
      relay("Над верстаком"),
      relay("Над стеллажом"),
    ]),
    accessory(18, "Розетка станка", [outlet("Розетка"), meter(0, 58.3)]),
    accessory(18, "Датчик двери мастерской", [contact("Дверь")], {
      battery: 69,
    }),
    accessory(19, "Уличные фонари", [relay("Фонари", true)]),
    accessory(19, "Гирлянда на террасе", [relay("Гирлянда")]),
    accessory(19, "Датчик уличной температуры", [temperature(14.2)]),
    accessory(19, "Маркиза", [
      {
        type: "WindowCovering",
        name: "Маркиза",
        characteristics: [
          ["CurrentPosition", 0],
          ["PositionState", 2],
          ["TargetPosition", 0],
        ],
      },
    ]),
    accessory(20, "Свет в гараже", [relay("Свет"), relay("Над воротами")]),
    accessory(20, "Датчик ворот гаража", [contact("Ворота")], { battery: 55 }),
    accessory(20, "Датчик движения в гараже", [motion()], { battery: 73 }),
    accessory(21, "Прожектор у ворот", [light("Прожектор")]),
    accessory(21, "Полив газона", [
      relay("Зона 1"),
      relay("Зона 2"),
      relay("Зона 3"),
      relay("Зона 4"),
    ]),
    accessory(21, "Датчик движения у калитки", [motion()], { battery: 61 }),
    accessory(21, "Охрана", [
      {
        type: "SecuritySystem",
        name: "Охрана",
        characteristics: [
          ["SecuritySystemCurrentState", 3],
          ["SecuritySystemTargetState", 3],
        ],
      },
    ]),
    accessory(22, "Свет в сауне", [light("Свет")]),
    accessory(22, "Термостат сауны", [thermostat("Печь", 24.3, 80)]),
    accessory(22, "Датчик температуры в сауне", [temperature(24.3)]),
  ];
}

// Per new room: two-channel spot dimmers, a four-channel light relay, a
// three-key wall button, window blinds or contacts and floor heating in
// living rooms. All of them are off.
function roomFill([roomId, roomName]) {
  const short = roomName.split(" ")[0];
  const devices = [];
  for (let dimmer = 1; dimmer <= 3; dimmer += 1) {
    devices.push(
      accessory(roomId, `Диммер спотов ${dimmer} (${short})`, [
        light(`Группа ${dimmer * 2 - 1}`, false, 60 + dimmer * 5),
        light(`Группа ${dimmer * 2}`, false, 60 + dimmer * 5),
      ]),
    );
  }
  devices.push(
    accessory(roomId, `Реле подсветки (${short})`, [
      relay("Канал 1"),
      relay("Канал 2"),
      relay("Канал 3"),
      relay("Канал 4"),
    ]),
    accessory(roomId, `Настенная кнопка (${short})`, [
      button(1),
      button(2),
      button(3),
    ]),
  );
  if (roomId <= 13 || roomId === 22) {
    devices.push(
      accessory(roomId, `Жалюзи окна (${short})`, [slat("Ламели")]),
      accessory(roomId, `Тёплый пол (${short})`, [
        thermostat("Тёплый пол", 21.5 + (roomId % 3)),
      ]),
    );
  } else {
    devices.push(accessory(roomId, `Окно (${short})`, [contact("Окно")]));
  }
  return devices;
}

function block(targets) {
  return { targets };
}

function motionRule(sensor, lamp, seconds) {
  return block([
    {
      type: "if",
      mode: "EVERY",
      if: {
        type: "condition",
        mode: "AND",
        conditions: [
          {
            type: "characteristic",
            aId: sensor,
            sId: 13,
            cId: 14,
            hs: "MotionSensor",
            hc: "MotionDetected",
            cond: "=",
            value: "true",
            trigger: true,
            time: 0,
            timeCond: "",
          },
        ],
      },
      // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
      then: [
        {
          type: "service",
          aId: lamp,
          sId: 13,
          hs: "Lightbulb",
          characteristics: [{ type: "set", cId: 14, hc: "On", value: "true" }],
        },
        {
          type: "delay",
          index: 1,
          mode: "RESET",
          time: seconds * 1_000,
          targets: [
            {
              type: "service",
              aId: lamp,
              sId: 13,
              hs: "Lightbulb",
              characteristics: [
                { type: "set", cId: 14, hc: "On", value: "false" },
              ],
            },
          ],
        },
      ],
      else: [],
      then_delay: 0,
      else_delay: 0,
    },
  ]);
}

function dailyWindow(start, end, targetId, sId, hs) {
  return block([
    {
      type: "if",
      mode: "EVERY",
      if: {
        type: "condition",
        mode: "AND",
        conditions: [
          {
            type: "interval",
            start: { type: "cron", cron: start, mode: "NONE", offset: 0 },
            end: { type: "cron", cron: end, mode: "NONE", offset: 0 },
            trigger: true,
          },
        ],
      },
      // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
      then: [
        {
          type: "service",
          aId: targetId,
          sId,
          hs,
          characteristics: [
            { type: "set", cId: sId + 1, hc: "On", value: "true" },
          ],
        },
      ],
      else: [
        {
          type: "service",
          aId: targetId,
          sId,
          hs,
          characteristics: [
            { type: "set", cId: sId + 1, hc: "On", value: "false" },
          ],
        },
      ],
      then_delay: 0,
      else_delay: 0,
    },
  ]);
}

function actions(name, desc, targets) {
  return {
    name,
    desc,
    type: "BLOCK",
    data: block(
      targets.map(([aId, sId, hs, value]) => ({
        type: "service",
        aId,
        sId,
        hs,
        characteristics: [
          { type: "set", cId: sId + 1, hc: "On", value: String(value) },
        ],
      })),
    ),
  };
}

function logicSource(name, description, sourceService, body) {
  return [
    "info = {",
    `  name: "${name}",`,
    `  description: "${description}",`,
    '  version: "1.0",',
    '  author: "sprut",',
    "  onStart: false,",
    `  sourceServices: [HS.${sourceService}],`,
    "  sourceCharacteristics: [],",
    "  options: {},",
    "  variables: {}",
    "};",
    "",
    "function trigger(source, value, variables, options, context) {",
    ...body.map((line) => `  ${line}`),
    "}",
  ];
}

function scenarios(byName) {
  const id = (name) => byName.get(name);
  const list = [
    {
      name: "Свет на лестнице по движению",
      desc: "Подсветка лестницы на две минуты",
      type: "BLOCK",
      data: motionRule(
        id("Датчик движения на лестнице"),
        id("Подсветка лестницы"),
        120,
      ),
    },
    {
      name: "Свет в холле по движению",
      desc: "",
      type: "BLOCK",
      data: motionRule(id("Датчик движения в холле"), id("Люстра в холле"), 90),
    },
    {
      name: "Прожектор у калитки",
      desc: "Включает прожектор при движении у калитки",
      type: "BLOCK",
      data: motionRule(
        id("Датчик движения у калитки"),
        id("Прожектор у ворот"),
        180,
      ),
    },
    {
      name: "Уличные фонари вечером",
      desc: "",
      type: "BLOCK",
      data: dailyWindow(
        "0 0 19 ? * * *",
        "0 30 1 ? * * *",
        id("Уличные фонари"),
        13,
        "Switch",
      ),
    },
    {
      name: "Гирлянда на террасе",
      desc: "Праздничная подсветка",
      type: "BLOCK",
      active: false,
      data: dailyWindow(
        "0 0 18 ? * * *",
        "0 0 23 ? * * *",
        id("Гирлянда на террасе"),
        13,
        "Switch",
      ),
    },
    ...[1, 2, 3, 4].map((zone) => ({
      name: `Полив зоны ${zone}`,
      desc: "Утренний полив",
      type: "BLOCK",
      data: dailyWindow(
        `0 ${zone * 10} 5 ? * * *`,
        `0 ${zone * 10 + 9} 5 ? * * *`,
        id("Полив газона"),
        13 + (zone - 1) * 10,
        "Switch",
      ),
    })),
    {
      name: "Бойлер ночным тарифом",
      desc: "",
      type: "BLOCK",
      data: dailyWindow(
        "0 0 23 ? * * *",
        "0 0 7 ? * * *",
        id("Бойлер"),
        13,
        "Switch",
      ),
    },
    actions("Выключить второй этаж", "Гасит свет наверху", [
      [id("Люстра в холле"), 13, "Lightbulb", false],
      [id("Подсветка лестницы"), 13, "Lightbulb", false],
      [id("Потолочный свет в гостевой"), 13, "Lightbulb", false],
      [id("Потолочный свет у Маши"), 13, "Lightbulb", false],
      [id("Потолочный свет у Коли"), 13, "Lightbulb", false],
    ]),
    actions("Кино в гостиной", "Гасит споты и нишу", [
      [id("Выключатель гостиной"), 13, "Switch", false],
      [id("Выключатель гостиной"), 23, "Switch", false],
    ]),
    actions("Уборка в гараже", "", [
      [id("Свет в гараже"), 13, "Switch", true],
      [id("Свет в гараже"), 23, "Switch", true],
    ]),
    actions("Мастерская: всё включить", "", [
      [id("Свет в мастерской"), 13, "Switch", true],
      [id("Свет в мастерской"), 23, "Switch", true],
      [id("Свет в мастерской"), 33, "Switch", true],
    ]),
    actions("Сауна: подготовка", "Включает свет в сауне", [
      [id("Свет в сауне"), 13, "Lightbulb", true],
    ]),
    actions("Выключить улицу", "", [
      [id("Уличные фонари"), 13, "Switch", false],
      [id("Прожектор у ворот"), 13, "Lightbulb", false],
    ]),
    actions("Гостевая: приветствие", "", [
      [id("Бра в гостевой"), 13, "Lightbulb", true],
      [id("Бра в гостевой"), 23, "Lightbulb", true],
    ]),
    actions("Маша спит", "", [
      [id("Потолочный свет у Маши"), 13, "Lightbulb", false],
      [id("Гирлянда у Маши"), 13, "Lightbulb", false],
    ]),
    actions("Коля спит", "", [
      [id("Потолочный свет у Коли"), 13, "Lightbulb", false],
      [id("Подсветка стола у Коли"), 13, "Lightbulb", false],
    ]),
    actions("Постирочная: свет", "", [
      [id("Свет в постирочной"), 13, "Lightbulb", true],
    ]),
    actions("Гардеробная: свет", "", [
      [id("Свет в гардеробной"), 13, "Lightbulb", true],
    ]),
    ...[
      ["Термостат: гистерезис", "Thermostat"],
      ["Вентиляция по влажности", "HumiditySensor"],
      ["Сигнализация протечки", "LeakSensor"],
      ["Кнопки: сцены", "StatelessProgrammableSwitch"],
      ["Охрана: постановка", "SecuritySystem"],
      ["Фильтр: напоминание", "FilterMaintenance"],
      ["Воздух: очиститель", "AirQualitySensor"],
      ["Жалюзи: солнце", "Slat"],
      ["Счётчик: пиковая мощность", "C_WattMeter"],
      ["Свет: плавное включение", "Lightbulb"],
      ["Реле: защита от залипания", "Switch"],
      ["Двери: напоминание", "ContactSensor"],
    ].map(([name, source]) => ({
      name,
      desc: "",
      type: "LOGIC",
      predefined: true,
      data: logicSource(name, "Встроенная логика хаба", source, [
        `log("${name}: " + value);`,
      ]),
    })),
    {
      name: "Учёт энергии",
      desc: "",
      type: "LOGIC",
      data: logicSource(
        "Учёт энергии",
        "Пишет в журнал мощность бойлера",
        "C_WattMeter",
        ['if (value > 3000) log("Бойлер: высокая мощность " + value);'],
      ),
    },
    {
      name: "Глобальные переменные",
      desc: "",
      type: "GLOBAL",
      data: ["global.awayMode = false;", "global.nightTariffStart = 23;"].join(
        "\n",
      ),
    },
    {
      name: "Глобальные функции",
      desc: "",
      type: "GLOBAL",
      data: [
        "global.allOff = function (ids) {",
        "  ids.forEach(function (id) {",
        "    Hub.getAccessory(id).getService(HS.Lightbulb).getCharacteristic(HC.On).setValue(false);",
        "  });",
        "};",
      ].join("\n"),
    },
  ];
  return list.map((scenario, index) => ({
    index: String(12 + index),
    active: scenario.active !== false,
    ...scenario,
  }));
}

export default async function house({ loadHomeFixture }) {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  nextId = 101;
  const added = [...namedDevices(), ...ROOMS.flatMap(roomFill)];
  const byName = new Map(added.map(({ id, name }) => [name, id]));
  return {
    ...fixture,
    description:
      "Synthetic two-storey house: the apartment plus 14 rooms, 144 accessories and 36 scenarios, about double the owner's home. Built by test/fixtures/homes/house.mjs; names, ids and values are invented.",
    hub: { ...fixture.hub, serial: "sim-house-01", name: "Дом в Сосновке" },
    rooms: [...fixture.rooms, ...ROOMS.map(([id, name]) => ({ id, name }))],
    accessories: [...fixture.accessories, ...added],
    scenarios: [...fixture.scenarios, ...scenarios(byName)],
  };
}
