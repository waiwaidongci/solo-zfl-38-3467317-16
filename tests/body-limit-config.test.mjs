import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Agent } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, ConfigError } from "../lib/app.js";

// —— 严格发送与收尾（Node 20/22 通用）——
// postStrict：客户端必须收到完整状态行与响应体；任何在响应读完之前发生的传输
// 错误都让用例失败，绝不把“没收到响应”当作提前关闭放行。发送体时一旦响应开始
// 到达就停止发送（服务端会停止读取并在极短窗口后关连），避免无谓的写错误掩盖响应。
// 每个 app 用独立 Agent，收尾 destroy agent + closeAllConnections + close，自然退出。
let rootDir;
const apps = [];

async function freshPath() {
  if (!rootDir) rootDir = await mkdtemp(join(tmpdir(), "knot-cfg-"));
  return join(rootDir, `${Math.random().toString(36).slice(2)}.json`);
}

async function startApp(opts = {}) {
  const app = createApp({ dbPath: await freshPath(), ...opts });
  await new Promise((r) => app.server.listen(0, r));
  app.agent = new Agent({ keepAlive: true });
  apps.push(app);
  return app;
}

async function stopApp(app) {
  if (!app || app._closed) return;
  app._closed = true;
  app.agent?.destroy();
  app.server.closeAllConnections?.();
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

// 严格 POST：要么拿到完整响应，要么明确失败（reject）。
function postStrict(app, path, payload) {
  const port = app.server.address().port;
  const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(payload);
  return new Promise((resolve, reject) => {
    let responseSeen = false;
    let responseEnded = false;
    const creq = http.request(
      {
        port,
        path,
        method: "POST",
        agent: app.agent,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
      },
      (res) => {
        responseSeen = true;
        const chunks = [];
        let settled = false;
        const fail = (why) => {
          if (settled || responseEnded) return;
          settled = true;
          reject(new Error(`未读到完整响应即连接中断：${why}（已收 ${Buffer.concat(chunks).length} 字节，状态 ${res.statusCode ?? "?"}）`));
        };
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          responseEnded = true;
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = {};
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {
            return reject(new Error(`响应体不是合法 JSON：${raw.slice(0, 120)}`));
          }
          resolve({ status: res.statusCode, connection: res.headers.connection, body: raw, json });
        });
        // 响应体未读完就出错/中断：必须失败，不能放行
        res.on("error", (e) => fail(e.code || e.message));
        res.on("aborted", () => fail("response aborted"));
      }
    );
    // 请求侧错误：只有在尚未收到完整响应时才判失败；响应结束后的写错误（攻击端
    // 未发完的 body 触发 EPIPE/RST）不影响“客户端已读完 413”这一事实。
    creq.on("error", (e) => {
      if (!responseEnded) reject(new Error(`请求在收到完整响应前失败：${e.code || e.message}`));
    });

    if (body.length === 0) {
      creq.end();
      return;
    }
    // 分块发送：服务端一开始回响应就停止灌入剩余数据，专注读完响应，
    // 避免无谓写错误掩盖响应；但通过条件始终是“读完完整响应”。
    let offset = 0;
    const CHUNK = 4096;
    const pump = () => {
      if (creq.destroyed || creq.writableEnded || responseSeen) return;
      const start = offset;
      offset += CHUNK;
      if (offset >= body.length) {
        creq.end(body.subarray(start));
        return;
      }
      const ok = creq.write(body.subarray(start, offset));
      if (!ok) creq.once("drain", pump);
      else setImmediate(pump);
    };
    pump();
  });
}

async function getStatus(app, path) {
  return new Promise((resolve, reject) => {
    http.get({ port: app.server.address().port, path, agent: app.agent }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
      res.on("error", reject);
    }).on("error", reject);
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

// 严格断言：必须是完整 413 + 稳定错误体；然后零新增写入、服务可用
async function assertStrict413(app, r) {
  assert.equal(r.status, 413, `应收到完整 413，实际 ${r.status} ${r.body}`);
  assert.equal(r.connection, "close");
  assert.equal(r.json.error, "payload_too_large");
  assert.equal(typeof r.json.limitBytes, "number");
  assert.ok(r.body.includes("请求体超过"));
  assert.equal(app.store.db.ropes.length, app._beforeCount ?? app.store.db.ropes.length, "超限请求不得新增写入");
  assert.equal(await getStatus(app, "/api/knots"), 200, "服务必须继续可用");
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
  assert.ok(zero._closed && max._closed);
});

test("上限为 0：有字节请求体必须返回完整 413；空体正常进入校验返回 400", async () => {
  const app = await startApp({ maxBodyBytes: 0 });
  app._beforeCount = 0;
  const withBody = await postStrict(app, "/api/ropes", VALID_REG);
  await assertStrict413(app, withBody);
  const empty = await postStrict(app, "/api/ropes", "");
  assert.equal(empty.status, 400, `空体应进入类型校验 400，实际 ${empty.status}`);
});

test("合法数字 option：恰在上限内 201，超过必须返回完整 413，服务继续可用", async () => {
  const len = Buffer.byteLength(VALID_REG);
  const app = await startApp({ maxBodyBytes: len });
  const exact = await postStrict(app, "/api/ropes", VALID_REG);
  assert.equal(exact.status, 201, `恰好 ${len} 字节应接受：${exact.status} ${exact.body}`);
  app._beforeCount = 1; // 上面合法登记已写入一条
  const overBody = VALID_REG.replace('"R-C"', '"R-C2"');
  const over = await postStrict(app, "/api/ropes", overBody);
  await assertStrict413(app, over);
});

test("环境变量整数生效：超限必须完整 413；显式 option 覆盖环境变量后接受", async () => {
  await withEnv({ KNOT_MAX_BODY_BYTES: "10" }, async () => {
    const app = await startApp();
    app._beforeCount = 0;
    const r = await postStrict(app, "/api/ropes", VALID_REG);
    await assertStrict413(app, r);
    await stopApp(app);
  });
  await withEnv({ KNOT_MAX_BODY_BYTES: "10" }, async () => {
    const app = await startApp({ maxBodyBytes: 1 << 20 });
    const r = await postStrict(app, "/api/ropes", VALID_REG);
    assert.equal(r.status, 201, `大 option 覆盖小 env，应接受：${r.status} ${r.body}`);
    await stopApp(app);
  });
});

test("未配置时默认 1MiB：普通请求 201；超大请求必须完整 413，只写入合法那条", async () => {
  await withEnv({ KNOT_MAX_BODY_BYTES: undefined }, async () => {
    const app = await startApp();
    const ok = await postStrict(app, "/api/ropes", VALID_REG);
    assert.equal(ok.status, 201, `普通请求应 201：${ok.status} ${ok.body}`);
    app._beforeCount = 1;
    const huge = await postStrict(app, "/api/ropes", JSON.stringify({ ropeNo: "R-HUGE", pad: "z".repeat(1024 * 1024 + 50) }));
    await assertStrict413(app, huge);
    assert.equal(app.store.db.ropes.length, 1, "超大请求不写入，仅保留合法 1 条");
  });
});

test("无效配置绝不静默退化为无上限：启动失败优于带着 NaN 运行", () => {
  withEnv({ KNOT_MAX_BODY_BYTES: "not-a-number" }, () => {
    assert.throws(() => createApp({ dbPath: join(tmpdir(), "unused.json") }), ConfigError);
  });
});
