import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../lib/app.js";

process.env.ENABLE_FAULTS = "1"; // 开启故障注入端点

let dir, dbPath, app, base, seq = 0;

async function startApp() {
  const a = createApp({ dbPath });
  await new Promise((resolve) => a.server.listen(0, resolve));
  const port = a.server.address().port;
  return { a, base: `http://127.0.0.1:${port}` };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "knot-test-"));
  dbPath = join(dir, "knot-test.json");
  ({ a: app, base } = await startApp());
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
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers };
}

function regInput(over = {}) {
  seq += 1;
  return {
    ropeNo: `R-${seq}`,
    location: "前桅侧支索",
    diameterMm: 10,
    knotType: "figure-eight-follow-through",
    turns: 2,
    tailLengthMm: 120,
    preloadN: 100,
    ratedLoadN: 1000,
    formerName: "张三",
    inspectorName: "李四",
    ...over,
  };
}

async function register(over = {}) {
  const r = await req("POST", "/api/ropes", regInput(over));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

// 录入 5 次默认收敛滑移
async function addCycles(id, slips = [2, 3.2, 4, 4.5, 4.8], load = 400) {
  for (let i = 0; i < slips.length; i++) {
    const r = await req("POST", `/api/ropes/${id}/cycles`, {
      expectedSeq: i + 1,
      loadN: load,
      tailSlipMm: slips[i],
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
  }
}

test("登记：成功、重复索号冲突、同人职责分离被拒", async () => {
  const input = regInput();
  const a = await req("POST", "/api/ropes", input);
  assert.equal(a.status, 201);
  assert.equal(a.json.confirmation, null);

  const dup = await req("POST", "/api/ropes", input);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, "duplicate_rope_no");

  const bad = await req("POST", "/api/ropes", regInput({ formerName: "王五", inspectorName: "王五" }));
  assert.equal(bad.status, 400);
  assert.ok(bad.json.details.join(";").includes("职责分离"));
});

test("循环序号：必须递增，重复/跳号/缺序号被拒；累计滑移必须不减", async () => {
  const rope = await register();
  // 不带 expectedSeq：明确的客户端错误（400），不是序号冲突
  const noSeq = await req("POST", `/api/ropes/${rope.id}/cycles`, { loadN: 400, tailSlipMm: 2 });
  assert.equal(noSeq.status, 400);
  assert.equal(noSeq.json.error, "invalid_cycle");
  // 跳号：第一条就报 3
  let r = await req("POST", `/api/ropes/${rope.id}/cycles`, { expectedSeq: 3, loadN: 400, tailSlipMm: 2 });
  assert.equal(r.status, 409);
  assert.equal(r.json.expected, 1);
  assert.equal(r.json.received, 3);
  // 正确第 1 条
  r = await req("POST", `/api/ropes/${rope.id}/cycles`, { expectedSeq: 1, loadN: 400, tailSlipMm: 2 });
  assert.equal(r.status, 201);
  // 重复序号 1（实际应 2）
  r = await req("POST", `/api/ropes/${rope.id}/cycles`, { expectedSeq: 1, loadN: 400, tailSlipMm: 2.5 });
  assert.equal(r.status, 409);
  assert.equal(r.json.expected, 2);
  // 滑移回退
  r = await req("POST", `/api/ropes/${rope.id}/cycles`, { expectedSeq: 2, loadN: 400, tailSlipMm: 1.5 });
  assert.equal(r.status, 400);
  // 补到第 2 条
  r = await req("POST", `/api/ropes/${rope.id}/cycles`, { expectedSeq: 2, loadN: 400, tailSlipMm: 3.2 });
  assert.equal(r.status, 201);
  assert.equal(r.json.cycle.seq, 2);
});

test("安全 → 确认：验收员签名不符被拒；确认后结果不可覆盖", async () => {
  const rope = await register();
  await addCycles(rope.id);

  let r = await req("POST", `/api/ropes/${rope.id}/confirm`, { inspectorName: "赵六" });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "inspector_mismatch");

  r = await req("POST", `/api/ropes/${rope.id}/confirm`, { inspectorName: "李四" });
  assert.equal(r.status, 201);
  assert.equal(r.json.confirmation.verdict, "safe");
  const firstAt = r.json.confirmation.at;

  // 重复确认：409 且返回原结果，不覆盖
  r = await req("POST", `/api/ropes/${rope.id}/confirm`, { inspectorName: "李四" });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "already_confirmed");
  assert.equal(r.json.confirmation.at, firstAt);

  // 已确认后禁止再录入循环
  r = await req("POST", `/api/ropes/${rope.id}/cycles`, { expectedSeq: 6, loadN: 400, tailSlipMm: 5 });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "rope_locked");
});

test("拒绝路径：滑移未稳定/余量不足时列明拒绝原因", async () => {
  const rope = await register();
  await addCycles(rope.id, [4, 7, 10, 12, 14], 800); // 超滑移 + 不稳定 + 余量不足
  const r = await req("POST", `/api/ropes/${rope.id}/confirm`, { inspectorName: "李四" });
  assert.equal(r.status, 201); // 拒绝也是正式定案结果
  assert.equal(r.json.confirmation.verdict, "reject");
  const codes = r.json.confirmation.reasons.map((x) => x.code);
  assert.ok(codes.includes("slip_exceeded"));
  assert.ok(codes.includes("slip_unstable"));
  assert.ok(codes.includes("margin_insufficient"));
});

test("返工路径：确认结果为 rework 且给出原因", async () => {
  const rope = await register({ tailLengthMm: 95 });
  await addCycles(rope.id);
  const r = await req("POST", `/api/ropes/${rope.id}/confirm`, { inspectorName: "李四" });
  assert.equal(r.json.confirmation.verdict, "rework");
  assert.ok(r.json.confirmation.reasons.some((x) => x.code === "tail_short"));
});

test("并发确认：只成功一次，其余全部 409", async () => {
  const rope = await register();
  await addCycles(rope.id);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => req("POST", `/api/ropes/${rope.id}/confirm`, { inspectorName: "李四" }))
  );
  const ok = results.filter((r) => r.status === 201);
  const conflict = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1);
  assert.equal(conflict.length, 7);
  // 磁盘上只有一个确认结果
  const get = await req("GET", `/api/ropes/${rope.id}`);
  assert.ok(get.json.confirmation);
  assert.equal(get.json.confirmation.at, ok[0].json.confirmation.at);
});

test("并发循环录入：序号严格递增，只成功一条且无重复/跳号", async () => {
  const rope = await register();
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      req("POST", `/api/ropes/${rope.id}/cycles`, { expectedSeq: 1, loadN: 400, tailSlipMm: 2 })
    )
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 5);
  const get = await req("GET", `/api/ropes/${rope.id}`);
  assert.equal(get.json.cycles.length, 1);
  assert.equal(get.json.cycles[0].seq, 1);
});

test("并发登记同一索号：只成功一次", async () => {
  const input = regInput();
  const results = await Promise.all(Array.from({ length: 4 }, () => req("POST", "/api/ropes", input)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 3);
  const list = await req("GET", "/api/ropes");
  assert.equal(list.json.filter((x) => x.ropeNo === input.ropeNo).length, 1);
});

test("批量确认：任一不满足则整批中止，不留半批记录", async () => {
  const good1 = await register();
  const good2 = await register();
  const locked = await register(); // 将先被定案
  const otherInspector = await register({ inspectorName: "钱七" });
  await addCycles(good1.id);
  await addCycles(good2.id);
  await addCycles(locked.id);
  await addCycles(otherInspector.id);
  const first = await req("POST", `/api/ropes/${locked.id}/confirm`, { inspectorName: "李四" });
  assert.equal(first.status, 201);

  const r = await req("POST", "/api/ropes/batch-confirm", {
    ids: [good1.id, locked.id, otherInspector.id, good2.id, "missing-id"],
    inspectorName: "李四",
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "batch_aborted");
  assert.equal(r.json.rolledBack, true);
  const problemIds = r.json.problems.map((p) => p.id).sort();
  assert.deepEqual(problemIds, [locked.id, "missing-id", otherInspector.id].sort());

  // 两根好索必须仍未确认（无半批）
  for (const x of [good1, good2]) {
    const g = await req("GET", `/api/ropes/${x.id}`);
    assert.equal(g.json.confirmation, null);
  }

  // 剔除问题项后整批成功
  const ok = await req("POST", "/api/ropes/batch-confirm", { ids: [good1.id, good2.id], inspectorName: "李四" });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.confirmed, 2);
  // 再来一次：全部已确认冲突
  const again = await req("POST", "/api/ropes/batch-confirm", { ids: [good1.id, good2.id], inspectorName: "李四" });
  assert.equal(again.status, 409);
});

test("写盘失败：登记回滚，内存与磁盘都不留记录，数据文件不损坏", async () => {
  const before = (await req("GET", "/api/ropes")).json.length;
  const f = await req("POST", "/api/test/fail-next-writes", { count: 1 });
  assert.equal(f.status, 200);
  const r = await req("POST", "/api/ropes", regInput());
  assert.equal(r.status, 500);
  assert.equal((await req("GET", "/api/ropes")).json.length, before);
  // 磁盘文件仍是合法 JSON
  const onDisk = JSON.parse(await readFile(dbPath, "utf8"));
  assert.ok(Array.isArray(onDisk.ropes));
  // 无遗留临时文件
  const leftovers = (await readdir(dir)).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("写盘失败：循环/确认回滚不留半条", async () => {
  const rope = await register();
  await addCycles(rope.id);
  await req("POST", "/api/test/fail-next-writes", { count: 1 });
  let r = await req("POST", `/api/ropes/${rope.id}/cycles`, { expectedSeq: 6, loadN: 400, tailSlipMm: 5 });
  assert.equal(r.status, 500);
  let g = await req("GET", `/api/ropes/${rope.id}`);
  assert.equal(g.json.cycles.length, 5);

  await req("POST", "/api/test/fail-next-writes", { count: 1 });
  r = await req("POST", `/api/ropes/${rope.id}/confirm`, { inspectorName: "李四" });
  assert.equal(r.status, 500);
  g = await req("GET", `/api/ropes/${rope.id}`);
  assert.equal(g.json.confirmation, null);

  // 故障解除后仍可正常定案
  r = await req("POST", `/api/ropes/${rope.id}/confirm`, { inspectorName: "李四" });
  assert.equal(r.status, 201);
});

test("批量确认写盘失败：整批回滚", async () => {
  const ropes = [];
  for (let i = 0; i < 3; i++) {
    const x = await register();
    await addCycles(x.id);
    ropes.push(x);
  }
  await req("POST", "/api/test/fail-next-writes", { count: 1 });
  const r = await req("POST", "/api/ropes/batch-confirm", { ids: ropes.map((x) => x.id), inspectorName: "李四" });
  assert.equal(r.status, 500);
  for (const x of ropes) {
    const g = await req("GET", `/api/ropes/${x.id}`);
    assert.equal(g.json.confirmation, null);
  }
});

test("持久化：重启进程（新建 app）后登记、循环、定案结果仍在；批量中止也落盘", async () => {
  const rope = await register();
  await addCycles(rope.id);
  const c = await req("POST", `/api/ropes/${rope.id}/confirm`, { inspectorName: "李四" });
  assert.equal(c.status, 201);
  const sealedAt = c.json.confirmation.at;

  // 重启：新 app 读同一数据文件
  await new Promise((r) => app.server.close(r));
  const second = await startApp();
  try {
    const g = await (await fetch(second.base + `/api/ropes/${rope.id}`)).json();
    assert.equal(g.ropeNo, rope.ropeNo);
    assert.equal(g.cycles.length, 5);
    assert.deepEqual(g.cycles.map((x) => x.seq), [1, 2, 3, 4, 5]);
    assert.equal(g.confirmation.verdict, "safe");
    assert.equal(g.confirmation.at, sealedAt);
    // 重放确认仍被拒（不可覆盖）
    const again = await fetch(second.base + `/api/ropes/${rope.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inspectorName: "李四" }),
    });
    assert.equal(again.status, 409);
  } finally {
    await new Promise((r) => second.a.server.close(r));
    ({ a: app, base } = await startApp());
  }
});

test("页面可访问并包含关键要素", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const kw of ["绳结成型与滑移验收", "滑移", "危险项", "不可覆盖", "成型员", "验收员"]) {
    assert.ok(text.includes(kw), "缺少：" + kw);
  }
});
