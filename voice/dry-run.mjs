// Shows what a voice command would write on the live home, sending nothing:
//   node voice/dry-run.mjs '{"commands":[{"room":"r2","set":{"white_kelvin":2700}}]}'
// It reads the home through the same MCP connection as the server.
import { HomeTools } from "./home-tools.mjs";

const tools = new HomeTools({ stderr: "pipe" });
try {
  const args = JSON.parse(process.argv[2] ?? "{}");
  const plan = await tools.control(args, { dryRun: true });
  console.log(JSON.stringify(plan, null, 2));
} finally {
  await tools.close();
}
