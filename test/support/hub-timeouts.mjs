// Budgets for MCP processes under test.
//
// `npm test` runs files in parallel and every test starts its own MCP process
// against an in-process fake hub. The fake hub answers within milliseconds,
// but on a loaded machine one tool call can wait seconds for CPU, so a tight
// SPRUTHUB_TIMEOUT_MS turns scheduling delay into a false `timeout`. Ordinary
// tests, and test waits for the MCP process to reach the hub, get the same
// 10 s budget the product uses by default. A test that stalls the hub on
// purpose passes its own short budget at the call site so the expected timeout
// arrives quickly.
export const ORDINARY_HUB_TIMEOUT_MS = 10_000;
