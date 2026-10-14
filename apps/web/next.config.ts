import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  outputFileTracingRoot: resolve(appDirectory, "../.."),
};

export default nextConfig;
