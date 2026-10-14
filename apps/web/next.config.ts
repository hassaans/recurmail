import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  outputFileTracingRoot: resolve(appDirectory, "../.."),
  // Callback query strings contain OAuth codes; handler errors use safe events.
  logging: {
    incomingRequests: {
      ignore: [/^\/auth\/callback(?:\?|$)/, /^\/api\/gmail\/callback(?:\?|$)/],
    },
  },
};

export default nextConfig;
