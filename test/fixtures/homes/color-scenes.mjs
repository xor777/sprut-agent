// The apartment with colour scenes of the owner's kind
// (research/protocol/2026-10-23-scenario-code.md 1.1, 1.2): the GLOBAL
// «Цветные сцены» keeps the lamps of every scene by accessory id in
// global.COLOR_SCENE_LIGHTS and paints them in global.colorScene(name);
// each scene is a BLOCK that calls it in one code action when the bedside
// button is held. The list is stale, as the owner's is: 63 is no
// accessory of the home. Indexes 80-82 are free in the apartment and the
// house.

export const COLOR_SCENES = "80";
export const OCEAN = "81";
export const SUNSET = "82";
export const SCENE_LAMPS_LINE = "global.COLOR_SCENE_LIGHTS = [15, 16, 17, 63];";

export const COLOR_SCENES_SOURCE = [
  "// Цветные сцены: лампы и палитры",
  SCENE_LAMPS_LINE,
  "",
  "var PALETTES = {",
  "  ocean: [{ hue: 200, saturation: 90, brightness: 60 }, { hue: 180, saturation: 70, brightness: 40 }],",
  "  sunset: [{ hue: 20, saturation: 100, brightness: 70 }, { hue: 340, saturation: 80, brightness: 50 }],",
  "};",
  "",
  "global.colorScene = function (name) {",
  "  var palette = PALETTES[name];",
  "  if (!palette) {",
  '    log.warn("Нет сцены " + name);',
  "    return;",
  "  }",
  "  global.COLOR_SCENE_LIGHTS.forEach(function (id, i) {",
  "    var accessory = Hub.getAccessory(id);",
  "    if (!accessory) return;",
  "    var light = accessory.getService(HS.Lightbulb);",
  "    var color = palette[i % palette.length];",
  "    light.getCharacteristic(HC.On).setValue(true);",
  "    light.getCharacteristic(HC.Brightness).setValue(color.brightness);",
  "    var hue = light.getCharacteristic(HC.Hue);",
  "    if (hue) hue.setValue(color.hue);",
  "  });",
  "};",
  "",
].join("\n");

// Held bedside button (value 2), as the owner's scene buttons trigger.
function sceneBlock(index, name, scene) {
  return {
    index,
    name,
    desc: "",
    type: "BLOCK",
    active: true,
    data: {
      targets: [
        {
          type: "if",
          mode: "EVERY",
          if: {
            type: "condition",
            mode: "AND",
            conditions: [
              {
                type: "characteristic",
                aId: 39,
                sId: 13,
                cId: 14,
                hs: "StatelessProgrammableSwitch",
                hc: "ProgrammableSwitchEvent",
                cond: "=",
                value: "2",
                trigger: true,
                time: 0,
                timeCond: "",
              },
            ],
          },
          // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
          then: [{ type: "code", code: `global.colorScene("${scene}");` }],
          else: [],
          then_delay: 0,
          else_delay: 0,
        },
      ],
    },
  };
}

export function withColorScenes(fixture) {
  fixture.scenarios.push(
    {
      index: COLOR_SCENES,
      name: "Цветные сцены",
      desc: "Лампы и палитры для сцен",
      type: "GLOBAL",
      active: true,
      onStart: true,
      sync: false,
      data: COLOR_SCENES_SOURCE,
    },
    sceneBlock(OCEAN, "Сцена Океан", "ocean"),
    sceneBlock(SUNSET, "Сцена Закат", "sunset"),
  );
  return fixture;
}
