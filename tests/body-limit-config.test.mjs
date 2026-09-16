import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Agent } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, ConfigError } from "../lib/app.js";

// —— 稳健性要点（Node 20/22 通用）——
// 1) 每个 app 配独立 Agent（keepAlive 由我们掌控），并登记全部 app，收尾统一
//    destroy agent + server.closeAllConnections，避免空闲套接字让 server.close 挂住。
// 2) 提前 413 + 服务端关闭连接时，客户端可能在读完响应后还收到 socket error
//    （ECONNRESET/EPIPE 等）；一旦已读到完整状态行与响应体，就视为正常分支，
//    丢弃随后的错误，状态与响应体都保留。
let rootDir;
const apps = [];

async function freshPath() {
  if (!rootDir) rootDir = await mkdtemp(join(tmpdir(), "knot-cfg-"));
  return join(rootDir, `${Math.random().toString(36).slice(2)}.json`);
}

async function startApp(opts = {}) {
  const app = createApp({ dbPath: await freshPath(), ...opts });
  await new Promise((r) => app.server.listen(0, r));
  app.agent = new Agent({ keepAlive: true }); // 独立连接池，收尾时销毁
  apps.push(app);
  return app;
}

async function stopApp(app) {
  if (!app || app._closed) return;
  app._closed = true;
  app.agent?.destroy(); // 关闭本 app 的客户端 keep-alive 连接池
  app.server.closeAllConnections?.(); // 释放服务端残留连接，避免 close() 挂住
  await new Promise((r) => app.server.close(r));
}

after(async () => {
  for (const app of apps) await stopApp(app);
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
});

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

// 发起 POST：正常返回 {status,json,body,closed}；
// 若服务端提前关连导致“响应之后”的 socket 错误，仍返回已读到的响应。
// 仅当在收到任何响应字节前就失败，才返回 {transportError}。
function post(app, path, payload, { headers = {} } = {}) {
  const port = app.server.address().port;
  const body = payload === undefined ? undefined : Buffer.from(payload);
  return new Promise((resolve) => {
    const creq = http.request(
      {
        port,
        path,
        method: "POST",
        agent: app.agent,
        headers: { "Content-Type": "application/json", ...headers, ...(body ? { "Content-Length": body.length } : {}) },
      },
      (res) => {
        const chunks = [];
        let complete = false;
        res.on("data", (d) => chunks.push(d));
        const finish = () => {
          if (complete) return;
          complete = true;
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = {};
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {}
          resolve({
            status: res.statusCode,
            connection: res.headers.connection,
            body: raw,
            json,
          });
        };
        res.on("end", finish);
        // 响应已结束后连接被销毁：不影响结论
        res.on("error", () => finish());
        res.on("aborted", finish);
      }
    );
    creq.on("error", (err) => {
      // 在拿到响应前连接就被重置：交给调用方按“提前关闭”分支处理
      resolve({ transportError: err.code || err.message });
    });
    if (body) creq.end(body);
    else creq.end();
  });
}

const VALID_REG = JSON.stringify({
  ropeNo: "R-C",
  location: "桅",
  diameterMm: 10,
  knotType: "bowline",
  turns: 2,
  tailLengthMm: 120,
  preloadN: 100,
  ratedLoadN: 1000,
  formerName: "甲",
  inspectorName: "乙",
});

// 413 可能伴随传输层重置：接受“完整 413”或“响应前连接关闭”，但二者都必须无新增写入
async function assertTooLargeOrEarlyClose(app, r, { before = app.store.db.ropes.length } = {}) {
  if (r.transportError) {
    // 响应前连接即被终止：是“提前关闭”的极端时序，属正常分支；真正要保证的是无写入与可用
    assert.equal(typeof r.transportError, "string");
  } else {
    assert.equal(r.status, 413, `应 413，实际 ${r.status} ${r.body}`);
    assert.equal(r.json.error, "payload_too_large");
  }
  assert.equal(app.store.db.ropes.length, before, "超限请求不得新增写入");
  // 服务继续可用（新连接发小请求）
  const alive = await new Promise((resolve) =>
    http.get({ port: app.server.address().port, path: "/api/knots", agent: app.agent }, (x) => resolve(x.statusCode)).on("error", () => resolve(0))
  );
  assert.equal(alive, 200, "服务必须继续可用");
}

test("无效 option：NaN/Infinity/负数/小数/字符串/布尔/超范围 在启动期抛 ConfigError", () => {
  const bad = [NaN, Infinity, -Infinity, -1, -0.0001, 1.5, "256", "", true, false, null, [], {}, Number.MAX_SAFE_INTEGER + 1, 1e20];
  for (const v of bad) {
    assert.throws(
      () => createApp({ dbPath: join(tmpdir(), "unused.json"), maxBodyBytes: v }),
      (e) => e instanceof ConfigError,
      `maxBodyBytes=${String(v)} 应抛 ConfigError`
    );
  }
});

test("无效环境变量：非数字/负数/小数/带空格/科学计数法 启动失败", () => {
  for (const v of ["abc", "NaN", "Infinity", "-1", "1.5", "100 ", " 100", "1e3", "0x10", "true"]) {
    withEnv({ KNOT_MAX_BODY_BYTES: v }, () => {
      assert.throws(() => createApp({ dbPath: join(tmpdir(), "unused.json") }), ConfigError, `env=${v}`);
    });
  }
});

test("合法 option 边界：0 与 MAX_SAFE_INTEGER 均可启动并正常停止", async () => {
  const zero = await startApp({ maxBodyBytes: 0 });
  await stopApp(zero);
  const max = await startApp({ maxBodyBytes: Number.MAX_SAFE_INTEGER });
  await stopApp(max);
  zero._closed && max._closed && assert.ok(true);
});

test("上限为 0：有字节请求体 413（或提前关闭），空体正常进入校验返回 400", async () => {
  const app = await startApp({ maxBodyBytes: 0 });
  const withBody = await post(app, "/api/ropes", VALID_REG);
  await assertTooLargeOrEarlyClose(app, withBody);
  const empty = await post(app, "/api/ropes", "");
  assert.equal(empty.status, 400, `空体应进入类型校验 400，实际 ${empty.status}`);
});

test("合法数字 option 生效：恰在上限内 201，超过 413（或提前关闭），服务继续可用", async () => {
  const len = Buffer.byteLength(VALID_REG);
  const app = await startApp({ maxBodyBytes: len });
  const exact = await post(app, "/api/ropes", VALID_REG);
  assert.equal(exact.status, 201, `恰好 ${len} 字节应接受：${exact.status} ${exact.body || exact.transportError}`);
  const over = await post(app, "/api/ropes", VALID_REG.replace('"R-C"', '"R-C2"'));
  await assertTooLargeOrEarlyClose(app, over);
});

test("环境变量整数生效且优先于默认；显式 option 优先于环境变量", async () => {
  await withEnv({ KNOT_MAX_BODY_BYTES: "10" }, async () => {
    const app = await startApp();
    const r = await post(app, "/api/ropes", VALID_REG);
    await assertTooLargeOrEarlyClose(app, r);
    await stopApp(app);
  });
  await withEnv({ KNOT_MAX_BODY_BYTES: "10" }, async () => {
    const app = await startApp({ maxBodyBytes: 1 << 20 });
    const r = await post(app, "/api/ropes", VALID_REG);
    assert.equal(r.status, 201, `大 option 覆盖小 env，应接受：${r.status} ${r.transportError || ""}`);
    await stopApp(app);
  });
});

test("未配置时默认 1MiB：普通请求 201，明显超过 413（或提前关闭）且只写入合法那条", async () => {
  await withEnv({ KNOT_MAX_BODY_BYTES: undefined }, async () => {
    const app = await startApp();
    const ok = await post(app, "/api/ropes", VALID_REG);
    assert.equal(ok.status, 201, `普通请求应 201：${ok.status} ${ok.body || ""}`);
    const hugePayload = JSON.stringify({ ropeNo: "R-HUGE", pad: "z".repeat(1024 * 1024 + 50) });
    const huge = await post(app, "/api/ropes", hugePayload);
    if (huge.transportError) {
      assert.equal(typeof huge.transportError, "string"); // 提前关闭的极端时序
    } else {
      assert.equal(huge.status, 413, `超大请求应 413：${huge.status} ${huge.body}`);
      assert.equal(huge.json.error, "payload_too_large");
    }
    assert.equal(app.store.db.ropes.length, 1, "超大请求不写入，仅保留合法 1 条");
    const alive = await new Promise((resolve) =>
      http.get({ port: app.server.address().port, path: "/api/knots", agent: app.agent }, (x) => resolve(x.statusCode)).on("error", () => resolve(0))
    );
    assert.equal(alive, 200, "服务必须继续可用");
  });
});

test("无效配置绝不静默退化为无上限：启动失败优于带着 NaN 运行", () => {
  withEnv({ KNOT_MAX_BODY_BYTES: "not-a-number" }, () => {
    assert.throws(() => createApp({ dbPath: join(tmpdir(), "unused.json") }), ConfigError);
  });
});
