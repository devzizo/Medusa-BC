import { bcCredentials, bcGetBinary, getBcItemPicture } from "../lib/bc.js";
import { makeBudget, medusaClient } from "../lib/medusa.js";
import { productHandle } from "../lib/map.js";

// The picture sync, BC → Medusa: each product the item sync created gets
// its BC item's picture, uploaded through Medusa's file provider, as its
// first image (and thumbnail unless the admin chose another). Images added
// in Medusa are kept. The picture's etag is kept in metadata, so an
// unchanged picture costs one call and no upload. A picture removed in BC
// is removed from the product. Runs in steps under a call budget.

// A product with no picture at all (none from BC, none added in Medusa, no thumbnail) is not shown: the owner's call, 2026-11-17
// («ما ينزل أي منتج بالموقع ما له صورة»). The picture sync is where that is known, so it drafts such a product and marks it
// (metadata.bc_hidden_no_picture); the item sync leaves a marked product a draft, and the picture sync lifts the mark when a
// picture arrives - the next item sync then publishes it (it alone knows whether the item is blocked). It is the option «hide_without_picture»
// of the picture sync (the owner asked for it as an option): off by default, since turning it on takes every product with no
// picture off the site; turned off again, marks are lifted and the item sync publishes as before.
export const pictureVisibility = ({ hide, hasImage, status, flagged }) => {
  if (hide && !hasImage) return status === "published" ? { status: "draft", flag: true } : {};
  return flagged ? { flag: false } : {};
};

const BUDGET = 40;
const PAGE = 100;
const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/bmp": "bmp", "image/webp": "webp", "image/tiff": "tif" };

export async function runImageSyncStep(ctx, env) {
  const budget = makeBudget(Number(env.SYNC_STEP_BUDGET) || BUDGET);
  const medusa = medusaClient(env, budget);
  const bc = bcCredentials(env);
  const { state } = ctx;
  const hide = ctx.settings.hide_without_picture === "1";
  const stages = { read: index, pictures };
  while (state.stage !== "done" && budget.left() > 5) {
    const before = `${state.stage}:${state.cursor}`;
    await stages[state.stage]({ ctx, budget, medusa, bc, hide });
    // A stage that stopped without moving is waiting for a fresh budget.
    if (`${state.stage}:${state.cursor}` === before) break;
  }
  return state.stage === "done";
}

const next = (state, stage) => {
  state.stage = stage;
  state.cursor = 0;
};

// ---- read: the products the item sync owns, page by page (by id) ----

async function index({ ctx, medusa, budget }) {
  const { state, summary, settings } = ctx;
  if (!settings.company_id) throw new Error("Choose a Business Central company in Settings first.");
  if (!state.cursor) Object.assign(summary, { products: 0, uploaded: 0, unchanged: 0, no_picture: 0, removed: 0, failed: 0, issues: 0, hidden: 0, shown: 0 });
  state.queued ??= 0;
  while (budget.left() > 5) {
    const { products } = await medusa.get("/admin/products", { fields: "id,handle,title,status,thumbnail,metadata,images.url", order: "id", limit: PAGE, offset: state.cursor });
    const owned = products.filter((p) => p.metadata?.bc_item_id && p.handle === productHandle(p.metadata.bc_item_number ?? ""));
    ctx.putWork("product", owned.map((p) => ({ key: p.id, payload: p })), state.queued);
    state.queued += owned.length;
    summary.products += owned.length;
    state.cursor += products.length;
    if (products.length < PAGE) return next(state, "pictures");
  }
}

// ---- pictures: one product at a time, four calls at most ----

async function pictures({ ctx, medusa, bc, budget, hide }) {
  const { state, summary, settings } = ctx;
  while (budget.left() > 5) {
    const [row] = ctx.work("product", state.cursor, 1);
    if (!row) return next(state, "done");
    const product = row.payload;
    const metadata = product.metadata ?? {};
    const others = (product.images ?? []).map((image) => image.url).filter((url) => url && url !== metadata.bc_picture_url);
    try {
      // What the product holds after this step, for the visibility rule below
      let meta = metadata;
      let hasImage = true;
      const picture = await getBcItemPicture(bc, settings.company_id, metadata.bc_item_id, { budget });
      const has = Number(picture.width) > 0 && picture.contentType;
      const tag = picture["@odata.etag"] || `${picture.id}:${picture.width}x${picture.height}:${picture.contentType}`;
      if (!has) {
        if (metadata.bc_picture_url) {
          await medusa.post(`/admin/products/${product.id}`, {
            images: others.map((url) => ({ url })),
            thumbnail: product.thumbnail === metadata.bc_picture_url ? others[0] ?? null : product.thumbnail,
            metadata: { ...metadata, bc_picture_url: "", bc_picture_etag: "" },
          });
          meta = { ...metadata, bc_picture_url: "", bc_picture_etag: "" };
          summary.removed++;
        } else summary.no_picture++;
        // Nothing from BC: a picture added in Medusa (another image, or a thumbnail that is not BC's) still counts
        hasImage = others.length > 0 || Boolean(product.thumbnail && product.thumbnail !== metadata.bc_picture_url);
      } else if (tag === metadata.bc_picture_etag && metadata.bc_picture_url) {
        summary.unchanged++;
      } else {
        const link = picture["pictureContent@odata.mediaReadLink"] || `/companies(${settings.company_id})/items(${metadata.bc_item_id})/picture/pictureContent`;
        const { bytes, contentType } = await bcGetBinary(bc, link, { budget });
        const type = picture.contentType || contentType;
        const file = await medusa.upload(`${product.handle}.${EXTENSIONS[type] ?? "img"}`, bytes, type);
        await medusa.post(`/admin/products/${product.id}`, {
          images: [file.url, ...others].map((url) => ({ url })),
          thumbnail: !product.thumbnail || product.thumbnail === metadata.bc_picture_url ? file.url : product.thumbnail,
          metadata: { ...metadata, bc_picture_url: file.url, bc_picture_etag: tag },
        });
        meta = { ...metadata, bc_picture_url: file.url, bc_picture_etag: tag };
        summary.uploaded++;
      }
      const visibility = pictureVisibility({ hide, hasImage, status: product.status, flagged: Boolean(meta.bc_hidden_no_picture) });
      if (visibility.flag !== undefined) {
        await medusa.post(`/admin/products/${product.id}`, {
          ...(visibility.status ? { status: visibility.status } : {}),
          metadata: { ...meta, bc_hidden_no_picture: visibility.flag ? true : "" },
        });
        if (visibility.flag) {
          summary.hidden++;
          ctx.note({ kind: "picture", ref: metadata.bc_item_number, message: `${product.title}: no picture in Business Central or Medusa; changed to draft until it has one.` });
        } else summary.shown++;
      }
    } catch (error) {
      summary.failed++;
      ctx.note({ kind: "picture", ref: metadata.bc_item_number, message: `${product.title}: ${error?.message || error}` });
    }
    state.cursor = row.seq + 1;
  }
}
