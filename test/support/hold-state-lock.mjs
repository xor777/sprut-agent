// A real other process that takes a state lock and keeps it until it is
// killed or stopped. argv: the lock file.
import { acquireStateLock } from "../../src/state-lock.mjs";

await acquireStateLock(process.argv[2]);
process.stdout.write("held\n");
setInterval(() => {}, 60_000);
