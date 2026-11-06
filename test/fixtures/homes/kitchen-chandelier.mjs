// The apartment with a lamp group of the owner's kind
// (2026-10-14-light-group-relink): «Люстра» in the kitchen is a virtual
// lamp whose On, Brightness, Hue, Saturation and ColorTemperature each
// have an IN link to the same characteristic of three colour lamps, and
// the group's characteristic ids differ from the lamps', as on the owner's
// hub. «Лампа люстры 3» is offline: it was replaced by «Лампочка», a new
// colour lamp in the kitchen with no links. Another «Лампочка», in the
// bedroom's floor lamp, has no links either. Everything is off. Ids 41-46
// are free in the apartment and the house.

const KITCHEN = 4;
const BEDROOM = 5;
export const GROUP = { aId: 44, sId: 13 };
// The group's characteristic ids, by type.
export const GROUP_CHARACTERISTICS = {
  On: 15,
  Brightness: 16,
  Hue: 17,
  Saturation: 18,
  ColorTemperature: 19,
};
// A colour lamp's characteristic ids, by type.
export const LAMP_CHARACTERISTICS = {
  On: 14,
  Brightness: 15,
  Hue: 16,
  Saturation: 17,
  ColorTemperature: 18,
};
export const MEMBERS = [41, 42, 43];
export const OFFLINE_MEMBER = 43;
export const NEW_LAMP = 45;
export const BEDROOM_LAMP = 46;

function colourLamp(id, roomId, name, serviceName, values, extra = {}) {
  return {
    id,
    roomId,
    name,
    extensionKey: "Controller:zigbee",
    deviceId: `00178801${id.toString(16).padStart(8, "0")}`,
    manufacturer: "Philips",
    model: "LCA001",
    ...extra,
    services: [
      {
        sId: 13,
        type: "Lightbulb",
        name: serviceName,
        characteristics: Object.entries(LAMP_CHARACTERISTICS).map(
          ([type, cId]) => ({ cId, type, value: values[type] }),
        ),
      },
    ],
  };
}

const GROUP_VALUES = {
  On: false,
  Brightness: 80,
  Hue: 30,
  Saturation: 50,
  ColorTemperature: 370,
};
const FACTORY_VALUES = {
  On: false,
  Brightness: 100,
  Hue: 0,
  Saturation: 0,
  ColorTemperature: 300,
};

export function withKitchenChandelier(fixture) {
  fixture.accessories.push(
    colourLamp(41, KITCHEN, "Лампа люстры 1", "Свет", GROUP_VALUES),
    colourLamp(42, KITCHEN, "Лампа люстры 2", "Свет", GROUP_VALUES),
    colourLamp(43, KITCHEN, "Лампа люстры 3", "Свет", GROUP_VALUES, {
      online: false,
    }),
    {
      id: GROUP.aId,
      roomId: KITCHEN,
      name: "Люстра",
      virtual: true,
      services: [
        {
          sId: GROUP.sId,
          type: "Lightbulb",
          name: "Люстра",
          characteristics: [
            { cId: 14, type: "Name", value: "Люстра" },
            ...Object.entries(GROUP_CHARACTERISTICS).map(([type, cId]) => ({
              cId,
              type,
              value: GROUP_VALUES[type],
            })),
          ],
        },
      ],
    },
    colourLamp(NEW_LAMP, KITCHEN, "Лампочка", "Свет", FACTORY_VALUES),
    colourLamp(BEDROOM_LAMP, BEDROOM, "Лампочка", "Торшер", FACTORY_VALUES),
  );
  fixture.links = [
    ...(fixture.links ?? []),
    ...MEMBERS.flatMap((member) =>
      Object.keys(GROUP_CHARACTERISTICS).map((type) => ({
        ...GROUP,
        cId: GROUP_CHARACTERISTICS[type],
        tAId: member,
        tSId: 13,
        tCId: LAMP_CHARACTERISTICS[type],
      })),
    ),
  ];
  return fixture;
}

export default async function build({ loadHomeFixture }) {
  return withKitchenChandelier(await loadHomeFixture("apartment"));
}
