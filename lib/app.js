// 绳结成型与滑移验收 —— HTTP 应用（零依赖，Node 内置 http）
import http from "node:http";
import { JsonStore, PersistError } from "./store.js";
import { KNOTS, LIMITS, MIN_CYCLES, evaluateRope, validateRegistration, REGISTRATION_FIELDS } from "./knots.js";
import {
  isObject,
  isNonEmptyString,
  isPositiveNumber,
  isNonNegativeNumber,
  isPositiveInteger,
  unknownFields,
} from "./validation.js";
import { renderPage } from "./page.js";

class HttpError extends Error {
  constructor(status, body, opts = {}) {
    super(body.error || "error");
    this.status = status;
    this.body = body;
    // 请求体超限时置位：413 发出后立即结束连接，不再读取上游（停滞/无限流也不会占连接）
    this.closeConnection = !!opts.closeConnection;
  }
}

let seqCounter = 0;
function makeRopeId() {
  seqCounter += 1;
  return `R-${Date.now().toString(36)}-${seqCounter.toString(36)}`;
}

export function createApp(options = {}) {
  const dbPath =
    options.dbPath ||
    new URL("../data/knot-acceptance.json", import.meta.url).pathname;
  const store = new JsonStore(dbPath);
  const ready = store.load();

  // 请求体大小上限（字节）：默认 1MiB，可经选项或环境变量覆盖（测试用小值）
  const maxBodyBytes =
    options.maxBodyBytes ??
    (process.env.KNOT_MAX_BODY_BYTES ? Number(process.env.KNOT_MAX_BODY_BYTES) : 1024 * 1024);

  // 有上限地读取请求体：一旦超过上限立即停止接收（不再排空上游），在任何 JSON
  // 解析之前返回稳定 413；响应发出后关闭连接，停滞或无限的上游不会长期占用连接。
  async function readBody(req) {
    const tooLarge = () =>
      new HttpError(
        413,
        { error: "payload_too_large", message: `请求体超过 ${maxBodyBytes} 字节上限`, limitBytes: maxBodyBytes },
        { closeConnection: true }
      );
    // 声明长度已知且超限：完全不读请求体，立即判定（停滞客户端也无法拖住响应）
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      throw tooLarge();
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBodyBytes) {
        // 立即停止接收上游（不排空、不等待），但不销毁 socket——
        // 先让 413 响应发出并 flush，再由 send() 关闭连接。
        req.pause();
        throw tooLarge();
      }
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, { error: "bad_json" });
    }
  }

  // 安全解码路径段：非法百分号编码（如 %ff、%E0%A4%A）统一返回明确 400，而非 500 URIError
  function decodeParam(segment, field) {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new HttpError(400, { error: "malformed_path", field });
    }
  }

  function send(res, status, data, closeConnection = false) {
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (closeConnection) headers.Connection = "close";
    res.writeHead(status, headers);
    res.end(JSON.stringify(data, null, 2));
    if (closeConnection) {
      const sock = res.socket;
      if (!sock) return;
      // 响应 flush 到内核后再销毁，客户端能读到完整 413；硬超时兜底，确保连接必被释放
      const hard = setTimeout(() => sock.destroyed || sock.destroy(), 2000);
      hard.unref?.();
      res.once("finish", () => {
        clearTimeout(hard);
        sock.destroyed || sock.destroy();
      });
    }
  }

  // 写接口与按内部编号读取：只按内部编号 id 精确匹配，绝不回退到索号，
  // 避免“索号恰好等于另一根索内部编号”时写错对象。
  function findById(db, id) {
    return db.ropes.find((r) => r.id === id) || null;
  }
  // 仅供明确的“按索号查询”端点使用
  function findByRopeNo(db, ropeNo) {
    return db.ropes.find((r) => r.ropeNo === ropeNo) || null;
  }
  // 生成不与任何现有内部编号、索号或本次新索号冲突的内部编号
  function allocateRopeId(extraRopeNo = null) {
    let id;
    do {
      id = makeRopeId();
    } while (id === extraRopeNo || store.db.ropes.some((r) => r.id === id || r.ropeNo === id));
    return id;
  }

  // 为一根绳索附加判定预览（已确认的返回不可变确认结果）
  function decorate(rope) {
    if (rope.confirmation) {
      return { ...rope, verdict: rope.confirmation.verdict, evaluation: rope.confirmation, danger: rope.confirmation.verdict === "reject" };
    }
    const evaluation = evaluateRope(rope);
    return { ...rope, verdict: evaluation.verdict, evaluation, danger: evaluation.verdict === "reject" };
  }

  // 写接口的请求体必须是 JSON 对象（null / 布尔 / 数组 / 字符串 / 数字都是客户端错误）
  function requireObject(input, code) {
    if (!isObject(input)) throw new HttpError(400, { error: code, details: ["请求体必须是 JSON 对象"] });
  }

  function validateCycleInput(input) {
    requireObject(input, "invalid_cycle");
    const errors = [];
    const extra = unknownFields(input, new Set(["expectedSeq", "loadN", "tailSlipMm"]));
    if (extra.length) errors.push(`存在不允许的字段：${extra.join("、")}`);
    if (input.expectedSeq === undefined || input.expectedSeq === null) errors.push("缺少字段：循环序号 expectedSeq");
    else if (!isPositiveInteger(input.expectedSeq)) errors.push("循环序号必须是正整数（不接受布尔、字符串或数组）");
    if (input.loadN === undefined || input.loadN === null) errors.push("缺少字段：载荷 loadN");
    else if (!isPositiveNumber(input.loadN)) errors.push("载荷必须是正数（不接受布尔、字符串或数组）");
    if (input.tailSlipMm === undefined || input.tailSlipMm === null) errors.push("缺少字段：尾端累计滑移 tailSlipMm");
    else if (!isNonNegativeNumber(input.tailSlipMm)) errors.push("尾端累计滑移必须是非负数字（不接受布尔、字符串或数组）");
    if (errors.length) throw new HttpError(400, { error: "invalid_cycle", details: errors });
    return { expectedSeq: input.expectedSeq, loadN: input.loadN, tailSlipMm: input.tailSlipMm };
  }

  function validateInspectorBody(input) {
    requireObject(input, "invalid_confirmation");
    const errors = [];
    const extra = unknownFields(input, new Set(["inspectorName"]));
    if (extra.length) errors.push(`存在不允许的字段：${extra.join("、")}`);
    if (input.inspectorName === undefined || input.inspectorName === null) errors.push("缺少字段：验收员签名 inspectorName");
    else if (!isNonEmptyString(input.inspectorName)) errors.push("验收员签名必须是非空字符串");
    if (errors.length) throw new HttpError(400, { error: "invalid_confirmation", details: errors });
    return input.inspectorName.trim();
  }

  function validateBatchBody(input) {
    requireObject(input, "invalid_batch");
    const errors = [];
    const extra = unknownFields(input, new Set(["ids", "inspectorName"]));
    if (extra.length) errors.push(`存在不允许的字段：${extra.join("、")}`);
    let ids;
    if (!Array.isArray(input.ids)) {
      errors.push("ids 必须是字符串数组");
      ids = [];
    } else {
      ids = input.ids;
      if (!ids.length) errors.push("批量确认至少包含一根索");
      ids.forEach((id, i) => {
        if (!isNonEmptyString(id)) errors.push(`ids[${i}] 必须是非空字符串`);
      });
      if (new Set(ids).size !== ids.length) errors.push("ids 中存在重复项");
    }
    if (input.inspectorName === undefined || input.inspectorName === null) errors.push("缺少字段：验收员签名 inspectorName");
    else if (!isNonEmptyString(input.inspectorName)) errors.push("验收员签名必须是非空字符串");
    if (errors.length) throw new HttpError(400, { error: "invalid_batch", details: errors });
    return { ids, inspectorName: input.inspectorName.trim() };
  }

  function registerRope(input) {
    requireObject(input, "invalid_registration");
    const errors = [];
    const extra = unknownFields(input, new Set(REGISTRATION_FIELDS));
    if (extra.length) errors.push(`存在不允许的字段：${extra.join("、")}`);
    errors.push(...validateRegistration(input));
    if (errors.length) throw new HttpError(400, { error: "invalid_registration", details: [...new Set(errors)] });
    const ropeNo = input.ropeNo.trim();
    if (store.db.ropes.some((r) => r.ropeNo === ropeNo)) {
      throw new HttpError(409, { error: "duplicate_rope_no", ropeNo });
    }
    // 自定义索号不得占用任何已有内部编号，否则按内部编号的写操作会定位到这根索
    if (store.db.ropes.some((r) => r.id === ropeNo)) {
      throw new HttpError(409, { error: "rope_no_matches_internal_id", ropeNo });
    }
    const rope = {
      id: allocateRopeId(ropeNo),
      ropeNo,
      location: input.location.trim(),
      diameterMm: input.diameterMm,
      knotType: input.knotType,
      turns: input.turns,
      tailLengthMm: input.tailLengthMm,
      preloadN: input.preloadN,
      ratedLoadN: input.ratedLoadN,
      formerName: input.formerName.trim(),
      inspectorName: input.inspectorName.trim(),
      note: typeof input.note === "string" ? input.note.trim() : "",
      createdAt: new Date().toISOString(),
      cycles: [],
      confirmation: null,
    };
    store.db.ropes.unshift(rope);
    return rope;
  }

  function appendCycle(rope, input) {
    if (rope.confirmation) throw new HttpError(409, { error: "rope_locked", message: "已确认绳索不可再录入循环" });
    // input 已由 validateCycleInput 严格校验：{ expectedSeq, loadN, tailSlipMm }
    const expected = rope.cycles.length + 1;
    if (input.expectedSeq !== expected) {
      throw new HttpError(409, { error: "seq_mismatch", expected, received: input.expectedSeq });
    }
    const prevTotal = rope.cycles.length ? rope.cycles[rope.cycles.length - 1].tailSlipMm : 0;
    if (input.tailSlipMm + 1e-9 < prevTotal) {
      throw new HttpError(400, { error: "invalid_cycle", details: ["累计滑移必须单调不减，禁止覆盖旧读数"] });
    }
    const cycle = { seq: expected, loadN: input.loadN, tailSlipMm: input.tailSlipMm, at: new Date().toISOString() };
    rope.cycles.push(cycle);
    return cycle;
  }

  function confirmRope(rope, inspectorName) {
    if (rope.confirmation) {
      throw new HttpError(409, { error: "already_confirmed", confirmation: rope.confirmation });
    }
    if (inspectorName !== rope.inspectorName) {
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

  // 写操作解析路径参数：只认内部编号；若传入的是某根索的索号，返回明确客户端错误。
  function resolveForWrite(id) {
    const rope = findById(store.db, id);
    if (rope) return rope;
    if (findByRopeNo(store.db, id)) {
      throw new HttpError(400, {
        error: "use_internal_id",
        message: "该值是索号而非内部编号，写操作必须使用内部编号",
        ropeNo: id,
      });
    }
    throw new HttpError(404, { error: "rope_not_found" });
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
        const id = decodeParam(cycleMatch[1], "id");
        const raw = await readBody(req);
        const input = validateCycleInput(raw); // 形状/类型校验先于加锁与一切变更
        const result = await store.withLock(`rope:${id}`, async () => {
          const rope = resolveForWrite(id);
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
        const id = decodeParam(confirmMatch[1], "id");
        const raw = await readBody(req);
        const inspectorName = validateInspectorBody(raw); // 签名类型不对是客户端错误（400），先于 403 判定
        const result = await store.withLock(`rope:${id}`, async () => {
          const rope = resolveForWrite(id);
          const confirmation = confirmRope(rope, inspectorName);
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
        const raw = await readBody(req);
        const { ids, inspectorName } = validateBatchBody(raw); // 形状/类型先校验
        // 编号预校验（加锁前）：ids 必须全部是内部编号，绝不用索号匹配
        const idProblems = ids.map((id) => {
          if (findById(store.db, id)) return null;
          if (findByRopeNo(store.db, id)) return { id, error: "use_internal_id", status: 400 };
          return { id, error: "rope_not_found", status: 404 };
        }).filter(Boolean);
        if (idProblems.length) {
          throw new HttpError(400, { error: "invalid_batch_ids", details: ["批量 ids 必须是内部编号"], problems: idProblems });
        }
        const out = await store.withLocks(ids.map((id) => `rope:${id}`), async () => {
          const targets = [];
          const problems = [];
          for (const id of ids) {
            const rope = findById(store.db, id);
            if (rope.confirmation) {
              problems.push({ id, error: "already_confirmed", status: 409 });
            } else if (inspectorName !== rope.inspectorName) {
              problems.push({ id, error: "inspector_mismatch", status: 403 });
            } else {
              targets.push(rope);
            }
          }
          if (problems.length) throw new HttpError(409, { error: "batch_aborted", rolledBack: true, problems });
          const snapshot = targets.map((r) => [r, r.confirmation]);
          const confirmations = targets.map((r) => confirmRope(r, inspectorName));
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

      // 明确的按索号查询
      const byNoMatch = p.match(/^\/api\/ropes\/by-rope-no\/([^/]+)$/);
      if (byNoMatch && req.method === "GET") {
        const ropeNo = decodeParam(byNoMatch[1], "ropeNo");
        const rope = findByRopeNo(store.db, ropeNo);
        if (!rope) return send(res, 404, { error: "rope_no_not_found" });
        return send(res, 200, decorate(rope));
      }

      // 按内部编号精确读取（不回退索号）
      const oneMatch = p.match(/^\/api\/ropes\/([^/]+)$/);
      if (oneMatch && req.method === "GET") {
        const key = decodeParam(oneMatch[1], "id");
        const rope = findById(store.db, key);
        if (rope) return send(res, 200, decorate(rope));
        if (findByRopeNo(store.db, key)) {
          return send(res, 400, { error: "use_internal_id", message: "请使用 /api/ropes/by-rope-no/ 按索号查询" });
        }
        return send(res, 404, { error: "rope_not_found" });
      }

      // 故障注入（仅测试环境开启）
      if (req.method === "POST" && p === "/api/test/fail-next-writes") {
        if (process.env.ENABLE_FAULTS !== "1") return send(res, 403, { error: "faults_disabled" });
        const input = await readBody(req);
        if (!isObject(input) || (input.count !== undefined && !isPositiveInteger(input.count))) {
          return send(res, 400, { error: "invalid_body", details: ["count 必须是正整数"] });
        }
        store.failNextWrites = isPositiveInteger(input.count) ? input.count : 1;
        return send(res, 200, { failNextWrites: store.failNextWrites });
      }

      return send(res, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, error.body, error.closeConnection);
      if (error instanceof PersistError) {
        // 稳定错误码 + 简短说明：绝不回传绝对路径或系统错误细节（仅服务端记录）
        console.error("persist_failed", error.code);
        return send(res, 500, {
          error: "persist_failed",
          reason: error.code,
          message: "数据持久化失败，本次写入已回滚，请重试",
        });
      }
      // 其他未预期错误：只回稳定错误码，细节写服务端日志，不向客户端泄露
      console.error(error);
      return send(res, 500, { error: "internal_error" });
    }
  });

  return { server, store, dbDir: new URL("../data/", import.meta.url).pathname };
}
