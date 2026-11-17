import { describe, it, before, after } from "node:test";
import http from "node:http";
import { expect } from "./expect.js";
import { decodePicture, itemSearchFilter, listedItem, MAX_PICTURE_BYTES } from "../src/lib/pictures.js";
import { middlewareApi } from "../src/api.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(7)]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(3)]);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

describe("decodePicture", () => {
  it("takes a JPEG and a PNG whose bytes match their type", () => {
    expect(decodePicture(`data:image/jpeg;base64,${b64(JPEG)}`).contentType).toEqual("image/jpeg");
    expect(decodePicture(`data:image/png;base64,${b64(PNG)}`).bytes.length).toEqual(PNG.length);
  });

  it("refuses other types, a type the bytes do not match, empty and oversized files, and no string", () => {
    expect(decodePicture(`data:image/gif;base64,${b64(JPEG)}`).error).toEqual("الصورة يجب أن تكون JPG أو PNG.");
    expect(decodePicture(`data:image/png;base64,${b64(JPEG)}`).error).toEqual("محتوى الملف لا يطابق نوع الصورة.");
    expect(decodePicture(`data:image/jpeg;base64,${b64(new Uint8Array([0xff, 0xd8, 0xff]))}`).error).toEqual("الصورة فارغة أو تالفة.");
    const big = new Uint8Array(MAX_PICTURE_BYTES + 10);
    big.set([0xff, 0xd8, 0xff]);
    expect(decodePicture(`data:image/jpeg;base64,${b64(big)}`).error).toEqual("الصورة أكبر من 3 ميغابايت.");
    expect(decodePicture(undefined).error).toEqual("لم تصل صورة.");
    expect(decodePicture("data:image/jpeg;base64,***").error).toEqual("الصورة يجب أن تكون JPG أو PNG.");
  });
});

describe("itemSearchFilter", () => {
  it("searches the number and the name", () => {
    expect(itemSearchFilter(" 08213 ")).toEqual("contains(number,'08213') or contains(displayName,'08213')");
  });
  it("doubles a quote, so what is typed stays text inside the filter", () => {
    expect(itemSearchFilter("x') or (1 eq 1")).toEqual("contains(number,'x'') or (1 eq 1') or contains(displayName,'x'') or (1 eq 1')");
  });
  it("needs 2 to 40 characters", () => {
    expect([itemSearchFilter("a"), itemSearchFilter("x".repeat(41)), itemSearchFilter(null)]).toEqual([null, null, null]);
  });
  it("lists an item by id, number, name and blocked", () => {
    expect(listedItem({ id: "i", number: "1", displayName: "n", blocked: true, other: 1 })).toEqual({ id: "i", number: "1", name: "n", blocked: true });
  });
});

// ---- The tab's routes end to end: one local server shaped like Entra, Business Central and Medusa ----
describe("the «رفع الصور» routes", () => {
  const ITEM = "11111111-2222-3333-4444-555555555555";
  const COMPANY = "cccccccc-0000-0000-0000-000000000000";
  const seen = [];
  let pictureBytes = null;
  let server, base, uploadedLog;
  const productPosts = [];

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url, "http://x");
        seen.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
        const send = (status, data, type = "application/json") => {
          res.writeHead(status, { "content-type": type });
          res.end(type === "application/json" ? JSON.stringify(data) : data);
        };
        if (url.pathname.endsWith("/oauth2/v2.0/token")) return send(200, { access_token: "t", expires_in: 3600 });
        const company = `/api/v2.0/companies(${COMPANY})`;
        if (req.method === "GET" && url.pathname === `${company}/items`) return send(200, { value: [{ id: ITEM, number: "08213", displayName: "مرتبة هوفن كلاسيك", blocked: false }] });
        if (req.method === "GET" && url.pathname === `${company}/items(${ITEM})`) return send(200, { id: ITEM, number: "08213", displayName: "مرتبة هوفن كلاسيك", blocked: false });
        if (req.method === "PATCH" && url.pathname === `${company}/items(${ITEM})/picture/pictureContent`) {
          pictureBytes = body;
          return send(204, "", "text/plain");
        }
        if (req.method === "GET" && url.pathname === `${company}/items(${ITEM})/picture`) {
          return send(200, pictureBytes ? { id: ITEM, width: 1600, height: 1200, contentType: "image/jpeg", "@odata.etag": `W/"${pictureBytes.length}"` } : { id: ITEM, width: 0, height: 0, contentType: "" });
        }
        if (req.method === "GET" && url.pathname === `${company}/items(${ITEM})/picture/pictureContent`) return send(200, pictureBytes ?? Buffer.alloc(0), "image/jpeg");
        if (req.method === "GET" && url.pathname === "/admin/products") {
          return send(200, { products: [{ id: "prod_1", handle: "bc-08213", title: "مرتبة هوفن كلاسيك", status: "published", thumbnail: null, metadata: { bc_item_id: ITEM, bc_item_number: "08213" }, images: [] }] });
        }
        if (req.method === "POST" && url.pathname === "/admin/uploads") return send(200, { files: [{ id: "f1", url: "https://files.example/bc-08213.jpg" }] });
        if (req.method === "POST" && url.pathname === "/admin/products/prod_1") {
          productPosts.push(JSON.parse(body.toString() || "{}"));
          return send(200, { product: { id: "prod_1" } });
        }
        send(404, { error: "no route" });
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const env = () => {
    uploadedLog ??= [];
    const db = {
      getSettings: async () => ({ company_id: COMPANY, hide_without_picture: "" }),
      logPictureUpload: async (row) => uploadedLog.push(row),
      listPictureUploads: async () => uploadedLog,
    };
    return {
      STORE: { idFromName: () => "main", get: () => db },
      BC_ENVIRONMENT_URL: base,
      BC_TENANT_ID: "tenant",
      BC_CLIENT_ID: "client",
      BC_CLIENT_SECRET: "secret",
      BC_AUTHORITY_URL: base,
      MEDUSA_BACKEND_URL: base,
      MEDUSA_ADMIN_API_KEY: "key",
    };
  };
  const call = async (path, { method = "GET", body, headers = {} } = {}) => {
    const request = new Request(`https://mw.example${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    // The Worker hands the API the pathname only (src/index.js), never the query
    const res = await middlewareApi(request, env(), new URL(request.url).pathname);
    const type = res.headers.get("content-type") || "";
    return { status: res.status, data: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };

  it("searches BC by number or name, with the filter OData-encoded", async () => {
    const { status, data } = await call("/api/middleware/pictures/search?q=0821");
    expect(status).toEqual(200);
    expect(data.items).toEqual([{ id: ITEM, number: "08213", name: "مرتبة هوفن كلاسيك", blocked: false }]);
    const q = seen.find((s) => s.path.endsWith("/items") && s.method === "GET").query;
    expect(decodeURIComponent(q).includes("contains(number,'0821') or contains(displayName,'0821')")).toEqual(true);
  });

  it("refuses a search shorter than two characters", async () => {
    expect((await call("/api/middleware/pictures/search?q=a")).status).toEqual(400);
  });

  it("shows the item with no picture yet, and its product in the store", async () => {
    const { data } = await call(`/api/middleware/pictures/${ITEM}`);
    expect(data.picture.has).toEqual(false);
    expect(data.product).toEqual({ id: "prod_1", handle: "bc-08213", status: "published", thumbnail: null });
  });

  it("writes the picture to BC as raw bytes with If-Match *, and logs who did it", async () => {
    const { status, data } = await call(`/api/middleware/pictures/${ITEM}`, {
      method: "POST",
      body: { image: `data:image/jpeg;base64,${b64(JPEG)}` },
      headers: { "cf-access-authenticated-user-email": "agent@hoven.example" },
    });
    expect(status).toEqual(200);
    expect(data.bytes).toEqual(JPEG.length);
    const patch = seen.find((s) => s.method === "PATCH");
    expect([patch.headers["content-type"], patch.headers["if-match"], patch.headers.authorization]).toEqual(["application/octet-stream", "*", "Bearer t"]);
    expect(Buffer.compare(patch.body, Buffer.from(JPEG))).toEqual(0);
    expect(uploadedLog.at(-1)).toEqual({ item_id: ITEM, item_number: "08213", item_name: "مرتبة هوفن كلاسيك", bytes: JPEG.length, by: "agent@hoven.example" });
  });

  it("refuses a file that is not a real JPEG or PNG, and writes nothing", async () => {
    const before = seen.filter((s) => s.method === "PATCH").length;
    const { status, data } = await call(`/api/middleware/pictures/${ITEM}`, { method: "POST", body: { image: `data:image/png;base64,${b64(JPEG)}` } });
    expect([status, data.error]).toEqual([400, "محتوى الملف لا يطابق نوع الصورة."]);
    expect(seen.filter((s) => s.method === "PATCH").length).toEqual(before);
  });

  it("serves the BC picture for the preview", async () => {
    const { status, data } = await call(`/api/middleware/pictures/${ITEM}/content`);
    expect(status).toEqual(200);
    expect(Buffer.compare(data, Buffer.from(JPEG))).toEqual(0);
  });

  it("carries the new picture to the product now: uploaded to Medusa, first image and thumbnail", async () => {
    const { status, data } = await call(`/api/middleware/pictures/${ITEM}/transfer`, { method: "POST", body: {} });
    expect(status).toEqual(200);
    expect(data.summary.uploaded).toEqual(1);
    const post = productPosts.at(-1);
    expect([post.thumbnail, post.images[0].url, post.metadata.bc_picture_url]).toEqual(["https://files.example/bc-08213.jpg", "https://files.example/bc-08213.jpg", "https://files.example/bc-08213.jpg"]);
  });

  it("answers 404 for an id that is not a BC id", async () => {
    expect((await call("/api/middleware/pictures/not-an-id")).status).toEqual(404);
  });
});
