// Settings shared by the in-process fake hubs of the test suite.

// Fake hubs listen on the loopback address that the MCP process dials
// (ws://127.0.0.1:<port>). A listener on every interface (`{ port: 0 }`) can
// be given a port that another program already serves on 127.0.0.1, because
// macOS hands out ports in sequence and does not treat that IPv4 listener as a
// conflict. Docker Desktop keeps such listeners. The MCP process then reaches
// the other program and reports `connection_failed` after a socket hang-up.
export const FAKE_HUB_HOST = "127.0.0.1";

// `npm test` runs files in parallel and every test starts its own MCP process
// against a fake hub. The fake hub answers within milliseconds, but on a
// loaded machine one tool call can wait seconds for CPU, so a tight
// SPRUTHUB_TIMEOUT_MS turns scheduling delay into a false `timeout`. Ordinary
// tests, and test waits for the MCP process to reach the hub, get the same
// 10 s budget the product uses by default. A test that stalls the hub on
// purpose passes its own short budget at the call site so the expected timeout
// arrives quickly.
export const ORDINARY_HUB_TIMEOUT_MS = 10_000;
