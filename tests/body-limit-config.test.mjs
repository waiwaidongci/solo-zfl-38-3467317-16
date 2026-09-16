import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, ConfigError } from "../lib/app.js";

let dir;
async function freshDir() {
  if (!dir) dir = await mkdtemp(join(tmpdir(), "knot-cfg-"));
  return join(dir, `${Math.random().toString(36).slice(2)}.json`);
}
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function startApp(opts) {
  const app = createApp({ dbPath: await freshDir(), ...opts });
  await new Promise((r) => app.server.listen(0, r));
  return app;
}
function stopApp(app) {
  return new Promise((r) => app.server.close(r));
}
async function post(port, path, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? undefined : Buffer.from(body);
    const creq = http.request({ port, path, method: "POST", headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }));
    });
    creq.on("error", (e) => resolve({ error: String(e) }));
    if (data) creq.end(data);
    else creq.end();
  });
}

const VALID_REG = JSON.stringify({
  ropeNo: "R-C", location: "桅", diameterMm: 10, knotType: "bowline",
  turns: 2, tailLengthMm: 120, preloadN: 100, ratedLoadN: 1000, formerName: "甲", inspectorName: "乙",
});

test("无效 option：NaN/Infinity/负数/小数/字符串/布尔/超范围 在启动期抛 ConfigError", () => {
  const bad = [NaN, Infinity, -Infinity, -1, -0.0001, 1.5, "256", "", true, false, null, [], {}, Number.MAX_SAFE_INTEGER + 1, 1e20];
  for (const v of bad) {
    assert.throws(
      () => createApp({ dbPath: "/tmp/unused.json", maxBodyBytes: v }),
      (e) => e instanceof ConfigError,
      `maxBodyBytes=${String(v)} 应抛 ConfigError`
    );
  }
});

test("无效环境变量：非数字/负数/小数/带空格/科学计数法 启动失败", () => {
  for (const v of ["abc", "NaN", "Infinity", "-1", "1.5", "100 ", " 100", "1e3", "0x10", "true"]) {
    withEnv({ KNOT_MAX_BODY_BYTES: v }, () => {
      assert.throws(() => createApp({ dbPath: "/tmp/unused.json" }), ConfigError, `env=${v}`);
    });
  }
});

test("合法 option 边界：0 与 MAX_SAFE_INTEGER 均可启动", async () => {
  const zero = await startApp({ maxBodyBytes: 0 });
  await stopApp(zero);
  const max = await startApp({ maxBodyBytes: Number.MAX_SAFE_INTEGER });
  await stopApp(max);
  assert.ok(true);
});

test("上限为 0：任何有字节的请求体 413，空体可正常处理", async () => {
  const app = await startApp({ maxBodyBytes: 0 });
  const port = app.server.address().port;
  const withBody = await post(port, "/api/ropes", VALID_REG);
  assert.equal(withBody.status, 413);
  assert.equal(withBody.json.error, "payload_too_large");
  assert.equal(app.store.db.ropes.length, 0);
  // 空体（0 字节）不超限：进入类型校验，返回 400 而非 413/500
  const empty = await post(port, "/api/ropes", "");
  assert.equal(empty.status, 400);
  await stopApp(app);
});

test("合法数字 option 生效：恰在上限内 201，超过 413，服务继续可用", async () => {
  const len = Buffer.byteLength(VALID_REG);
  const app = await startApp({ maxBodyBytes: len });
  const port = app.server.address().port;
  const exact = await post(port, "/api/ropes", VALID_REG);
  assert.equal(exact.status, 201, `恰好 ${len} 字节应接受`);
  const over = await post(port, "/api/ropes", VALID_REG.replace('"R-C"', '"R-C2"'));
  assert.equal(over.status, 413);
  // 服务继续可用
  const alive = await new Promise((resolve) => http.get({ port, path: "/api/knots" }, (r) => resolve(r.statusCode)));
  assert.equal(alive, 200);
  await stopApp(app);
});

test("环境变量整数生效且优先于默认；显式 option 优先于环境变量", async () => {
  // 环境变量给一个很小的上限：正常登记体必 413
  await withEnv({ KNOT_MAX_BODY_BYTES: "10" }, async () => {
    const app = await startApp();
    const port = app.server.address().port;
    assert.equal((await post(port, "/api/ropes", VALID_REG)).status, 413);
    await stopApp(app);
  });
  // 显式 option 覆盖环境变量（option=大值，env=10）→ 接受
  await withEnv({ KNOT_MAX_BODY_BYTES: "10" }, async () => {
    const app = await startApp({ maxBodyBytes: 1 << 20 });
    const port = app.server.address().port;
    assert.equal((await post(port, "/api/ropes", VALID_REG)).status, 201);
    await stopApp(app);
  });
});

test("未配置时使用默认 1MiB：普通请求正常，明显超过才 413", async () => {
  await withEnv({ KNOT_MAX_BODY_BYTES: undefined }, async () => {
    const app = await startApp();
    const port = app.server.address().port;
    assert.equal((await post(port, "/api/ropes", VALID_REG)).status, 201);
    const huge = JSON.stringify({ ropeNo: "R-HUGE", pad: "z".repeat(1024 * 1024 + 50) });
    assert.equal((await post(port, "/api/ropes", huge)).status, 413);
    assert.equal(app.store.db.ropes.length, 1, "超限不写入，正常 1 条");
    await stopApp(app);
  });
});

test("无效配置绝不静默退化为无上限：启动失败优于带着 NaN 运行", () => {
  // 直接验证解析结果不会落到 NaN/无限大
  withEnv({ KNOT_MAX_BODY_BYTES: "not-a-number" }, () => {
    assert.throws(() => createApp({ dbPath: "/tmp/unused.json" }), ConfigError);
  });
});
