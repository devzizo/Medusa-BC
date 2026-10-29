import { middlewareApi } from "./config.js";

// The middleware between Medusa and Business Central: its admin page is the
// static assets in public/, its API lives under /api/middleware/.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/middleware/")) {
      return middlewareApi(request, env, url.pathname);
    }
    return env.ASSETS.fetch(request);
  },
};
