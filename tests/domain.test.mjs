import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KNOTS,
  MIN_CYCLES,
  evaluateRope,
  minTailLengthMm,
  maxAllowedSlipMm,
  validateRegistration,
} from "../lib/knots.js";

// 构造一根已登记绳索；slips 为各循环“累计滑移”，loads 为各循环载荷
function rope(overrides = {}) {
  const slips = overrides.slips || [2, 3.2, 4, 4.5, 4.8];
  const loads = overrides.loads || [400, 400, 400, 400, 400];
  const { slips: _s, loads: _l, ...rest } = overrides;
  return {
    id: "R-test",
    ropeNo: "R-T",
    location: "前桅侧支索",
    diameterMm: 10,
    knotType: "figure-eight-follow-through",
    turns: 2,
    tailLengthMm: 120,
    preloadN: 100,
    ratedLoadN: 1000,
    formerName: "张三",
    inspectorName: "李四",
    cycles: slips.map((s, i) => ({ seq: i + 1, loadN: loads[i] ?? 400, tailSlipMm: s })),
    ...rest,
  };
}

test("结型库与派生限值", () => {
  assert.equal(Object.keys(KNOTS).length >= 4, true);
  assert.equal(minTailLengthMm("figure-eight-follow-through", 10), 100); // 10d
  assert.equal(minTailLengthMm("anchor-bend", 4), 50); // 8d=32 < 绝对下限 50
  assert.equal(maxAllowedSlipMm(10), 10); // 1d
  assert.equal(MIN_CYCLES, 5);
});

test("安全通过：尾长充足、滑移收敛、余量充分", () => {
  const r = evaluateRope(rope());
  assert.equal(r.verdict, "safe", JSON.stringify(r.reasons));
  assert.equal(r.metrics.slipStable, true);
  assert.ok(r.metrics.loadMargin >= 1.5); // 750 / 400 = 1.875
  assert.equal(r.metrics.minTailLengthMm, 100);
  assert.equal(r.metrics.maxAllowedSlipMm, 10);
  assert.deepEqual(r.metrics.slipIncrements, [2, 1.2, 0.8, 0.5, 0.3]);
});

test("返工：尾长略短（差距在 1d 内）", () => {
  const r = evaluateRope(rope({ tailLengthMm: 95 })); // 要求 100，差 5mm < 1d
  assert.equal(r.verdict, "rework");
  assert.ok(r.reasons.some((x) => x.code === "tail_short"));
});

test("返工：载荷余量 1.25~1.5", () => {
  const r = evaluateRope(rope({ loads: [580, 580, 580, 580, 580] })); // 750/580=1.293
  assert.equal(r.verdict, "rework");
  assert.ok(r.reasons.some((x) => x.code === "margin_low"));
});

test("返工：绕圈数不足", () => {
  const r = evaluateRope(rope({ knotType: "round-turn-two-half-hitches", turns: 2 })); // 要求 3
  assert.equal(r.verdict, "rework");
  assert.ok(r.reasons.some((x) => x.code === "turns_insufficient"));
});

test("拒绝：尾长严重不足（差距超过 1d）", () => {
  const r = evaluateRope(rope({ tailLengthMm: 85 })); // 差 15mm > 1d
  assert.equal(r.verdict, "reject");
  assert.ok(r.reasons.some((x) => x.code === "tail_too_short"));
});

test("拒绝：滑移未稳定（末次增量超 0.15d）", () => {
  const r = evaluateRope(rope({ slips: [1, 1.5, 2, 2.5, 5] })); // 末次 Δ=2.5 > 1.5
  assert.equal(r.verdict, "reject");
  assert.ok(r.reasons.some((x) => x.code === "slip_unstable"));
});

test("拒绝：累计滑移超过 1d", () => {
  const r = evaluateRope(rope({ slips: [3, 6, 9, 10.5, 11] }));
  assert.equal(r.verdict, "reject");
  assert.ok(r.reasons.some((x) => x.code === "slip_exceeded"));
});

test("拒绝：载荷余量不足（<1.25）", () => {
  const r = evaluateRope(rope({ loads: [700, 700, 700, 700, 700] })); // 750/700=1.07
  assert.equal(r.verdict, "reject");
  assert.ok(r.reasons.some((x) => x.code === "margin_insufficient"));
});

test("拒绝：加载循环少于 5 次", () => {
  const r = evaluateRope(rope({ slips: [1, 2, 3], loads: [100, 100, 100] }));
  assert.equal(r.verdict, "reject");
  assert.ok(r.reasons.some((x) => x.code === "cycles_insufficient"));
});

test("拒绝：成型员与验收员为同一人 / 登记字段缺失", () => {
  const errors = validateRegistration(rope({ formerName: "王五", inspectorName: "王五" }));
  assert.ok(errors.some((e) => e.includes("职责分离")));
  assert.ok(validateRegistration({}).length >= 5);
});

test("拒绝原因齐备：最小尾长、最大允许滑移都在指标中给出", () => {
  const r = evaluateRope(rope({ tailLengthMm: 80, slips: [4, 7, 10, 12, 14], loads: [800, 800, 800, 800, 800] }));
  assert.equal(r.verdict, "reject");
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("tail_too_short"));
  assert.ok(codes.includes("slip_exceeded"));
  assert.ok(codes.includes("margin_insufficient"));
  assert.equal(r.metrics.minTailLengthMm, 100);
  assert.equal(r.metrics.maxAllowedSlipMm, 10);
});
