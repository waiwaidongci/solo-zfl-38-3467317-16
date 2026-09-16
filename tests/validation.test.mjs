import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../lib/app.js";

process.env.ENABLE_FAULTS = "1";

let dir, dbPath, app, base, seq = 0;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "knot-validation-"));
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
async function rawPost(path, text) {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function disk() {
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function diskMtime() {
  return (await stat(dbPath)).mtimeMs;
}

const validReg = () => {
  seq += 1;
  return {
    ropeNo: `R-V${seq}`,
    location: "前桅侧支索",
    diameterMm: 10,
    knotType: "figure-eight-follow-through",
    turns: 2,
    tailLengthMm: 120,
    preloadN: 100,
    ratedLoadN: 1000,
    formerName: "张三",
    inspectorName: "李四",
  };
};

async function healthyRope() {
  const r = await req("POST", "/api/ropes", validReg());
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

// 一组“坏请求体”：形状错误
const BAD_SHAPES = [null, true, false, [], "string", 42, 3.14];

test("登记：空请求体 / 非法 JSON / null / 布尔 / 数组 / 字符串 / 数字 全部 400", async () => {
  // 完全没有 body
  const empty = await req("POST", "/api/ropes", undefined);
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, "invalid_registration");
  assert.equal((await req("POST", "/api/ropes", {})).status, 400);
  for (const shape of BAD_SHAPES) {
    const r = await req("POST", "/api/ropes", shape);
    assert.equal(r.status, 400, `形状 ${JSON.stringify(shape)} 应 400，实际 ${r.status}`);
    assert.equal(r.json.error, "invalid_registration");
  }
  const badJson = await rawPost("/api/ropes", "{not json");
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error, "bad_json");
});

test("登记：每个字段错误类型都 400，且布尔/数组/对象不会被转成数字或字符串", async () => {
  const badValues = [true, false, [], {}, "abc", null];
  const numFields = ["diameterMm", "turns", "tailLengthMm", "preloadN", "ratedLoadN"];
  for (const field of numFields) {
    for (const v of badValues) {
      const body = validReg();
      body[field] = v;
      const r = await req("POST", "/api/ropes", body);
      assert.equal(r.status, 400, `${field}=${JSON.stringify(v)} 应 400`);
    }
  }
  // 非有限数：NaN / Infinity（JSON.stringify 后变成 null）也要拒绝
  for (const field of numFields) {
    const body = validReg();
    body[field] = null;
    assert.equal((await req("POST", "/api/ropes", body)).status, 400);
  }
  // 数字字段给可强转的字符串也拒绝（不做隐式转换）
  for (const field of numFields) {
    const body = validReg();
    body[field] = "10";
    assert.equal((await req("POST", "/api/ropes", body)).status, 400, `${field}=\"10\" 应 400`);
  }
  // 布尔给字符串字段
  for (const field of ["ropeNo", "location", "formerName", "inspectorName", "knotType"]) {
    const body = validReg();
    body[field] = true;
    assert.equal((await req("POST", "/api/ropes", body)).status, 400, `${field}=true 应 400`);
  }
  // 空字符串
  for (const field of ["ropeNo", "location", "formerName", "inspectorName"]) {
    const body = validReg();
    body[field] = "   ";
    assert.equal((await req("POST", "/api/ropes", body)).status, 400);
  }
  // 绕圈数非整数 / 非正数
  for (const turns of [1.5, 0, -2]) {
    const body = validReg();
    body.turns = turns;
    assert.equal((await req("POST", "/api/ropes", body)).status, 400, `turns=${turns}`);
  }
  // 未知字段拒绝
  const body = validReg();
  body.evil = { nested: 1 };
  const r = await req("POST", "/api/ropes", body);
  assert.equal(r.status, 400);
  assert.ok(r.json.details.join(";").includes("不允许的字段"));
  // note 必须是字符串
  const badNote = validReg();
  badNote.note = 123;
  assert.equal((await req("POST", "/api/ropes", badNote)).status, 400);
});

test("登记失败：内存与磁盘都不改变", async () => {
  const before = await disk();
  const mtime = await diskMtime();
  const bad = validReg();
  bad.diameterMm = true; // 布尔，旧实现会落库为 1
  const r = await req("POST", "/api/ropes", bad);
  assert.equal(r.status, 400);
  await new Promise((r) => setTimeout(r, 15));
  const after = await disk();
  assert.deepEqual(after, before);
  assert.equal((await diskMtime()), mtime, "磁盘文件不应被写入");
  assert.equal((await req("GET", "/api/ropes")).json.length, 0);
  assert.equal(app.store.db.ropes.length, 0);
});

test("循环：空体/坏形状/字段错误类型全部 400；布尔不被转成数字", async () => {
  const rope = await healthyRope();
  const path = `/api/ropes/${rope.id}/cycles`;
  for (const shape of BAD_SHAPES) {
    const r = await req("POST", path, shape);
    assert.equal(r.status, 400, `形状 ${JSON.stringify(shape)} 应 400`);
  }
  assert.equal((await req("POST", path, {})).status, 400);
  assert.equal((await rawPost(path, "{")).status, 400);

  const cases = [
    { expectedSeq: true, loadN: 400, tailSlipMm: 2 }, // 序号布尔（旧实现 201 落库 1）
    { expectedSeq: "1", loadN: 400, tailSlipMm: 2 }, // 序号字符串
    { expectedSeq: 1.5, loadN: 400, tailSlipMm: 2 },
    { expectedSeq: 0, loadN: 400, tailSlipMm: 2 },
    { expectedSeq: 1, loadN: true, tailSlipMm: 2 }, // 载荷布尔（旧实现 201 落库 1）
    { expectedSeq: 1, loadN: "400", tailSlipMm: 2 },
    { expectedSeq: 1, loadN: [400], tailSlipMm: 2 }, // 载荷数组
    { expectedSeq: 1, loadN: { x: 1 }, tailSlipMm: 2 },
    { expectedSeq: 1, loadN: 0, tailSlipMm: 2 },
    { expectedSeq: 1, loadN: -5, tailSlipMm: 2 },
    { expectedSeq: 1, loadN: 400, tailSlipMm: true },
    { expectedSeq: 1, loadN: 400, tailSlipMm: "2" },
    { expectedSeq: 1, loadN: 400, tailSlipMm: -1 },
    { expectedSeq: 1, loadN: 400 }, // 缺滑移
    { loadN: 400, tailSlipMm: 2 }, // 缺序号
    { expectedSeq: 1, tailSlipMm: 2 }, // 缺载荷
    { expectedSeq: 1, loadN: 400, tailSlipMm: 2, extra: 1 }, // 未知字段
  ];
  for (const c of cases) {
    const r = await req("POST", path, c);
    assert.equal(r.status, 400, `${JSON.stringify(c)} 应 400，实际 ${r.status} ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error, "invalid_cycle");
  }
  // 全部失败后：该索仍无循环，磁盘不变
  const got = await req("GET", `/api/ropes/${rope.id}`);
  assert.equal(got.json.cycles.length, 0);
  assert.equal(app.store.db.ropes[0].cycles.length, 0);
});

test("定案：空体/坏形状/签名错误类型 400；类型正确但人不对才 403", async () => {
  const rope = await healthyRope();
  const path = `/api/ropes/${rope.id}/confirm`;
  for (const shape of BAD_SHAPES) {
    const r = await req("POST", path, shape);
    assert.equal(r.status, 400, `形状 ${JSON.stringify(shape)} 应 400，实际 ${r.status}`);
  }
  assert.equal((await req("POST", path, {})).status, 400);
  for (const bad of [{ inspectorName: true }, { inspectorName: 123 }, { inspectorName: [] }, { inspectorName: "  " }, { inspectorName: "李四", extra: 1 }]) {
    const r = await req("POST", path, bad);
    assert.equal(r.status, 400, `${JSON.stringify(bad)} 应 400`);
  }
  // 类型正确、人不对 → 403（职责分离语义保留）
  assert.equal((await req("POST", path, { inspectorName: "赵六" })).status, 403);
  // 所有失败都不产生定案
  assert.equal((await req("GET", `/api/ropes/${rope.id}`)).json.confirmation, null);
  assert.equal(app.store.db.ropes[0].confirmation, null);
});

test("批量：空体/坏形状/ids 错误类型/重复 id 400，失败不锁定任何索", async () => {
  const r1 = await healthyRope();
  const r2 = await healthyRope();
  const path = "/api/ropes/batch-confirm";
  for (const shape of BAD_SHAPES) {
    const r = await req("POST", path, shape);
    assert.equal(r.status, 400, `形状 ${JSON.stringify(shape)} 应 400`);
  }
  const bads = [
    {},
    { ids: [] },
    { ids: [], inspectorName: "李四" },
    { ids: [r1.id] }, // 缺签名
    { ids: "string", inspectorName: "李四" },
    { ids: [r1.id, 123], inspectorName: "李四" },
    { ids: [r1.id, null], inspectorName: "李四" },
    { ids: [r1.id, {}], inspectorName: "李四" },
    { ids: [r1.id, r1.id], inspectorName: "李四" }, // 重复
    { ids: [r1.id], inspectorName: true },
    { ids: [r1.id], inspectorName: "李四", extra: 1 },
  ];
  for (const b of bads) {
    const r = await req("POST", path, b);
    assert.equal(r.status, 400, `${JSON.stringify(b)} 应 400，实际 ${r.status}`);
  }
  for (const id of [r1.id, r2.id]) {
    assert.equal((await req("GET", `/api/ropes/${id}`)).json.confirmation, null);
  }
});

test("故障注入端点同样严格校验", async () => {
  for (const body of [null, true, [], { count: true }, { count: "1" }, { count: 1.5 }, { count: 0 }]) {
    const r = await req("POST", "/api/test/fail-next-writes", body);
    if (body === null || body === true || Array.isArray(body)) assert.equal(r.status, 400, JSON.stringify(body));
    else if (body && body.count !== undefined) assert.equal(r.status, 400, JSON.stringify(body));
  }
  // {} 用默认 1 次
  assert.equal((await req("POST", "/api/test/fail-next-writes", {})).status, 200);
});
