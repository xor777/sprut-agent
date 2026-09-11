export function createSprutHubReader() {
  return {
    async read() {
      return { status: "ok", readings: [] };
    },
    async close() {},
  };
}
