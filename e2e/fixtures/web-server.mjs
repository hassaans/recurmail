import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";

// Capture the actual application output so browser tests can check for leaks.
const directory = new URL("../../test-results/", import.meta.url);
mkdirSync(directory, { recursive: true });
const log = createWriteStream(new URL("web-server.log", directory), {
  flags: "w",
});
const child = spawn(
  "pnpm",
  [
    "--filter",
    "@recurmail/web",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3100",
  ],
  {
    cwd: new URL("../../", import.meta.url),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("exit", (code) => {
  log.end();
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
