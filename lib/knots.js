// 绳结成型与滑移验收 —— 领域规则（纯函数，无副作用，便于单元测试）
import { isObject, isNonEmptyString } from "./validation.js";
//
// 判定分三档：
//   safe    安全通过
//   rework  返工：尾长偏短 / 绕圈不足 / 滑移偏大（尚可重制后复检）
//   reject  拒绝：滑移未稳定 / 载荷余量不足 / 数据无效
// 任一指标达到 reject 即整体拒绝；否则任一指标达到 rework 即返工；全部合格才安全。

export const MIN_CYCLES = 5; // 至少五次加载循环

// 结型库：efficiency 结型效率（成型后绳结处保留的断裂强度比例）
// minTailD  最小尾长（以绳径 d 的倍数表示）
// minTurns  该结型要求的最少绕圈数
export const KNOTS = {
  bowline: { key: "bowline", name: "布林结（称人结）", efficiency: 0.7, minTailD: 8, minTurns: 1 },
  "figure-eight-follow-through": {
    key: "figure-eight-follow-through",
    name: "八字返穿结",
    efficiency: 0.75,
    minTailD: 10,
    minTurns: 1,
  },
  "double-fishermans": {
    key: "double-fishermans",
    name: "双渔人结",
    efficiency: 0.65,
    minTailD: 6,
    minTurns: 2,
  },
  "anchor-bend": { key: "anchor-bend", name: "锚结", efficiency: 0.6, minTailD: 8, minTurns: 2 },
  "round-turn-two-half-hitches": {
    key: "round-turn-two-half-hitches",
    name: "圆旋加双半结",
    efficiency: 0.65,
    minTailD: 8,
    minTurns: 3,
  },
};

export const VERDICTS = {
  safe: { key: "safe", label: "安全通过", tone: "safe" },
  rework: { key: "rework", label: "返工", tone: "warn" },
  reject: { key: "reject", label: "拒绝", tone: "danger" },
};

// 判定阈值
export const LIMITS = {
  minCycles: MIN_CYCLES,
  tailReworkD: 1.0, // 尾长低于 minTailD 且差距 <=1d：返工
  totalSlipD: 1.0, // 全程累计滑移上限：1 倍绳径
  lastIncrementD: 0.15, // 末次滑移增量上限：0.15d
  finalStretchD: 0.3, // 后三循环滑移增量单调条件放宽：最多允许 1 次回弹（放宽幅度）0.3d
  marginSafe: 1.5, // 安全余量：结承载 / 试验最大载荷 >= 1.5
  marginRework: 1.25, // 1.25~1.5 返工，<1.25 拒绝
};

export function knot(key) {
  return KNOTS[key] || null;
}

// 最小尾长（mm）：取结型规定倍数，并设 50mm 绝对下限
export function minTailLengthMm(knotKey, diameterMm) {
  const def = knot(knotKey);
  if (!def) return null;
  return Math.round(Math.max(def.minTailD * diameterMm, 50) * 10) / 10;
}

// 最大允许滑移（mm）：1 倍绳径
export function maxAllowedSlipMm(diameterMm) {
  return Math.round(diameterMm * LIMITS.totalSlipD * 100) / 100;
}

// 登记接口允许的全部字段（其他字段一律拒绝，防止意外写入）
export const REGISTRATION_FIELDS = [
  "ropeNo", "location", "diameterMm", "knotType", "turns", "tailLengthMm",
  "preloadN", "ratedLoadN", "formerName", "inspectorName", "note",
];

// 登记数据严格校验：字段必须是正确的 JSON 类型，
// 缺失 / null / 布尔 / 数组 / 对象 / 非有限数 / 空字符串都明确报错。返回错误数组。
// 注意：只校验已知字段的值，不拒绝额外字段——HTTP 层另做未知字段约束，
// 以便本函数也能校验含 id/cycles 等内部字段的已登记绳索。
export function validateRegistration(input) {
  const errors = [];
  if (!isObject(input)) {
    errors.push("请求体必须是 JSON 对象");
    return errors;
  }

  const strField = (v, label) =>
    v === undefined || v === null ? `缺少字段：${label}`
      : !isNonEmptyString(v) ? `${label}必须是非空字符串` : null;
  const numField = (v, label, { integer = false } = {}) => {
    if (v === undefined || v === null) return `缺少字段：${label}`;
    if (typeof v !== "number" || !Number.isFinite(v)) return `${label}必须是数字（不接受布尔、字符串或数组）`;
    if (integer && !Number.isInteger(v)) return `${label}必须是整数`;
    if (v <= 0) return `${label}必须为正数`;
    return null;
  };

  for (const [v, label] of [
    [input.ropeNo, "索号"],
    [input.location, "使用部位"],
    [input.formerName, "成型员"],
    [input.inspectorName, "验收员"],
  ]) {
    const e = strField(v, label);
    if (e) errors.push(e);
  }
  for (const [v, label, integer] of [
    [input.diameterMm, "绳径（mm）", false],
    [input.turns, "绕圈数", true],
    [input.tailLengthMm, "尾长（mm）", false],
    [input.preloadN, "预紧力（N）", false],
    [input.ratedLoadN, "额定载荷（N）", false],
  ]) {
    const e = numField(v, label, { integer });
    if (e) errors.push(e);
  }
  if (input.knotType === undefined || input.knotType === null) {
    errors.push("缺少字段：结型");
  } else if (!isNonEmptyString(input.knotType) || !knot(input.knotType)) {
    errors.push(`未知或无效结型：${isNonEmptyString(input.knotType) ? input.knotType : "（必须是字符串）"}`);
  }
  if (input.note !== undefined && input.note !== null && typeof input.note !== "string") {
    errors.push("备注必须是字符串");
  }
  if (
    isNonEmptyString(input.formerName) &&
    isNonEmptyString(input.inspectorName) &&
    input.formerName.trim() === input.inspectorName.trim()
  ) {
    errors.push("成型员与验收员不可为同一人（职责分离）");
  }
  return errors;
}

// 滑移是否稳定：
// 1) 后三循环增量整体不增（允许最多一次回弹，且回弹幅度 <= finalStretchD*d）；
// 2) 末次增量 <= 0.15d；
// 3) 全程累计滑移 <= 1d。
export function analyzeSlip(cycles, diameterMm) {
  const totals = cycles.map((c) => Number(c.tailSlipMm));
  const increments = totals.map((t, i) => (i === 0 ? t : +(t - totals[i - 1]).toFixed(6)));
  const total = totals.length ? totals[totals.length - 1] : 0;
  const maxAllowed = maxAllowedSlipMm(diameterMm);
  const lastInc = increments.length ? increments[increments.length - 1] : 0;

  const tail3 = increments.slice(-3);
  let rebound = 0;
  for (let i = 1; i < tail3.length; i++) {
    if (tail3[i] > tail3[i - 1] + 1e-9) rebound = Math.max(rebound, tail3[i] - tail3[i - 1]);
  }
  const monotone = rebound <= LIMITS.finalStretchD * diameterMm + 1e-9;

  const stable =
    cycles.length >= MIN_CYCLES &&
    lastInc <= LIMITS.lastIncrementD * diameterMm + 1e-9 &&
    monotone;
  return { totals, increments, total, lastIncrement: lastInc, maxAllowed, stable, monotone, rebound };
}

// 综合判定。rope: 已登记绳索（含 cycles）。返回 verdict + 全部指标与原因列表。
export function evaluateRope(rope) {
  const reasons = [];
  const def = knot(rope.knotType);
  const d = Number(rope.diameterMm);

  // —— 登记类（reject：数据不合格不可进入验收）——
  const registrationErrors = validateRegistration(rope);
  for (const e of registrationErrors) reasons.push({ level: "reject", code: "invalid_data", message: e });

  if (!def || !(d > 0)) {
    return result(reasons, rope, null, null, null);
  }

  const minTail = minTailLengthMm(rope.knotType, d);
  const maxSlip = maxAllowedSlipMm(d);
  const tailRatio = Number(rope.tailLengthMm) / d;

  // —— 尾长 ——
  const tailGap = minTail - Number(rope.tailLengthMm);
  if (tailGap > 1e-9) {
    if (tailGap > LIMITS.tailReworkD * d + 1e-9) {
      reasons.push({
        level: "reject",
        code: "tail_too_short",
        message: `尾长 ${rope.tailLengthMm}mm 小于最小尾长 ${minTail}mm 超过 1d，结尾可能脱出`,
      });
    } else {
      reasons.push({
        level: "rework",
        code: "tail_short",
        message: `尾长 ${rope.tailLengthMm}mm 低于最小尾长 ${minTail}mm，应返工放足尾长`,
      });
    }
  }

  // —— 绕圈数 ——
  if (Number(rope.turns) < def.minTurns) {
    reasons.push({
      level: "rework",
      code: "turns_insufficient",
      message: `${def.name}要求至少 ${def.minTurns} 圈，实际 ${rope.turns} 圈`,
    });
  }

  const cycles = rope.cycles || [];

  // —— 循环次数 ——
  if (cycles.length < MIN_CYCLES) {
    reasons.push({
      level: "reject",
      code: "cycles_insufficient",
      message: `加载循环仅 ${cycles.length} 次，少于最少 ${MIN_CYCLES} 次`,
    });
  }

  // —— 滑移 ——
  const slip = analyzeSlip(cycles, d);
  if (slip.total > maxSlip + 1e-9) {
    reasons.push({
      level: "reject",
      code: "slip_exceeded",
      message: `累计滑移 ${slip.total}mm 超过最大允许滑移 ${maxSlip}mm（1d）`,
    });
  }
  if (cycles.length >= MIN_CYCLES) {
    if (!slip.monotone) {
      reasons.push({
        level: "reject",
        code: "slip_unstable",
        message: `后三循环滑移增量回弹 ${slip.rebound.toFixed(2)}mm，滑移未稳定`,
      });
    } else if (slip.lastIncrement > LIMITS.lastIncrementD * d + 1e-9) {
      reasons.push({
        level: "reject",
        code: "slip_unstable",
        message: `末次滑移增量 ${slip.lastIncrement.toFixed(2)}mm 超过 0.15d（${(0.15 * d).toFixed(2)}mm），滑移未稳定`,
      });
    }
  }

  // —— 载荷余量 ——
  const maxCycleLoad = cycles.reduce((m, c) => Math.max(m, Number(c.loadN)), 0);
  const capacity = Number(rope.ratedLoadN) * def.efficiency; // 结承载 = 额定载荷 × 结型效率
  const margin = maxCycleLoad > 0 ? capacity / maxCycleLoad : Infinity;
  if (maxCycleLoad > 0 && margin < LIMITS.marginRework - 1e-9) {
    reasons.push({
      level: "reject",
      code: "margin_insufficient",
      message: `载荷余量 ${margin.toFixed(2)} 低于 ${LIMITS.marginRework}：结承载 ${capacity}N / 最大试验载荷 ${maxCycleLoad}N`,
    });
  } else if (maxCycleLoad > 0 && margin < LIMITS.marginSafe - 1e-9) {
    reasons.push({
      level: "rework",
      code: "margin_low",
      message: `载荷余量 ${margin.toFixed(2)} 低于安全线 ${LIMITS.marginSafe}，应返工或降载使用`,
    });
  }

  return result(reasons, rope, { minTail, maxSlip, tailRatio }, slip, {
    capacity,
    maxCycleLoad,
    margin: margin === Infinity ? null : margin,
    efficiency: def.efficiency,
  });
}

function result(reasons, rope, tail, slip, load) {
  const levels = reasons.map((r) => r.level);
  const key = levels.includes("reject") ? "reject" : levels.includes("rework") ? "rework" : "safe";
  return {
    verdict: key,
    verdictLabel: VERDICTS[key].label,
    ropeId: rope.id,
    metrics: {
      knotName: knot(rope.knotType) ? knot(rope.knotType).name : rope.knotType,
      efficiency: knot(rope.knotType) ? knot(rope.knotType).efficiency : null,
      minTailLengthMm: tail ? tail.minTail : null,
      maxAllowedSlipMm: slip ? slip.maxAllowed : null,
      tailRatio: tail ? Number(tail.tailRatio.toFixed(2)) : null,
      totalSlipMm: slip ? slip.total : null,
      lastIncrementMm: slip ? slip.lastIncrement : null,
      slipStable: slip ? slip.stable : false,
      slipIncrements: slip ? slip.increments : [],
      capacityN: load ? load.capacity : null,
      maxCycleLoadN: load ? load.maxCycleLoad : null,
      loadMargin: load ? load.margin : null,
      cycleCount: (rope.cycles || []).length,
    },
    reasons,
  };
}
