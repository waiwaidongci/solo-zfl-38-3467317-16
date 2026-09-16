// 真实浏览器走查（Playwright 驱动 Chromium）：
// 覆盖 安全 / 返工 / 拒绝 / 并发只成功一次 / 批量回滚 / 重启持久化。
// 用法：node tests/browser-walkthrough.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { createApp } from "../lib/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOT = join(__dirname, "screenshots");

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const roots = ["/home/node/.cache/ms-playwright", `${process.env.HOME}/.cache/ms-playwright`];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      const candidates = [
        join(root, dir, "chrome-headless-shell-linux-arm64", "chrome-headless-shell"),
        join(root, dir, "chrome-linux", "chrome"),
        join(root, dir, "chrome-linux-arm64", "chrome"),
      ];
      for (const c of candidates) if (existsSync(c)) return c;
    }
  }
  return undefined;
}

function ldLibraryPath() {
  const d = join(process.env.HOME || "/tmp", "chromedeps", "root");
  const parts = [join(d, "usr/lib/aarch64-linux-gnu"), join(d, "lib/aarch64-linux-gnu"), join(d, "usr/lib"), join(d, "lib")].filter((p) => existsSync(p));
  return parts.join(":");
}

process.env.ENABLE_FAULTS = "1";
const dir = await mkdtemp(join(tmpdir(), "knot-browser-"));
const dbPath = join(dir, "browser.json");
let app = createApp({ dbPath });
await new Promise((r) => app.server.listen(0, r));
let base = `http://127.0.0.1:${app.server.address().port}`;

const { chromium } = await import("playwright");
const executablePath = findChrome();
if (!executablePath) {
  console.error("未找到 Chromium，请先 npx playwright install chromium");
  process.exit(2);
}
const extraLibs = ldLibraryPath();
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  env: { ...process.env, LD_LIBRARY_PATH: [extraLibs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") },
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(["PASS", name]);
    console.log("  ✓ " + name);
  } catch (e) {
    results.push(["FAIL", name + " — " + e.message]);
    console.log("  ✗ " + name + "\n    " + e.message.split("\n").join("\n    "));
    try { await page.screenshot({ path: join(SHOT, "FAIL-" + results.length + ".png"), fullPage: true }); } catch {}
    failures++;
  }
}
let failures = 0;

async function ropeId(ropeNo) {
  return page.evaluate(async (no) => {
    const list = await (await fetch("/api/ropes")).json();
    const r = list.find((x) => x.ropeNo === no);
    return r ? r.id : null;
  }, ropeNo);
}

async function registerRope(data) {
  await page.goto(base + "/");
  await page.fill('input[name=ropeNo]', data.ropeNo);
  await page.fill('input[name=location]', data.location);
  await page.fill('input[name=diameterMm]', String(data.diameterMm));
  await page.selectOption('select[name=knotType]', data.knotType);
  await page.fill('input[name=turns]', String(data.turns));
  await page.fill('input[name=tailLengthMm]', String(data.tailLengthMm));
  await page.fill('input[name=preloadN]', String(data.preloadN));
  await page.fill('input[name=ratedLoadN]', String(data.ratedLoadN));
  await page.fill('input[name=formerName]', data.formerName);
  await page.fill('input[name=inspectorName]', data.inspectorName);
  if (data.checkHint) {
    const hint = await page.textContent("#knotHint");
    assert.match(hint, /最小尾长/);
    assert.match(hint, new RegExp(`最大允许滑移 ${data.diameterMm}(\\.00)? mm`));
  }
  await page.click('#registerForm button');
  await page.waitForSelector(`#rope-${encodeURIComponent(data.ropeNo)}`);
}

async function addCycles(ropeNo, slips, loadN = 400) {
  for (let i = 0; i < slips.length; i++) {
    const id = await ropeId(ropeNo);
    await page.selectOption("#cycleRope", id);
    const hint = await page.textContent("#cycleSeqHint");
    assert.match(hint, new RegExp(`下一次序号 ${i + 1}\\b`));
    await page.fill('input[name=loadN]', String(loadN));
    await page.fill('input[name=tailSlipMm]', String(slips[i]));
    await page.click('#cycleForm button');
    await page.waitForTimeout(120);
  }
}

async function confirmRope(ropeNo, inspector) {
  const id = await ropeId(ropeNo);
  await page.selectOption("#confirmRope", id);
  await page.fill('#confirmForm input[name=inspectorName]', inspector);
  await page.click('#singleConfirmBtn');
  await page.waitForTimeout(250);
}

await mkdir(SHOT, { recursive: true });
console.log("浏览器走查开始：", await browser.version());

// ── 1. 安全路径 ──
await step("安全：登记→5 次循环→定案为安全通过，显示最小尾长/最大滑移提示", async () => {
  await registerRope({
    ropeNo: "R-SAFE", location: "前桅侧支索", diameterMm: 10, knotType: "figure-eight-follow-through",
    turns: 2, tailLengthMm: 120, preloadN: 100, ratedLoadN: 1000, formerName: "张三", inspectorName: "李四",
    checkHint: true,
  });
  await addCycles("R-SAFE", [2, 3.2, 4, 4.5, 4.8]);
  const card = page.locator("#rope-R-SAFE");
  await card.waitFor();
  assert.match(await card.textContent(), /循环进度 5 \/ 5/);
  assert.equal(await card.locator("svg polyline").count(), 1); // 滑移趋势图
  await confirmRope("R-SAFE", "李四");
  await page.waitForSelector("#rope-R-SAFE .sealed.safe");
  assert.match(await card.textContent(), /不可覆盖结果/);
  assert.match(await page.textContent("#stats"), /安全通过[\s\S]*?1/);
});

// ── 2. 拒绝路径 + 危险项面板 ──
await step("拒绝：短尾长/滑移未稳定/余量不足，危险项面板列明原因", async () => {
  await registerRope({
    ropeNo: "R-BAD", location: "后桅升帆索", diameterMm: 10, knotType: "figure-eight-follow-through",
    turns: 2, tailLengthMm: 60, preloadN: 100, ratedLoadN: 1000, formerName: "张三", inspectorName: "李四",
  });
  await addCycles("R-BAD", [1, 2, 3, 3.5, 6], 800);
  await confirmRope("R-BAD", "李四");
  const card = page.locator("#rope-R-BAD");
  await card.waitFor();
  await page.waitForSelector("#rope-R-BAD .sealed.reject");
  const text = await card.textContent();
  assert.match(text, /【拒绝】/);
  const danger = await page.textContent("#dangerItems");
  assert.match(danger, /R-BAD/);
  assert.match(danger, /滑移未稳定|末次滑移增量/);
  assert.match(danger, /余量/);
});

// ── 3. 返工路径 ──
await step("返工：尾长略短判定返工", async () => {
  await registerRope({
    ropeNo: "R-FIX", location: "船首斜桁支索", diameterMm: 10, knotType: "figure-eight-follow-through",
    turns: 2, tailLengthMm: 95, preloadN: 100, ratedLoadN: 1000, formerName: "张三", inspectorName: "李四",
  });
  await addCycles("R-FIX", [2, 3.2, 4, 4.5, 4.8]);
  await confirmRope("R-FIX", "李四");
  await page.waitForSelector("#rope-R-FIX .sealed.rework");
  assert.match(await page.textContent("#rope-R-FIX"), /尾长.*低于最小尾长/);
});

await page.screenshot({ path: join(SHOT, "01-three-verdicts.png"), fullPage: true });

// ── 4. 并发：8 个同时确认只成功一次（UI + fetch 双重验证）──
await step("并发：双击/8 并发确认只成功一次，其余被告知已定案", async () => {
  await registerRope({
    ropeNo: "R-RACE", location: "稳索", diameterMm: 10, knotType: "bowline",
    turns: 2, tailLengthMm: 120, preloadN: 100, ratedLoadN: 1200, formerName: "张三", inspectorName: "李四",
  });
  await addCycles("R-RACE", [2, 3, 3.6, 4, 4.2]);
  const id = await page.evaluate(async () => {
    const list = await (await fetch("/api/ropes")).json();
    return list.find((r) => r.ropeNo === "R-RACE").id;
  });
  const errorsBefore = errors.length;
  const codes = await page.evaluate(async (id) => {
    const rs = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`/api/ropes/${id}/confirm`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inspectorName: "李四" }),
        })
      )
    );
    return rs.map((r) => r.status).sort();
  }, id);
  // 这 7 个 409 是预期结果：浏览器会把非 2xx 记为控制台错误，予以剔除
  errors.splice(errorsBefore, errors.length - errorsBefore);
  assert.equal(codes.filter((c) => c === 201).length, 1);
  assert.equal(codes.filter((c) => c === 409).length, 7);
  await page.reload();
  await page.waitForSelector("#rope-R-RACE .sealed.safe");
});

// ── 5. 批量回滚：批次含他人验收的索，整批中止不留半批 ──
await step("回滚：批量确认中一根不满足→整批回滚，好索仍待确认", async () => {
  await registerRope({
    ropeNo: "R-B1", location: "侧支索A", diameterMm: 10, knotType: "figure-eight-follow-through",
    turns: 2, tailLengthMm: 120, preloadN: 100, ratedLoadN: 1000, formerName: "张三", inspectorName: "李四",
  });
  await addCycles("R-B1", [2, 3.2, 4, 4.5, 4.8]);
  await registerRope({
    ropeNo: "R-B2", location: "侧支索B", diameterMm: 10, knotType: "figure-eight-follow-through",
    turns: 2, tailLengthMm: 120, preloadN: 100, ratedLoadN: 1000, formerName: "张三", inspectorName: "钱七",
  });
  await addCycles("R-B2", [2, 3.2, 4, 4.5, 4.8]);
  await page.reload();
  for (const no of ["R-B1", "R-B2"]) {
    await page.check(`#rope-${no} input[data-batch]`);
  }
  await page.fill('#confirmForm input[name=inspectorName]', "李四");
  const errBefore = errors.length;
  await page.click("#batchConfirmBtn");
  await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("整批已回滚"));
  errors.splice(errBefore, errors.length - errBefore); // 该 409 为预期
  // 两根都仍是待确认（无半批）
  const states = await page.evaluate(async () => {
    const list = await (await fetch("/api/ropes")).json();
    return Object.fromEntries(list.filter((r) => ["R-B1", "R-B2"].includes(r.ropeNo)).map((r) => [r.ropeNo, !!r.confirmation]));
  });
  assert.deepEqual(states, { "R-B1": false, "R-B2": false });
  await page.reload();
  // 剔除问题索后批量成功
  await page.check('#rope-R-B1 input[data-batch]');
  await page.fill('#confirmForm input[name=inspectorName]', "李四");
  await page.click("#batchConfirmBtn");
  await page.waitForSelector("#rope-R-B1 .sealed.safe");
});

// ── 6. 持久化：重启服务后刷新页面，定案结果与危险项仍在，且不可重复确认 ──
await step("持久化：服务重启+页面刷新后数据仍在，已定案索不能再确认", async () => {
  await new Promise((r) => app.server.close(r));
  const second = createApp({ dbPath });
  await new Promise((r) => second.server.listen(0, r));
  base = `http://127.0.0.1:${second.server.address().port}`;
  app = second;
  await page.goto(base + "/");
  await page.waitForSelector("#rope-R-SAFE .sealed.safe");
  await page.waitForSelector("#rope-R-BAD .sealed.reject");
  assert.match(await page.textContent("#dangerItems"), /R-BAD/);
  // 已定案的索不再出现在确认下拉
  const confirmOptions = await page.locator("#confirmRope").textContent();
  assert.doesNotMatch(confirmOptions, /R-SAFE/);
  assert.doesNotMatch(confirmOptions, /R-BAD/);
  // 未确认的 R-B2 仍在
  assert.match(confirmOptions, /R-B2/);
});

await page.screenshot({ path: join(SHOT, "02-after-restart.png"), fullPage: true });

// 页面无 JS 错误
await step("走查全程无页面 JS 错误", async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
await new Promise((r) => app.server.close(r));
await rm(dir, { recursive: true, force: true });

console.log(`\n浏览器走查：${results.filter((r) => r[0] === "PASS").length}/${results.length} 通过`);
process.exit(failures ? 1 : 0);
