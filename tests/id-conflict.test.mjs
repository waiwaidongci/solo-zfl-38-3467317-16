import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../lib/app.js";

let dir, dbPath, app, base;
let seq = 0;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "knot-idconflict-"));
  dbPath = join(dir, "knot.json");
  app = createApp({ dbPath });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await new Promise((r) => app.server.close(r));
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await app.store.reset();
});

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const baseReg = (over = {}) => ({
  ropeNo: `R-N${++seq}`,
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

async function register(over = {}) {
  const r = await req("POST", "/api/ropes", baseReg(over));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}
async function addHealthyCycles(id) {
  const slips = [2, 3.2, 4, 4.5, 4.8];
  for (let i = 1; i <= 5; i++) {
    const r = await req("POST", `/api/ropes/${id}/cycles`, { expectedSeq: i, loadN: 400, tailSlipMm: slips[i - 1] });
    assert.equal(r.status, 201, JSON.stringify(r.json));
  }
}

// 构造遗留冲突数据：A 正常登记；B 的自定义索号恰好等于 A 的内部编号。
// 正常登记接口已拦截这种情形，这里直接在存储层放入，模拟历史脏数据，
// 以证明写操作按内部编号精确定位、不会把 B 当 A。
async function setupConflict() {
  const A = await register({ ropeNo: "R-USER-A", location: "前桅" });
  const B = await register({ ropeNo: "R-PLAIN-NO", location: "后桅" });
  const bStore = app.store.db.ropes.find((x) => x.id === B.id);
  bStore.ropeNo = A.id; // 索号占用 A 的内部编号（冲突）
  await app.store.persist();
  return { A, B: bStore };
}

test("登记：新索号若等于任何已有内部编号 → 409，不写入", async () => {
  const A = await register();
  const before = app.store.db.ropes.length;
  const r = await req("POST", "/api/ropes", baseReg({ ropeNo: A.id }));
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "rope_no_matches_internal_id");
  assert.equal(app.store.db.ropes.length, before);
  const disk = JSON.parse(await readFile(dbPath, "utf8"));
  assert.equal(disk.ropes.some((x) => x.ropeNo === A.id), false);
});

test("查询：内部编号精确命中 A；同值作为索号只在 by-rope-no 命中 B；通用端点不静默回退", async () => {
  const { A } = await setupConflict();
  // GET /api/ropes/:id 严格按内部编号 → A
  const byId = await req("GET", `/api/ropes/${encodeURIComponent(A.id)}`);
  assert.equal(byId.status, 200);
  assert.equal(byId.json.id, A.id);
  assert.equal(byId.json.ropeNo, "R-USER-A");
  // 显式按索号端点 → B（其索号 == A.id）
  const byNo = await req("GET", `/api/ropes/by-rope-no/${encodeURIComponent(A.id)}`);
  assert.equal(byNo.status, 200);
  assert.equal(byNo.json.ropeNo, A.id);
  assert.notEqual(byNo.json.id, A.id);
  // 列表里两根索各自完整、互不串号
  const list = await req("GET", "/api/ropes");
  const a = list.json.find((x) => x.id === A.id);
  assert.equal(a.ropeNo, "R-USER-A");
});

test("循环：按 A 内部编号提交只写 A，不写到索号相同的 B", async () => {
  const { A, B } = await setupConflict();
  const r = await req("POST", `/api/ropes/${encodeURIComponent(A.id)}/cycles`, {
    expectedSeq: 1, loadN: 400, tailSlipMm: 2,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const A2 = app.store.db.ropes.find((x) => x.id === A.id);
  const B2 = app.store.db.ropes.find((x) => x.id === B.id);
  assert.equal(A2.cycles.length, 1);
  assert.equal(A2.cycles[0].seq, 1);
  assert.equal(B2.cycles.length, 0); // B 未被误写
  assert.equal(r.json.rope.id, A.id);
  assert.equal(r.json.rope.ropeNo, "R-USER-A");
});

test("定案：按 A 内部编号只定案 A；冲突的 B 保持未定案", async () => {
  const { A, B } = await setupConflict();
  await addHealthyCycles(A.id);
  const r = await req("POST", `/api/ropes/${encodeURIComponent(A.id)}/confirm`, { inspectorName: "李四" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const A2 = app.store.db.ropes.find((x) => x.id === A.id);
  const B2 = app.store.db.ropes.find((x) => x.id === B.id);
  assert.ok(A2.confirmation);
  assert.equal(B2.confirmation, null);
});

test("写操作误传“索号但不是任何内部编号”：明确 400 use_internal_id，不写记录", async () => {
  await register({ ropeNo: "R-PLAIN-NO" });
  const cyc = await req("POST", `/api/ropes/${encodeURIComponent("R-PLAIN-NO")}/cycles`, {
    expectedSeq: 1, loadN: 400, tailSlipMm: 2,
  });
  assert.equal(cyc.status, 400);
  assert.equal(cyc.json.error, "use_internal_id");
  const conf = await req("POST", `/api/ropes/${encodeURIComponent("R-PLAIN-NO")}/confirm`, { inspectorName: "李四" });
  assert.equal(conf.status, 400);
  assert.equal(conf.json.error, "use_internal_id");
  const target = app.store.db.ropes.find((x) => x.ropeNo === "R-PLAIN-NO");
  assert.equal(target.cycles.length, 0);
  assert.equal(target.confirmation, null);
});

test("批量：ids 含非内部编号（索号/未知）→ 400，整批不写、无半批", async () => {
  const good = await register();
  await addHealthyCycles(good.id);
  const before = app.store.db.ropes.map((x) => [x.id, !!x.confirmation]);
  // 混入一个“是索号但非内部编号”的值和一个未知值
  for (const bad of ["R-PLAIN-NO", "does-not-exist"]) {
    const r = await req("POST", "/api/ropes/batch-confirm", { ids: [good.id, bad], inspectorName: "李四" });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json.error, "invalid_batch_ids");
  }
  const after = app.store.db.ropes.map((x) => [x.id, !!x.confirmation]);
  assert.deepEqual(after, before); // 合法的 good 也未定案
});

test("重启后内部编号仍精确解析，索号/内部编号冲突不串号", async () => {
  const { A, B } = await setupConflict();
  await req("POST", `/api/ropes/${encodeURIComponent(A.id)}/cycles`, { expectedSeq: 1, loadN: 400, tailSlipMm: 2 });
  await new Promise((r) => app.server.close(r));
  const second = createApp({ dbPath });
  await new Promise((r) => second.server.listen(0, r));
  const port = second.server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/ropes/${encodeURIComponent(A.id)}`);
  const j = await res.json();
  assert.equal(j.id, A.id);
  assert.equal(j.cycles.length, 1);
  const B2 = second.store.db.ropes.find((x) => x.id === B.id);
  assert.equal(B2.cycles.length, 0);
  await new Promise((r) => second.server.close(r));
});
