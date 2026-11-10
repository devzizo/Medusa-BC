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

  // Every 15 minutes: what BC did with the posted orders (released, shipped,
  // invoiced, paid) is written on the Medusa orders, a few per run.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(env.STORE.get(env.STORE.idFromName("main")).refreshDueOrders());
  },
};
