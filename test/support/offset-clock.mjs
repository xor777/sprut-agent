// Preloaded with node --import into a server under test, never imported by
// a test: moves this process's Date.now by SPRUT_TEST_CLOCK_OFFSET_MS, so
// a test sets the time of day the server reads without waiting for it.
const offset = Number(process.env.SPRUT_TEST_CLOCK_OFFSET_MS ?? 0);
const realNow = Date.now;
Date.now = () => realNow() + offset;
