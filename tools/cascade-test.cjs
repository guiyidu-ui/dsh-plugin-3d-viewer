// 三维查看器回归测试（无头浏览器驱动真实 DSH 页面）
//
// 用法（Windows PowerShell）：
//   $env:DSH_URL    = "http://127.0.0.1:3080"
//   $env:DSH_TOKEN  = "<登录 token>"          # 或用 DSH_TOKEN_FILE 指向含 ?token=... 的地址文件
//   $env:EDGE_PATH  = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
//   $env:MODEL_PATH = "D:\models\demo.obj"
//   $env:PPTR_CORE  = "C:\path\to\puppeteer-core"   # 可选，默认按 node 解析 "puppeteer-core"
//   node tools/cascade-test.cjs A,B,C,D
//
// 场景：
//   A 注入 1 个 /model3d 链接（[3d:路径] 形态）
//   B 注入 1 个 3d 代码块（DSH 新版 md-code-block 形态）
//   C 对照组：普通代码块 + 普通链接（预期不挂载、不卡）
//   D 级联计数：人为在第 200 次"查看器自建 /model3d 链接"时掐断，数出级联规模
//      （修复前实测 399 个查看器 / 199 个 WebGL / 21 ms；修复后应只有 1~2 次）
//
// 判定要点：
//   * 注入动作本身**超时** = 页面主线程被冻结（CDP Runtime.callFunctionOn 永不返回）
//   * viewers 稳定在 1~4（含隐藏锚点，含 1 个 canvas）且 rAF 往返正常 = 通过
const fs = require("node:fs");
const path = require("node:path");

function loadPuppeteer() {
  const p = process.env.PPTR_CORE || "puppeteer-core";
  try { return require(p); } catch (e) {
    console.error(`[FATAL] 无法加载 puppeteer-core（可用 PPTR_CORE 指定绝对路径）：${e.message}`);
    process.exit(2);
  }
}

const puppeteer = loadPuppeteer();
const BASE = (process.env.DSH_URL || "http://127.0.0.1:3080").replace(/\/$/, "");
const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const MODEL = process.env.MODEL_PATH || "";
const ONLY = (process.argv[2] || "A,B,C,D").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

function readToken() {
  if (process.env.DSH_TOKEN) return process.env.DSH_TOKEN.trim();
  const f = process.env.DSH_TOKEN_FILE;
  if (f && fs.existsSync(f)) {
    const m = fs.readFileSync(f, "utf8").match(/token=([A-Za-z0-9_-]+)/);
    if (m) return m[1];
  }
  return "";
}

function modelUrl(abs) {
  const raw = abs.replace(/\\/g, "/").replace(/^\/+/, "");
  const drive = /^[A-Za-z]:/.exec(raw);
  const enc = raw.split("/").map(encodeURIComponent).join("/");
  return "/model3d/" + (drive ? enc.replace("%3A", ":") : enc);
}

const SAMPLE = () => ({
  viewers: document.querySelectorAll("[data-dsv3d]").length,
  openLinks: document.querySelectorAll('a[href^="/model3d/"]').length,
  gl: (window.__glCount | 0),
  canvases: document.querySelectorAll("canvas").length,
  nodes: document.getElementsByTagName("*").length,
  anchors: window.__anchorSets | 0,
  plugin: window.__dsv3d || null
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const token = readToken();
  if (!token) { console.error("[FATAL] 缺少 token：设置 DSH_TOKEN 或 DSH_TOKEN_FILE"); process.exit(2); }
  if (!MODEL) { console.error("[FATAL] 缺少模型路径：设置 MODEL_PATH"); process.exit(2); }

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1400,900"],
    protocolTimeout: 25000
  });

  const instrument = () => {
    window.__glCount = 0;
    window.__anchorSets = 0;
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (/webgl/i.test(String(type))) window.__glCount++;
      return orig.call(this, type, ...rest);
    };
  };

  async function newPage() {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.evaluateOnNewDocument(instrument);
    const errs = [];
    page.on("pageerror", (e) => errs.push("[pageerror] " + String(e).slice(0, 200)));
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") errs.push(`[console.${m.type()}] ` + m.text().slice(0, 200));
    });
    await page.goto(`${BASE}/?token=${token}`, { waitUntil: "domcontentloaded", timeout: 40000 });
    await sleep(6000);
    return { page, errs };
  }

  const injectAnchor = (u, txt) => {
    const a = document.createElement("a");
    a.href = u; a.textContent = txt;
    document.body.appendChild(a);
    return { href: a.getAttribute("href") };
  };
  const injectCodeBlock = (txt) => {
    const card = document.createElement("div");
    card.className = "md-code-block";
    const content = document.createElement("div");
    content.setAttribute("data-code-block-content", "1");
    const pre = document.createElement("pre");
    pre.className = "shiki css-variables";
    const code = document.createElement("code");
    code.textContent = txt;
    pre.appendChild(code); content.appendChild(pre); card.appendChild(content);
    document.body.appendChild(card);
    return { injected: true };
  };

  async function run(title, action, opts = {}) {
    console.log(`\n## ${title}`);
    const { page, errs } = await newPage();
    if (opts.valve) { await page.evaluate(opts.valve); console.log("  已装载级联掐断阀（第 200 次即停）"); }
    const t0 = Date.now();
    try {
      await page.evaluate(action, ...(opts.args || []));
      console.log(`  注入完成 @${Date.now() - t0}ms`);
    } catch (e) {
      console.log(`  *** 注入动作超时/冻结 @${Date.now() - t0}ms（页面主线程被冻结）：${String(e).slice(0, 120)}`);
      await page.close().catch(() => {});
      return;
    }
    const samples = [];
    for (let i = 0; i < 14; i++) {
      await sleep(500);
      try { samples.push(await page.evaluate(SAMPLE)); }
      catch (e) { console.log(`  *** 采样超时（页面冻结）@${Date.now() - t0}ms`); break; }
    }
    let raf = "n/a";
    try { raf = await page.evaluate(() => new Promise((r) => { const t = performance.now(); requestAnimationFrame(() => r(Math.round(performance.now() - t))); })); }
    catch (e) { raf = "HUNG"; }
    const last = samples[samples.length - 1] || null;
    console.log("  最终状态:", JSON.stringify(last));
    console.log(`  rAF 往返=${raf}ms  页面错误=${errs.length ? errs.slice(0, 3).join(" ;; ") : "无"}`);
    if (opts.expectControl) {
      console.log(`  判定: ${last && last.viewers === 0 ? "正常（对照组未被挂载）" : "*** 对照组被误挂载 ***"}`);
    } else if (last) {
      console.log(`  判定: ${last.viewers >= 1 && last.viewers <= 6 ? "正常（挂载 " + last.viewers + " 个标记，无级联）" : "*** 挂载数异常：" + last.viewers + " ***"}`);
    }
    await page.close().catch(() => {});
  }

  if (ONLY.includes("A")) await run("A. 注入 1 个 /model3d 链接", injectAnchor, { args: [modelUrl(MODEL), MODEL] });
  if (ONLY.includes("B")) await run("B. 注入 1 个 3d 代码块", injectCodeBlock, { args: [MODEL] });
  if (ONLY.includes("C")) {
    await run("C. 对照组：普通代码块 + 普通链接", () => {
      const card = document.createElement("div");
      card.className = "md-code-block";
      const content = document.createElement("div");
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = "console.log('hello')";
      pre.appendChild(code); content.appendChild(pre); card.appendChild(content);
      document.body.appendChild(card);
      const a = document.createElement("a");
      a.href = "/docs/readme.md"; a.textContent = "普通链接";
      document.body.appendChild(a);
      return { ok: true };
    }, { expectControl: true });
  }
  if (ONLY.includes("D")) {
    await run("D. 级联计数（掐断阀：第 200 次自建 /model3d 链接即抛错停止）", injectAnchor, {
      args: [modelUrl(MODEL), MODEL],
      valve: () => {
        const d = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, "href");
        window.__anchorSets = 0;
        Object.defineProperty(HTMLAnchorElement.prototype, "href", {
          configurable: true,
          enumerable: d.enumerable,
          get: d.get,
          set(v) {
            if (String(v).indexOf("/model3d/") === 0) {
              window.__anchorSets++;
              if (window.__anchorSets > 200) throw new Error("CASCADE-ABORT");
            }
            d.set.call(this, v);
          }
        });
      }
    });
  }

  await browser.close();
}

main().catch((e) => { console.error("FAIL", e); process.exit(1); });
