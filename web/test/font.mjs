/**
 * 字体回归测试（真实浏览器 + 隔离实例）
 *
 * 守住这一轮修掉的两类「字体问题」。两条都曾经真实发生过，而且都很难靠肉眼发现 ——
 * 所以每一条都对应一个具体的断言，而不是泛泛地「字体看着对不对」。
 *
 * ① 字重被压平：@font-face 若声明 `font-weight: 100 900`，浏览器会认为字体自带全部字重、
 *    不再做合成加粗 —— 全站 400 和 900 渲染成同一个粗细，标题/数字的层级全部消失。
 *    ⚠️ 量具很关键：canvas 的 measureText 和 DOM 的 offsetWidth **都测不出来**
 *    （合成加粗在 Blink 里只加宽笔画，不改 advance width）。
 *    唯一可靠的量法是「着墨像素数」—— 把同一串字画到 canvas 上数深色像素。
 *
 * ② 楷体声明被丢弃：`font-family: "Kaiti SC", "KaiTi", inherit` —— `inherit` 是 CSS-wide
 *    关键字，混进字体列表会让整条声明非法被丢弃，识字内容会悄悄回落到圆体。
 *    这一条在 CSS 源码里不显眼，所以既做浏览器断言，也直接静态查源码。
 *
 * ③ 全站一套字：界面中文 / 数字 / 标点全部由方正准圆简体渲染（它的字库自带 ASCII 与
 *    中文标点，不需要再拼一份拉丁字体）。判据＝站点栈与「只有方正准圆简体」渲染出来的
 *    着墨量**必须相等** —— 不等就说明有第二个字体在偷偷参与。
 *
 * 用法：node web/test/font.mjs   或   cd web && npm run test:font
 * 依赖：playwright-core + 已构建的 web/dist
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/kalon/.workbuddy/binaries/node/workspace/node_modules/playwright-core");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = path.join(REPO, "server");
const PORT = 8800;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_CONFIG = path.join(SERVER, "config", "config.font.yaml");
const TEST_DB = path.join(SERVER, "data", "_font.db");
const NODE = "C:/Users/kalon/.workbuddy/binaries/node/versions/22.22.2-3/node.exe";
const SHOTS = path.join(REPO, "web", "test", "shots", "font");
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? `   → ${detail}` : ""}`);
  }
};
const step = (name) => console.log(`\n=== ${name} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEST_CONFIG_YAML = `server:
  port: ${PORT}
  host: 127.0.0.1
  corsOrigins: []
  auth: { enabled: false }
db:
  driver: sqlite
  sqlite: { file: ./data/_font.db }
llm:
  baseUrl: https://api.deepseek.com
  apiKey: test-key-not-used
  storyModel: deepseek-chat
  markModel: deepseek-chat
  suggestModel: deepseek-chat
  timeoutMs: { story: 60000, mark: 90000, suggest: 45000 }
  retries: 0
  temperature: { story: 0.9, mark: 0, suggest: 0.5 }
tts:
  provider: edge
  voice: zh-CN-XiaoyiNeural
  rate: "-12%"
  cacheDir: ./data/_font_tts
backup:
  enabled: false
  dir: ./data/_font_backup
`;

let server;
let browser;

async function waitHealthy(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(600);
  }
  return false;
}

try {
  console.log(`\n=== 准备隔离实例（端口 ${PORT}，独立 DB）===`);
  fs.writeFileSync(TEST_CONFIG, TEST_CONFIG_YAML, "utf8");
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  server = spawn(NODE, ["node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
    cwd: SERVER,
    env: { ...process.env, CONFIG_PATH: TEST_CONFIG, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const healthy = await waitHealthy();
  ok("隔离实例已就绪", healthy);
  if (!healthy) throw new Error("实例没起来，看 server/logs/app-*.log");

  browser = await chromium.launch({
    executablePath: "C:/Users/kalon/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
    args: ["--no-sandbox"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector("button.isle", { timeout: 20000 });
  await page.waitForTimeout(1200);

  // ————————————————————————————————————————— 1. 自托管切片真的加载了
  step("1. 字体文件真的加载成功（不是只剩一句声明）");
  {
    const f = await page.evaluate(async () => {
      await document.fonts.ready;
      const faces = [...document.fonts];
      const pick = (kw) => faces.filter((x) => x.family.includes(kw));
      return {
        fz: pick("方正准圆简体").map((x) => x.status),
        fzWeight: [...new Set(pick("方正准圆简体").map((x) => x.weight))],
      };
    });
    ok(
      "方正准圆简体切片已加载",
      f.fz.length > 0 && f.fz.includes("loaded"),
      `${f.fz.filter((s) => s === "loaded").length}/${f.fz.length} 已加载`,
    );
    // 关键：字重必须是真实值。声明成区间（100 900）会静默压平全站字重。
    ok(
      "方正准圆简体声明的字重是真实值 400（不是 100 900 区间）",
      f.fzWeight.length === 1 && f.fzWeight[0] === "400",
      `weight=${JSON.stringify(f.fzWeight)}`,
    );
  }

  // ————————————————————————————————————————— 2. 字重分层真的生效（着墨量）
  step("2. 字重分层生效（着墨像素数 —— 唯一能测出合成加粗的量具）");
  {
    const r = await page.evaluate(() => {
      // ⚠️ canvas 的 ctx.font **不解析 CSS 变量**：写 `var(--font-round)` 会让整条
      // font 简写非法、静默回落到默认 10px sans-serif，量出来的着墨量又小又没差别
      // （这个坑踩过一次：所有字号都报 134）。必须用 computedStyle 里展开后的字面字体栈。
      const stack = getComputedStyle(document.body).fontFamily;
      const ink = (fam, size, weight, text) => {
        const c = document.createElement("canvas");
        c.width = 460;
        c.height = 96;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = "#000";
        ctx.font = `${weight} ${size}px ${fam}`;
        ctx.fillText(text, 8, 66);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++;
        return n;
      };
      const out = { sizes: {}, stack };
      for (const size of [13.5, 16, 30]) {
        out.sizes[size] = {
          w400: ink(stack, size, 400, "口算岛完成6项"),
          w800: ink(stack, size, 800, "口算岛完成6项"),
        };
      }
      // 站点真实元素：顶栏进度数字（30px/900，曾经糊成实心块的那个）
      const el = document.querySelector(".tk-count b");
      out.real = el
        ? {
            weight: getComputedStyle(el).fontWeight,
            size: getComputedStyle(el).fontSize,
            fam: getComputedStyle(el).fontFamily,
          }
        : null;
      return out;
    });
    for (const size of Object.keys(r.sizes)) {
      const v = r.sizes[size];
      const grow = (v.w800 - v.w400) / Math.max(v.w400, 1);
      ok(
        `${size}px 加粗真的更粗（着墨 ${v.w400} → ${v.w800}，+${(grow * 100).toFixed(0)}%）`,
        grow > 0.15,
        `栈=${r.stack.slice(0, 40)}`,
      );
    }
    ok("顶栏进度数字带真实字重", !!r.real && Number(r.real.weight) >= 800, JSON.stringify(r.real));
  }

  // ————————————————————————————————————————— 3. 全站一套字（中文 / 数字 / 标点同源）
  step("3. 中文、数字、标点全部由方正准圆简体渲染");
  {
    const bodyFam = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    ok("body 字体栈里方正准圆简体排第一", /^"?方正准圆简体"?/.test(bodyFam), bodyFam.slice(0, 60));

    // 端到端证据：同一串字，「站点栈」与「只有方正准圆简体」渲染出来的着墨必须**相等** ——
    // 不相等就说明还有第二个字体在偷偷参与（以前是数字走 Nunito、汉字走站酷）。
    const diff = await page.evaluate(async () => {
      const stack = getComputedStyle(document.body).fontFamily;
      const ONLY = '"方正准圆简体"';
      const samples = ["0123456789", "口算岛", "……", "——", "1:32", "7 × 8 ="];
      // canvas 不会主动触发 @font-face 懒加载，先 load 再量
      for (const t of samples) {
        await document.fonts.load(`900 40px ${stack}`, t);
        await document.fonts.load(`900 40px ${ONLY}`, t);
      }
      await document.fonts.ready;
      const ink = (fam, text) => {
        const c = document.createElement("canvas");
        c.width = 460;
        c.height = 96;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = "#000";
        ctx.font = `900 40px ${fam}`;
        ctx.fillText(text, 8, 66);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++;
        return n;
      };
      const out = {};
      for (const t of samples) out[t] = { site: ink(stack, t), only: ink(ONLY, t) };
      return out;
    });

    const label = {
      "0123456789": "数字 0-9",
      "口算岛": "汉字",
      "……": "省略号 …",
      "——": "破折号 ——",
      "1:32": "用时 1:32",
      "7 × 8 =": "算式 7 × 8 =",
    };
    for (const [text, v] of Object.entries(diff)) {
      ok(
        `${label[text]} 由方正准圆简体渲染（站点栈与纯方正着墨一致）`,
        v.site === v.only && v.site > 0,
        `站点栈 ${v.site} vs 纯方正 ${v.only}`,
      );
    }

    // 站点真正会用到的字符必须都有字形：口算的 `7 × 8 =`、进度 `0 / 6`、用时 `1:32`、小数点。
    const cov = await page.evaluate(async () => {
      const need = "0123456789+-×÷=/:.%".split("");
      const stack = getComputedStyle(document.body).fontFamily;
      // check() 只对「已加载」的字体返回 true，不主动触发加载 —— 先 load 再 check
      await document.fonts.load(`900 40px ${stack}`, need.join(""));
      await document.fonts.ready;
      return need.filter((c) => !document.fonts.check(`900 40px ${stack}`, c));
    });
    ok("数字与运算符无缺字（0-9 + − × ÷ = / : . %）", cov.length === 0, `缺：${cov.join(" ")}`);

    // 数字必须是**等宽步进**：这份字体的 GSUB 里只有 vert，没有 tnum，
    // 所以 CSS 的 `font-variant-numeric: tabular-nums` 是空转的 ——
    // 原字体里 1 只有别的数字的 2/3 宽，计时器每跳一秒、分数每加一分都会左右抖。
    // scripts/build-local-font.py 的等宽化（只改间距，不动字形）就是修这个，这里守住它。
    const adv = await page.evaluate(async () => {
      const stack = getComputedStyle(document.body).fontFamily;
      await document.fonts.load(`800 30px ${stack}`, "0123456789");
      await document.fonts.ready;
      const c = document.createElement("canvas");
      const ctx = c.getContext("2d");
      ctx.font = `800 30px ${stack}`;
      return "0123456789".split("").map((d) => ctx.measureText(d).width);
    });
    const spread = Math.max(...adv) - Math.min(...adv);
    ok(
      "0-9 步进宽度一致（计时器不会跳秒抖动）",
      spread <= 0.5,
      `宽度 ${adv.map((x) => x.toFixed(1)).join("/")}，极差 ${spread.toFixed(2)}px`,
    );
  }

  // ————————————————————————————————————————— 4. 识字内容用楷体
  step("4. 识字/写字内容用楷体（教学字形正确性）");
  {
    await page.goto(`${BASE}/chinese`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    /** 取某个选择器上第一个元素的 font-family（元素不在就返回 null） */
    const famOf = (sel) =>
      page.evaluate((s) => {
        const el = document.querySelector(s);
        return el ? getComputedStyle(el).fontFamily : null;
      }, sel);

    const needKai = async (label, sel) => {
      const fam = await famOf(sel);
      if (fam === null) {
        ok(`${label} 真的渲染出来了（否则这条断言是空转）`, false, `${sel} 不在页面上`);
        return;
      }
      ok(`${label} 用楷体而非圆体`, /Kaiti|KaiTi|楷体/.test(fam), String(fam).slice(0, 44));
    };

    // 课文原文：用户要求「听写屋的课文内容做成和智能拼音童话一样」——
    // 先是同一套字体（站内圆体），后来（2026-09-19 规则③）连滚动方式也统一成
    // 「整页由浏览器滚，内容 DIV 自己不再滚」。
    // 这里曾经是唯一走楷体的成篇正文（`.lesson-text`），已被要求删掉。
    const lessonFam = await famOf(".story-text");
    lessonFam === null
      ? ok("课文原文真的渲染出来了（否则这条断言是空转）", false, ".story-text 不在页面上")
      : ok("课文原文用站内圆体（与童话统一）", /方正准圆简体/.test(lessonFam), String(lessonFam).slice(0, 60));

    // 内容 DIV 不再自己滚：滚动交给浏览器主滚动（规则③）。
    // 判据要成对拿 —— 只查 `overflow-y` 会被「overflow:visible 但被父级裁掉」骗过去。
    const lessonBox = await page.evaluate(() => {
      const el = document.querySelector(".story-text");
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        overflowY: cs.overflowY,
        innerScroll: el.scrollHeight - el.clientHeight,
        // 页面高度超过视口 → 浏览器主滚动条真的在起作用
        docOver: document.documentElement.scrollHeight - window.innerHeight,
        wrapOverflowY: getComputedStyle(document.querySelector(".wrap")).overflowY,
      };
    });
    lessonBox === null
      ? ok("课文内容 DIV 存在", false, "找不到 .story-text")
      : ok(
          "课文不自己滚（内层无滚动条），改由浏览器主滚动",
          lessonBox.overflowY === "visible" &&
            lessonBox.innerScroll <= 1 &&
            lessonBox.wrapOverflowY !== "auto" &&
            lessonBox.wrapOverflowY !== "scroll",
          JSON.stringify(lessonBox),
        );

    // 听写字格与手写格都要点进去才出现 —— 而这两个正是本轮修的那个 bug
    // （`font-family: "Kaiti SC", "KaiTi", inherit` 整条声明被浏览器丢掉，
    //   字形悄悄回落成圆体）。不真的走进去，这条回归就是空转。
    await page.locator(".seg-btn", { hasText: "生字听写" }).first().click();
    await page.waitForTimeout(900);
    await needKai("听写字格 .zi-face", ".zi-grid .zi-face");

    // 手写格（.hw-cell .hc-t）要真的在画布上写满 6 个字、提交、再进审核页才出现，
    // 为一个字体断言拖这么长的流程不划算，而且会把这个测试和听写流程绑死。
    // 它和另外 4 处（错题汉字 / 语言练习句子 / 大字 / 后台课文编辑）由下面第 6 步的
    // 源码静态检查统一守住：所有楷体声明必须走 var(--font-kai)，不许再写字面量。
    await page.screenshot({ path: path.join(SHOTS, "chinese.png") });
  }

  // ————————————————————————————————————————— 5. 描边补粗必须已经删掉
  step("5. 不再有 -webkit-text-stroke 描边补粗");
  {
    const stroked = await page.evaluate(() =>
      [...document.querySelectorAll("*")]
        .filter((el) => {
          const w = getComputedStyle(el).webkitTextStrokeWidth;
          return w && w !== "0px";
        })
        .map((el) => `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}`)
        .slice(0, 8),
    );
    ok("页面上没有任何元素带描边", stroked.length === 0, stroked.join(" | "));
  }

  // ————————————————————————————————————————— 6. 源码级静态检查
  step("6. 源码静态检查（这两个坑在 CSS 里都不显眼，必须直接查）");
  {
    const macaron = fs.readFileSync(path.join(REPO, "web", "src", "styles", "macaron.css"), "utf8");
    // 纯 `font-family: inherit;`（想要继承）没问题；混进字体列表的一定不行
    const bad = macaron
      .split("\n")
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /font-family:[^;]*inherit/.test(l) && !/font-family:\s*inherit\s*;/.test(l));
    ok(
      "macaron.css 没有把 inherit 混进字体列表",
      bad.length === 0,
      bad.map(([n, l]) => `L${n}`).join(" ") || "",
    );
    ok("macaron.css 没有 -webkit-text-stroke", !/text-stroke/.test(macaron.replace(/\/\*[\s\S]*?\*\//g, "")));

    // 楷体声明必须全部走 var(--font-kai)。
    // 这一条覆盖了听写字格之外的其他楷体位置（手写格 / 错题汉字 / 语言练习句子与大字 /
    // 后台课文编辑）—— 它们分散在样式表各处，曾经每一处都写着
    // `"Kaiti SC", "KaiTi", inherit` 这种会让整条声明作废的写法。
    const kaiKai = [...macaron.matchAll(/--font-kai:\s*([^;]+);/g)].map((m) => m[1]);
    ok("定义了 --font-kai 且含楷体兜底", kaiKai.length === 1 && /Kaiti|KaiTi/.test(kaiKai[0]), kaiKai.join(""));
    ok(
      "macaron.css 里没有散落的楷体字面量（都走 var(--font-kai)）",
      !/font-family:[^;]*["']Kaiti/.test(macaron),
      (macaron.match(/font-family:[^;]*["']Kaiti[^;]*;/g) || []).join(" | ").slice(0, 120),
    );
    ok("楷体声明至少 6 处走变量（听写 / 手写 / 错题汉字 / 语言句子与大字）", (macaron.match(/var\(--font-kai\)/g) || []).length >= 6, `${(macaron.match(/var\(--font-kai\)/g) || []).length} 处`);

    // 切片 CSS 由 scripts/build-local-font.py 生成，手改必被覆盖 —— 这里守住生成器的两条硬约束
    const fzc = fs.readFileSync(path.join(REPO, "web", "src", "styles", "font-fzzhunyuan.css"), "utf8");
    const weights = [...fzc.matchAll(/font-weight:\s*([^;]+);/g)].map((m) => m[1].trim());
    ok(
      "font-fzzhunyuan.css 全部切片声明的都是真实字重 400",
      weights.length > 0 && weights.every((w) => w === "400"),
      `共 ${weights.length} 条，取值 ${JSON.stringify([...new Set(weights)])}`,
    );
    const slices = [...fzc.matchAll(/unicode-range:/g)].length;
    ok("切片数量够多（字体才不会整包下载）", slices >= 50, `${slices} 片`);

    // 换字体最容易留下的尾巴：旧字体的名字还散落在样式表里
    const cssDir = path.join(REPO, "web", "src", "styles");
    const leftovers = [];
    for (const file of fs.readdirSync(cssDir)) {
      if (!file.endsWith(".css")) continue;
      const t = fs.readFileSync(path.join(cssDir, file), "utf8");
      for (const kw of ["ZCOOL", "Nunito"]) if (t.includes(kw)) leftovers.push(`${file}:${kw}`);
    }
    ok("样式表里没有残留的旧字体（ZCOOL / Nunito）", leftovers.length === 0, leftovers.join(" "));

    // 字体源文件是商业字体，绝不能进 git —— 只允许留在本地当切片输入
    const gi = fs.readFileSync(path.join(REPO, ".gitignore"), "utf8");
    ok(".gitignore 忽略了仓库根的 *.ttf / *.otf", /\/?\*\.ttf/.test(gi) && /\/?\*\.otf/.test(gi));
  }

  // 留几张 2x 截图便于人工复核（字体问题很难靠断言完全覆盖）
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector("button.isle", { timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SHOTS, "home.png") });
  for (const [name, sel] of [
    ["zoom-topbar", ".topbar"],
    ["zoom-track", ".isle-track"],
    ["zoom-stats", ".isle-stats"],
    ["zoom-isles", ".isle-map"],
  ]) {
    const el = page.locator(sel).first();
    if (await el.count()) await el.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => undefined);
  }
} catch (e) {
  failures.push(`异常中止：${e.message}`);
  console.error("\n异常：", e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.kill();
    await sleep(600);
    try {
      spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* 已经退出了 */
    }
  }
  console.log(`\n=== 字体回归 ${pass} / ${pass + failures.length} ===`);
  if (failures.length) {
    console.log("失败：");
    for (const f of failures) console.log("  ✗ " + f);
    process.exitCode = 1;
  } else {
    console.log("全部通过 ✓");
  }
}
