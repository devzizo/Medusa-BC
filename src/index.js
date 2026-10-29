import { middlewareApi } from "./api.js";

export { MiddlewareStore } from "./store.js";

// The middleware between Medusa and Business Central: its admin page is the
// static assets in public/, its API lives under /api/middleware/.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/middleware/")) {
      try {
        return await middlewareApi(request, env, url.pathname);
      } catch (error) {
        return Response.json({ error: error?.message || String(error) }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
