// A real second process on one change journal, as another open dialog's MCP
// server is. argv: JSON of { directory, hubUrl, hubSerial, tag, count }.
import { AutomationStore } from "../../src/automation-store.mjs";

const { directory, hubUrl, hubSerial, tag, count } = JSON.parse(
  process.argv[2],
);
const store = new AutomationStore({ directory, hubUrl, hubSerial });
for (let index = 0; index < count; index += 1) {
  await store.save({ id: `${tag}-${index}`, tag, index, status: "prepared" });
}
