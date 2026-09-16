import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../lib/app.js";

process.env.ENABLE_FAULTS = "1";

const MAX_BODY = 256;
let dir, app, port, base, seq = 0;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "knot-edge-"));
  app = createApp({ dbPath: join(dir, "knot.json"), maxBodyBytes: MAX_BODY });
  await new Promise((r) => app.server.listen(0, r));
  port = app.server.address().port;
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  await new Promise((r) => app.server.close(r));
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await app.store.reset();
});

function fetchApi(method, path, body) {
  return fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body,
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => ({})) }));
}
const j = (method, path, obj) => fetchApi(method, path, obj === undefined ? undefined : JSON.stringify(obj));

// 原生 http：可发送 chunked 且流式推送
function rawChunked(path, chunks) {
  return new Promise((resolve, reject) => {
    const creq = http.request(
      { port, path, method: "POST", headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" } },
      (cres) => {
        let data = "";
        cres.on("data", (d) => (data += d));
        cres.on("end", () => resolve({ status: cres.statusCode, json: JSON.parse(data || "{}") }));
      }
    );
    creq.on("error", reject);
    chunks.forEach((c) => creq.write(c));
    creq.end();
  });
}

const reg = (over = {}) => ({
  ropeNo: `R-E${++seq}`,
  location: "侧支索",
  diameterMm: 10,
  knotType: "figure-eight-follow-through",
  turns: 2,
  tailLengthMm: 120,
  preloadN: 100,
  ratedLoadN: 1000,
  formerName: "张三",
  inspectorName: "李四",
  ...over,
});

test("畸形路径：各标识端点返回 400 malformed_path，而不是 500", async () => {
  const malformedGet = ["/api/ropes/%ff", "/api/ropes/%zz", "/api/ropes/%", "/api/ropes/%E0%A4%A"];
  for (const u of malformedGet) {
    const r = await fetchApi("GET", u);
    assert.equal(r.status, 400, `GET ${u}`);
    assert.equal(r.json.error, "malformed_path");
    assert.ok(!JSON.stringify(r.json).includes(dir), "不得泄露内部路径");
  }
  for (const u of ["/api/ropes/by-rope-no/%ff", "/api/ropes/by-rope-no/%zz"]) {
    const r = await fetchApi("GET", u);
    assert.equal(r.status, 400, `GET ${u}`);
    assert.equal(r.json.error, "malformed_path");
  }
  // 写接口：400 且不改动数据
  const cyc = await j("POST", "/api/ropes/%ff/cycles", { expectedSeq: 1, loadN: 1, tailSlipMm: 0 });
  assert.equal(cyc.status, 400);
  assert.equal(cyc.json.error, "malformed_path");
  const conf = await j("POST", "/api/ropes/%ff/confirm", { inspectorName: "李四" });
  assert.equal(conf.status, 400);
  assert.equal(conf.json.error, "malformed_path");
  assert.equal(app.store.db.ropes.length, 0);
});

test("畸形路径不影响合法索：合法端点仍可用", async () => {
  const created = await j("POST", "/api/ropes", reg());
  assert.equal(created.status, 201);
  assert.equal((await fetchApi("GET", "/api/ropes/%ff")).status, 400);
  const ok = await fetchApi("GET", `/api/ropes/${created.json.id}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.id, created.json.id);
});

test("超大请求体（Content-Length 已知超限）：解析前 413，登记不写入，服务继续可用", async () => {
  const body = JSON.stringify(reg({ note: "x".repeat(MAX_BODY + 200) }));
  assert.ok(Buffer.byteLength(body, "utf8") > MAX_BODY);
  const r = await fetchApi("POST", "/api/ropes", body);
  assert.equal(r.status, 413);
  assert.equal(r.json.error, "payload_too_large");
  assert.equal(r.json.limitBytes, MAX_BODY);
  assert.ok(!JSON.stringify(r.json).includes(dir));
  assert.equal(app.store.db.ropes.length, 0);

  const ok = await j("POST", "/api/ropes", reg());
  assert.equal(ok.status, 201, "超限后服务必须继续可用");
});

test("超大请求体（chunked、长度未知）：流式累计超限 413，不写入", async () => {
  const head = JSON.stringify(reg({ note: "" })).replace(/"note":""\s*\}$/, '"note":"');
  const tail = '"}';
  const r = await rawChunked("/api/ropes", [
    Buffer.from(head),
    Buffer.alloc(MAX_BODY + 100, 0x79), // 流式推送到超过上限
    Buffer.from(tail),
  ]);
  assert.equal(r.status, 413);
  assert.equal(r.json.error, "payload_too_large");
  assert.equal(app.store.db.ropes.length, 0);
});

test("超大请求体在循环/定案/批量写接口同样 413 且不改动", async () => {
  const created = await j("POST", "/api/ropes", reg());
  const id = created.json.id;
  const cases = [
    [`/api/ropes/${id}/cycles`, JSON.stringify({ expectedSeq: 1, loadN: 1, tailSlipMm: 0, pad: "z".repeat(MAX_BODY) })],
    [`/api/ropes/${id}/confirm`, JSON.stringify({ inspectorName: "李四", pad: "z".repeat(MAX_BODY) })],
    ["/api/ropes/batch-confirm", JSON.stringify({ ids: [id], inspectorName: "李四", pad: "z".repeat(MAX_BODY) })],
  ];
  for (const [path, body] of cases) {
    const r = await fetchApi("POST", path, body);
    assert.equal(r.status, 413, `${path} 应 413，实际 ${r.status}`);
  }
  const got = await fetchApi("GET", `/api/ropes/${id}`);
  assert.equal(got.json.cycles.length, 0);
  assert.equal(got.json.confirmation, null);
});

test("请求体大小边界：等于上限接受、超过即 413", async () => {
  // 在同一个对象上把 note 精确填充到 MAX_BODY 字节，避免序号/引号带来长度误差
  const obj = reg();
  obj.note = "";
  const base = JSON.stringify(obj);
  const padLen = MAX_BODY - Buffer.byteLength(base, "utf8"); // 填入 n 个 p 恰好增加 n 字节
  assert.ok(padLen > 0);
  obj.note = "p".repeat(padLen);
  const exact = JSON.stringify(obj);
  assert.equal(Buffer.byteLength(exact, "utf8"), MAX_BODY);
  assert.equal((await fetchApi("POST", "/api/ropes", exact)).status, 201, "恰好上限应接受");

  obj.note = "p".repeat(padLen + 1);
  const oneOver = JSON.stringify(obj);
  assert.equal(Buffer.byteLength(oneOver, "utf8"), MAX_BODY + 1);
  assert.equal((await fetchApi("POST", "/api/ropes", oneOver)).status, 413, "超 1 字节应拒绝");
});
