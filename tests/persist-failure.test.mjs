import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createApp } from "../lib/app.js";
import { JsonStore, PersistError } from "../lib/store.js";

process.env.ENABLE_FAULTS = "1";

let dir, dbPath, app, base, seq = 0;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "knot-persist-"));
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
  await chmod(dir, 0o755).catch(() => {});
  const st = await stat(dbPath).catch(() => null);
  if (st && st.isDirectory()) await rm(dbPath, { recursive: true, force: true });
  await app.store.reset();
});

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const reg = (over = {}) => ({
  ropeNo: `R-P${++seq}`,
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
const tmpFiles = () => readdir(dir).then((ns) => ns.filter((n) => n.includes(".tmp-")));

test("故障注入：500 响应是稳定错误码，不含路径或系统错误，且无临时文件残留", async () => {
  const before = (await req("GET", "/api/ropes")).json.length;
  await req("POST", "/api/test/fail-next-writes", { count: 1 });
  const r = await req("POST", "/api/ropes", reg());
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "persist_failed");
  assert.ok(r.json.message && typeof r.json.message === "string");
  const leaked = JSON.stringify(r.json);
  assert.ok(!leaked.includes(dir), "不应包含绝对路径");
  assert.ok(!/tmp-|EISDIR|ENOENT|injected|Error:|at \w+ \//.test(leaked), "不应包含系统错误/堆栈");
  assert.equal((await req("GET", "/api/ropes")).json.length, before); // 内存回滚
  assert.deepEqual(await tmpFiles(), []); // 无残留
});

test("真实写失败（目录只读）：原库字节不变、内存回滚、无临时文件、恢复后重试成功", async () => {
  // 先成功写一条，拿到稳定的原库内容
  const ok0 = await req("POST", "/api/ropes", reg());
  assert.equal(ok0.status, 201);
  const originalBytes = await readFile(dbPath, "utf8");
  const beforeCount = (await req("GET", "/api/ropes")).json.length;

  await chmod(dir, 0o555); // 数据目录只读 → 写临时文件 EACCES
  const r = await req("POST", "/api/ropes", reg());
  await chmod(dir, 0o755);
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "persist_failed");
  assert.equal(r.json.reason, "write_failed");
  assert.ok(!JSON.stringify(r.json).includes(dir));

  // 原库字节不变
  assert.equal(await readFile(dbPath, "utf8"), originalBytes);
  // 内存回滚
  assert.equal((await req("GET", "/api/ropes")).json.length, beforeCount);
  // 无临时文件残留
  assert.deepEqual(await tmpFiles(), []);

  // 恢复后重试成功并真正落盘
  const retry = await req("POST", "/api/ropes", reg());
  assert.equal(retry.status, 201, JSON.stringify(retry.json));
  const onDisk = JSON.parse(await readFile(dbPath, "utf8"));
  assert.equal(onDisk.ropes.length, beforeCount + 1);
});

test("真实改名失败（目标路径是目录）：临时文件被清理、原目标保持、删除后重试成功", async () => {
  const beforeCount = (await req("GET", "/api/ropes")).json.length;
  // 把数据库文件替换成同名目录 → writeFile(tmp) 成功、rename(tmp, 目录) 失败 EISDIR
  await rm(dbPath, { force: true });
  await mkdir(dbPath, { recursive: true });
  await writeFile(join(dbPath, "keep"), "orig");

  const r = await req("POST", "/api/ropes", reg());
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "persist_failed");
  assert.equal(r.json.reason, "rename_failed");
  assert.ok(!JSON.stringify(r.json).includes(dir));
  assert.ok(!/EISDIR/.test(JSON.stringify(r.json)));

  // 本次临时文件已清理，同名目录及其内容保持
  assert.deepEqual(await tmpFiles(), []);
  assert.equal(await readFile(join(dbPath, "keep"), "utf8"), "orig");
  // 内存回滚
  assert.equal(app.store.db.ropes.length, beforeCount);

  // 删除障碍后重试：rename 成功，库恢复为普通文件
  await rm(dbPath, { recursive: true, force: true });
  const retry = await req("POST", "/api/ropes", reg());
  assert.equal(retry.status, 201, JSON.stringify(retry.json));
  const st = await stat(dbPath);
  assert.ok(st.isFile());
  assert.deepEqual(await tmpFiles(), []);
});

test("循环/定案写盘失败同样回滚且脱敏", async () => {
  const rope = await req("POST", "/api/ropes", reg());
  const id = rope.json.id;
  for (let i = 1; i <= 5; i++) {
    await req("POST", `/api/ropes/${id}/cycles`, { expectedSeq: i, loadN: 400, tailSlipMm: [2, 3, 4, 4.5, 4.8][i - 1] });
  }
  await req("POST", "/api/test/fail-next-writes", { count: 1 });
  const cyc = await req("POST", `/api/ropes/${id}/cycles`, { expectedSeq: 6, loadN: 400, tailSlipMm: 5 });
  assert.equal(cyc.status, 500);
  assert.equal(cyc.json.error, "persist_failed");
  assert.ok(!JSON.stringify(cyc.json).includes(dir));
  assert.equal((await req("GET", `/api/ropes/${id}`)).json.cycles.length, 5);

  await req("POST", "/api/test/fail-next-writes", { count: 1 });
  const conf = await req("POST", `/api/ropes/${id}/confirm`, { inspectorName: "李四" });
  assert.equal(conf.status, 500);
  assert.equal(conf.json.error, "persist_failed");
  assert.equal((await req("GET", `/api/ropes/${id}`)).json.confirmation, null);
  assert.deepEqual(await tmpFiles(), []);

  // 故障解除后正常定案
  const ok = await req("POST", `/api/ropes/${id}/confirm`, { inspectorName: "李四" });
  assert.equal(ok.status, 201);
});

test("启动清理：只清本库遗留临时文件，不碰其他数据库", async () => {
  const d2 = await mkdtemp(join(tmpdir(), "knot-cleanup-"));
  try {
    const aPath = join(d2, "alpha.json");
    const bPath = join(d2, "beta.json");
    // 两个库各自的遗留临时文件 + 一个无关文件
    await writeFile(`${aPath}.tmp-111-1`, "stale-a");
    await writeFile(`${aPath}.tmp-111-2`, "stale-a2");
    await writeFile(`${bPath}.tmp-222-1`, "stale-b");
    await writeFile(join(d2, "unrelated.txt"), "x");

    const storeA = new JsonStore(aPath);
    await storeA.load(); // 代表启动

    const left = await readdir(d2);
    assert.ok(!left.some((n) => n.startsWith(basename(aPath) + ".tmp-")), "本库临时文件应被清理");
    assert.ok(left.includes(`${basename(bPath)}.tmp-222-1`), "其他库临时文件不得被动");
    assert.ok(left.includes("unrelated.txt"), "无关文件不得被动");

    // 再次启动（幂等）不报错
    const storeA2 = new JsonStore(aPath);
    await storeA2.load();
  } finally {
    await rm(d2, { recursive: true, force: true });
  }
});

test("PersistError 只携带稳定错误码，message 不含路径", async () => {
  const e = new PersistError("rename_failed");
  assert.equal(e.name, "PersistError");
  assert.equal(e.code, "rename_failed");
  assert.equal(e.message, "rename_failed"); // 不拼接任何路径或系统信息
});
