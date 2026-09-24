// A synthetic home of a chosen size for the scale test of household reads.
// It is the apartment (its named devices, the ones that are on and the ones
// offline) spread over 13 rooms like the owner's home (2026-09-24: 13 rooms,
// 80 accessories, 254 services), filled up to the requested accessory count
// with devices that are off and online, about three services per accessory
// as in the owner's home. The fill stays out of the living room and both
// bedrooms and away from their names, so a question about them has the same
// answer at every size. The default export is the owner's size.

const EXTRA_ROOMS = [
  [40, "Холл"],
  [41, "Постирочная"],
  [42, "Мастерская"],
  [43, "Гараж"],
];
const FILL_ROOMS = [1, 2, 4, 7, 8, 30, 40, 41, 42, 43];
const FILL_FIRST_ID = 1001;

const characteristics = (sId, entries) =>
  entries.map(([type, value], at) => ({ cId: sId + 1 + at, type, value }));

const service = (index, type, name, entries) => {
  const sId = 13 + index * 10;
  return { sId, type, name, characteristics: characteristics(sId, entries) };
};

// Device shapes of the fill, in turn: a two-channel relay, a lamp, a
// three-key button, a climate sensor, a door sensor and a two-group dimmer.
const TEMPLATES = [
  (n) => ({
    name: `Реле ${n}`,
    services: [
      service(0, "Switch", "Канал 1", [["On", false]]),
      service(1, "Switch", "Канал 2", [["On", false]]),
    ],
  }),
  (n) => ({
    name: `Лампа ${n}`,
    services: [
      service(0, "Lightbulb", "Свет", [
        ["On", false],
        ["Brightness", 50],
      ]),
    ],
  }),
  (n) => ({
    name: `Кнопка ${n}`,
    battery: 90,
    services: [1, 2, 3].map((key, index) =>
      service(index, "StatelessProgrammableSwitch", `Кнопка ${key}`, [
        ["ProgrammableSwitchEvent", 0],
        ["ServiceLabelIndex", key],
      ]),
    ),
  }),
  (n) => ({
    name: `Датчик климата ${n}`,
    battery: 80,
    services: [
      service(0, "TemperatureSensor", "Температура", [
        ["CurrentTemperature", 22],
      ]),
      service(1, "HumiditySensor", "Влажность", [
        ["CurrentRelativeHumidity", 45],
      ]),
    ],
  }),
  (n) => ({
    name: `Датчик двери ${n}`,
    battery: 75,
    services: [
      service(0, "ContactSensor", "Дверь", [["ContactSensorState", 0]]),
    ],
  }),
  (n) => ({
    name: `Диммер ${n}`,
    services: [1, 2].map((group, index) =>
      service(index, "Lightbulb", `Группа ${group}`, [
        ["On", false],
        ["Brightness", 40],
      ]),
    ),
  }),
];

export function scaledHome(apartment, accessoryCount) {
  const fixture = structuredClone(apartment);
  const fillCount = accessoryCount - fixture.accessories.length;
  if (fillCount < 0) {
    throw new Error(
      `A scaled home has at least ${fixture.accessories.length} accessories`,
    );
  }
  const fill = Array.from({ length: fillCount }, (_, index) => {
    const id = FILL_FIRST_ID + index;
    const device = TEMPLATES[index % TEMPLATES.length](index + 1);
    return {
      id,
      roomId: FILL_ROOMS[index % FILL_ROOMS.length],
      extensionKey: "Controller:zigbee",
      deviceId: `00158d0009${id.toString(16).padStart(6, "0")}`,
      manufacturer: "Sprut",
      model: "SIM-2",
      ...device,
    };
  });
  return {
    ...fixture,
    description: `Synthetic scaled home: the apartment in 13 rooms with ${accessoryCount} accessories. Built by test/fixtures/homes/scaled.mjs.`,
    hub: { ...fixture.hub, serial: "sim-scaled-01" },
    rooms: [
      ...fixture.rooms,
      ...EXTRA_ROOMS.map(([id, name]) => ({ id, name })),
    ],
    accessories: [...fixture.accessories, ...fill],
  };
}

// The owner's lights on 2026-09-24 (live-conformance-3 and a later
// read-only find_devices {kind: light, state: on}): at 80 accessories 11
// lamps on, most of them color lamps, 7 lamps unavailable and 3 relays or
// sockets on. litHome keeps these shares at every size: every lamp and
// dimmer group of the fill gets color characteristics, and as many of them
// are on or unavailable, and as many relay channels are on, as the owner's
// shares at this size ask beyond the apartment's own.
const OWNER_LIGHTS = { accessories: 80, on: 11, unavailable: 7, relaysOn: 3 };
const COLOR = [
  ["Hue", 30],
  ["Saturation", 60],
  ["ColorTemperature", 370],
  ["C_ColorMode", 1],
];

export function litHome(apartment, accessoryCount) {
  const home = scaledHome(apartment, accessoryCount);
  const share = (count) =>
    Math.round((count * accessoryCount) / OWNER_LIGHTS.accessories);
  const fill = home.accessories.filter(({ id }) => id >= FILL_FIRST_ID);
  const isOn = (service) =>
    service.characteristics.some(
      ({ type, value }) => type === "On" && value === true,
    );
  const apartmentOn = (types) =>
    apartment.accessories
      .flatMap(({ services }) => services)
      .filter((service) => types.includes(service.type) && isOn(service))
      .length;
  const lampServices = fill.flatMap((accessory) =>
    accessory.services
      .filter(({ type }) => type === "Lightbulb")
      .map((service) => ({ accessory, service })),
  );
  for (const { service } of lampServices) {
    const last = service.characteristics.at(-1).cId;
    service.characteristics.push(
      ...COLOR.map(([type, value], at) => ({
        cId: last + 1 + at,
        type,
        value,
      })),
    );
  }
  const setOn = ({ service }) => {
    service.characteristics.find(({ type }) => type === "On").value = true;
  };
  const unavailable = fill
    .filter(
      ({ services }) =>
        services.length === 1 && services[0].type === "Lightbulb",
    )
    .slice(0, share(OWNER_LIGHTS.unavailable));
  for (const accessory of unavailable) accessory.online = false;
  lampServices
    .filter(({ accessory }) => !unavailable.includes(accessory))
    .slice(0, share(OWNER_LIGHTS.on) - apartmentOn(["Lightbulb"]))
    .forEach(setOn);
  fill
    .flatMap((accessory) =>
      accessory.services
        .filter(({ type }) => type === "Switch")
        .map((service) => ({ accessory, service })),
    )
    .slice(0, share(OWNER_LIGHTS.relaysOn) - apartmentOn(["Switch", "Outlet"]))
    .forEach(setOn);
  return {
    ...home,
    description: `${home.description} Lights as in the owner's home: ${share(OWNER_LIGHTS.on)} lamps on, ${share(OWNER_LIGHTS.unavailable)} unavailable, ${share(OWNER_LIGHTS.relaysOn)} relays on.`,
  };
}

export default async function scaled({ loadHomeFixture }) {
  return scaledHome(await loadHomeFixture("apartment"), 80);
}
