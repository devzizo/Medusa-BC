const PAGE_SIZE = 24;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/products") {
      return listProducts(url, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function listProducts(url, env) {
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);

  const upstream = new URL("/store/products", env.MEDUSA_BACKEND_URL);
  upstream.searchParams.set("limit", String(PAGE_SIZE));
  upstream.searchParams.set("offset", String(offset));
  upstream.searchParams.set("region_id", env.MEDUSA_REGION_ID);
  upstream.searchParams.set("fields", "id,title,handle,thumbnail,*variants.calculated_price");
  if (q) upstream.searchParams.set("q", q);

  const res = await fetch(upstream, {
    headers: { "x-publishable-api-key": env.MEDUSA_PUBLISHABLE_KEY },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) {
    return Response.json({ error: `Medusa responded ${res.status}` }, { status: 502 });
  }

  const data = await res.json();
  const products = data.products.map((p) => {
    const amounts = (p.variants ?? [])
      .map((v) => v.calculated_price?.calculated_amount)
      .filter((a) => typeof a === "number");
    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      thumbnail: p.thumbnail,
      price: amounts.length ? Math.min(...amounts) : null,
      currency: p.variants?.[0]?.calculated_price?.currency_code ?? null,
    };
  });

  return Response.json(
    { products, count: data.count, offset, limit: PAGE_SIZE },
    { headers: { "cache-control": "public, max-age=60" } },
  );
}
