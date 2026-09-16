// 绳结成型与滑移验收 —— HTTP 应用（零依赖，Node 内置 http）
import http from "node:http";
import { JsonStore } from "./store.js";
import { KNOTS, LIMITS, MIN_CYCLES, evaluateRope, validateRegistration } from "./knots.js";
import { renderPage } from "./page.js";

class HttpError extends Error {
  constructor(status, body) {
    super(body.error || "error");
    this.status = status;
    this.body = body;
  }
}

let seqCounter = 0;
function newRopeId() {
  seqCounter += 1;
  return `R-${Date.now().toString(36)}-${seqCounter.toString(36)}`;
}

export function createApp(options = {}) {
  const dbPath =
    options.dbPath ||
    new URL("../data/knot-acceptance.json", import.meta.url).pathname;
  const store = new JsonStore(dbPath);
  const ready = store.load();

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, { error: "bad_json" });
    }
  }

  function send(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data, null, 2));
  }

  function findRope(db, id) {
    return db.ropes.find((r) => r.id === id || r.ropeNo === id) || null;
  }

  // 为一根绳索附加判定预览（已确认的返回不可变确认结果）
  function decorate(rope) {
    if (rope.confirmation) {
      return { ...rope, verdict: rope.confirmation.verdict, evaluation: rope.confirmation, danger: rope.confirmation.verdict === "reject" };
    }
    const evaluation = evaluateRope(rope);
    return { ...rope, verdict: evaluation.verdict, evaluation, danger: evaluation.verdict === "reject" };
  }

  function registerRope(input) {
    const errors = validateRegistration(input);
    if (errors.length) throw new HttpError(400, { error: "invalid_registration", details: errors });
    const ropeNo = String(input.ropeNo || "").trim();
    if (!ropeNo) throw new HttpError(400, { error: "invalid_registration", details: ["缺少索号"] });
    if (store.db.ropes.some((r) => r.ropeNo === ropeNo)) {
      throw new HttpError(409, { error: "duplicate_rope_no", ropeNo });
    }
    const rope = {
      id: newRopeId(),
      ropeNo,
      location: String(input.location).trim(),
      diameterMm: Number(input.diameterMm),
      knotType: input.knotType,
      turns: Number(input.turns),
      tailLengthMm: Number(input.tailLengthMm),
      preloadN: Number(input.preloadN),
      ratedLoadN: Number(input.ratedLoadN),
      formerName: String(input.formerName).trim(),
      inspectorName: String(input.inspectorName).trim(),
      note: String(input.note || "").trim(),
      createdAt: new Date().toISOString(),
      cycles: [],
      confirmation: null,
    };
    store.db.ropes.unshift(rope);
    return rope;
  }

  function appendCycle(rope, input) {
    if (rope.confirmation) throw new HttpError(409, { error: "rope_locked", message: "已确认绳索不可再录入循环" });
    const expected = rope.cycles.length + 1;
    if (Number(input.expectedSeq) !== expected) {
      throw new HttpError(409, { error: "seq_mismatch", expected, received: Number(input.expectedSeq) });
    }
    const loadN = Number(input.loadN);
    const slip = Number(input.tailSlipMm);
    if (!Number.isFinite(loadN) || loadN <= 0) throw new HttpError(400, { error: "invalid_cycle", details: ["载荷必须为正数"] });
    if (!Number.isFinite(slip) || slip < 0) throw new HttpError(400, { error: "invalid_cycle", details: ["累计滑移不可为负"] });
    const prevTotal = rope.cycles.length ? rope.cycles[rope.cycles.length - 1].tailSlipMm : 0;
    if (slip + 1e-9 < prevTotal) {
      throw new HttpError(400, { error: "invalid_cycle", details: ["累计滑移必须单调不减，禁止覆盖旧读数"] });
    }
    const cycle = { seq: expected, loadN, tailSlipMm: slip, at: new Date().toISOString() };
    rope.cycles.push(cycle);
    return cycle;
  }

  function confirmRope(rope, inspectorName) {
    if (rope.confirmation) {
      throw new HttpError(409, { error: "already_confirmed", confirmation: rope.confirmation });
    }
    if (!inspectorName || String(inspectorName).trim() !== rope.inspectorName) {
      throw new HttpError(403, { error: "inspector_mismatch", expectedInspector: rope.inspectorName });
    }
    const evaluation = evaluateRope(rope);
    rope.confirmation = {
      at: new Date().toISOString(),
      inspectorName: rope.inspectorName,
      formerName: rope.formerName,
      verdict: evaluation.verdict,
      verdictLabel: evaluation.verdictLabel,
      metrics: evaluation.metrics,
      reasons: evaluation.reasons,
    };
    return rope.confirmation;
  }

  const server = http.createServer(async (req, res) => {
    try {
      await ready;
      const url = new URL(req.url, `http://${req.headers.host}`);
      const p = url.pathname;

      if (req.method === "GET" && p === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(renderPage());
      }

      if (req.method === "GET" && p === "/api/knots") {
        return send(res, 200, { knots: KNOTS, limits: LIMITS, minCycles: MIN_CYCLES });
      }

      if (req.method === "GET" && p === "/api/ropes") {
        return send(res, 200, store.db.ropes.map(decorate));
      }

      // 登记
      if (req.method === "POST" && p === "/api/ropes") {
        const input = await readBody(req);
        const result = await store.withLock("register", async () => {
          const rope = registerRope(input);
          try {
            await store.persist();
          } catch (e) {
            store.db.ropes = store.db.ropes.filter((r) => r.id !== rope.id); // 回滚
            throw e;
          }
          return rope;
        });
        return send(res, 201, decorate(result));
      }

      const cycleMatch = p.match(/^\/api\/ropes\/([^/]+)\/cycles$/);
      if (cycleMatch && req.method === "POST") {
        const id = decodeURIComponent(cycleMatch[1]);
        const input = await readBody(req);
        const result = await store.withLock(`rope:${id}`, async () => {
          const rope = findRope(store.db, id);
          if (!rope) throw new HttpError(404, { error: "rope_not_found" });
          const cycle = appendCycle(rope, input);
          try {
            await store.persist();
          } catch (e) {
            rope.cycles.pop(); // 回滚，内存与磁盘都不留半条
            throw e;
          }
          return { rope, cycle };
        });
        return send(res, 201, { cycle: result.cycle, rope: decorate(result.rope) });
      }

      const confirmMatch = p.match(/^\/api\/ropes\/([^/]+)\/confirm$/);
      if (confirmMatch && req.method === "POST") {
        const id = decodeURIComponent(confirmMatch[1]);
        const input = await readBody(req);
        const result = await store.withLock(`rope:${id}`, async () => {
          const rope = findRope(store.db, id);
          if (!rope) throw new HttpError(404, { error: "rope_not_found" });
          const confirmation = confirmRope(rope, input.inspectorName);
          try {
            await store.persist();
          } catch (e) {
            rope.confirmation = null; // 回滚
            throw e;
          }
          return { rope, confirmation };
        });
        res.setHeader("X-Verdict", result.confirmation.verdict);
        return send(res, 201, { confirmation: result.confirmation, rope: decorate(result.rope) });
      }

      // 批量确认：全部成功或整体失败，绝不留半批
      if (req.method === "POST" && p === "/api/ropes/batch-confirm") {
        const input = await readBody(req);
        const ids = Array.isArray(input.ids) ? input.ids : [];
        if (!ids.length) throw new HttpError(400, { error: "empty_batch" });
        const out = await store.withLocks(ids.map((id) => `rope:${id}`), async () => {
          const targets = [];
          const problems = [];
          for (const id of ids) {
            const rope = findRope(store.db, id);
            if (!rope) {
              problems.push({ id, error: "rope_not_found", status: 404 });
            } else if (rope.confirmation) {
              problems.push({ id, error: "already_confirmed", status: 409 });
            } else if (!input.inspectorName || String(input.inspectorName).trim() !== rope.inspectorName) {
              problems.push({ id, error: "inspector_mismatch", status: 403 });
            } else {
              targets.push(rope);
            }
          }
          if (problems.length) throw new HttpError(409, { error: "batch_aborted", rolledBack: true, problems });
          const snapshot = targets.map((r) => [r, r.confirmation]);
          const confirmations = targets.map((r) => confirmRope(r, input.inspectorName));
          try {
            await store.persist();
          } catch (e) {
            for (const [r, old] of snapshot) r.confirmation = old; // 整批回滚
            throw e;
          }
          return confirmations;
        });
        return send(res, 201, { confirmed: out.length, confirmations: out });
      }

      const oneMatch = p.match(/^\/api\/ropes\/([^/]+)$/);
      if (oneMatch && req.method === "GET") {
        const rope = findRope(store.db, decodeURIComponent(oneMatch[1]));
        if (!rope) return send(res, 404, { error: "rope_not_found" });
        return send(res, 200, decorate(rope));
      }

      // 故障注入（仅测试环境开启）
      if (req.method === "POST" && p === "/api/test/fail-next-writes") {
        if (process.env.ENABLE_FAULTS !== "1") return send(res, 403, { error: "faults_disabled" });
        const input = await readBody(req);
        store.failNextWrites = Number(input.count) || 1;
        return send(res, 200, { failNextWrites: store.failNextWrites });
      }

      return send(res, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, error.body);
      // eslint-disable-next-line no-console
      console.error(error);
      return send(res, 500, { error: "internal_error", message: error.message });
    }
  });

  return { server, store, dbDir: new URL("../data/", import.meta.url).pathname };
}
