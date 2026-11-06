// Preloaded with node --import into a server under test: a file system
// without hard links, as a network share or an exFAT disk may be.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

fs.promises.link = async () => {
  throw Object.assign(new Error("ENOTSUP: operation not supported, link"), {
    code: "ENOTSUP",
    syscall: "link",
  });
};
syncBuiltinESMExports();
