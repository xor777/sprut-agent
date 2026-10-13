// Preloaded with node --import into a server under test, never imported by
// a test: each SIGUSR2 moves this process's Date.now forward by
// SPRUT_TEST_CLOCK_STEP_MS, 5 minutes by default (the expiry of the warm
// home and the hub time zone), and then writes "clock shifted" to stderr,
// so that a test passes an expiry without waiting for it.
const STEP_MS = Number(process.env.SPRUT_TEST_CLOCK_STEP_MS ?? 5 * 60_000);

const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
process.on("SIGUSR2", () => {
  shift += STEP_MS;
  process.stderr.write("clock shifted\n");
});
