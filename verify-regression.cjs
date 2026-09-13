/* 反例回归：上海时区凌晨本地日期 + 导入缺字段/类型错误/结构不完整拦截 */
const { chromium } = require("playwright");

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name} ${detail}`);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

// 模拟的“上海凌晨”时刻（UTC 前一天 16:30，即北京时间 00:30）
const SHANGHAI_WEE_HOURS = "2026-09-13T16:30:00Z";

(async () => {
  const browser = await chromium.launch();

  // ============ 反例 1：Asia/Shanghai 凌晨 ============
  // 在每个文档脚本执行前把全局 Date 固定到 UTC 2026-09-13 16:30（北京 09-14 00:30）
  const context = await browser.newContext({ timezoneId: "Asia/Shanghai" });
  await context.addInitScript((fixed) => {
    const RealDate = Date;
    const fixedMs = new RealDate(fixed).getTime();
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(fixedMs);
        else super(...args);
      }
      static now() {
        return fixedMs;
      }
    }
    window.Date = FakeDate;
  }, SHANGHAI_WEE_HOURS);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("http://localhost:8765/index.html");
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();

  // 浏览器真实时区偏移
  const tzOffset = await page.evaluate(() => -new Date().getTimezoneOffset());
  check("环境：浏览器时区为 UTC+8", tzOffset === 480, `offset=${tzOffset}`);
  const localDateNow = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  check("环境：固定时钟为上海 2026-09-14 凌晨", localDateNow === "2026-09-14", localDateNow);

  // 默认开始日期必须是本地 09-14，而不是 UTC 的 09-13
  await page.click("#campTab");
  await page.waitForSelector(".day-card");
  const startVal = await page.inputValue("#startDateInput");
  check("上海凌晨：训练营默认开始日期 = 本地 2026-09-14", startVal === "2026-09-14", startVal);
  const firstDay = await page.textContent(".day-card:first-child .day-date");
  check("上海凌晨：计划第 1 天日期 = 2026-09-14", firstDay.trim() === "2026-09-14", firstDay);

  // 标记今天玩过 → lastPlayed = 本地 09-14，显示 0 天未玩
  await page.click("#libraryTab");
  await page.waitForSelector(".game-card");
  await page.click(".game-card");
  await page.waitForTimeout(80);
  await page.click("#playedTodayBtn");
  await page.waitForTimeout(80);
  const detailText = await page.textContent(".detail-panel");
  check("上海凌晨：标记今天玩过后显示 0 天未玩", detailText.includes("0天未玩"), "应显示0天未玩");
  const lastPlayedStored = await page.evaluate(() => state.games.find((g) => g.id === state.selectedId).lastPlayed);
  check("上海凌晨：lastPlayed 落库为本地 2026-09-14", lastPlayedStored === "2026-09-14", lastPlayedStored);
  const staleRibbon = await page.textContent(".game-card.selected .stale-ribbon").catch(() => "");
  check("上海凌晨：列表角标也是 0 天未玩", staleRibbon.includes("0天未玩"), staleRibbon);

  // 新增桌游表单默认日期 = 今天本地日期
  await page.click("#campTab"); // 触发不到 setDefaultDate，直接读输入框
  await page.click("#libraryTab");
  const formDate = await page.inputValue("#lastPlayedInput");
  check("上海凌晨：新增表单上次游玩默认日期为本地今天", formDate === "2026-07-14", formDate);

  // ============ 反例 2：导入缺字段/类型错误/结构不完整 ============
  // 先做一份正常数据并导出，作为篡改基础
  await page.click("#campTab");
  await page.waitForTimeout(100);
  const goodPayload = await page.evaluate(() => ({
    app: "boardgame-rule-camp",
    version: 1,
    training: JSON.parse(JSON.stringify(JSON.parse(localStorage.getItem("zfl18-camp"))))
  }));
  // goodPayload.training.sessions 此时为空数组（正常但无场次）。补一条合法场次
  const ref = await page.evaluate(() => {
    const g = state.games[0];
    return { gid: g.id, rid: g.forgets[0].id };
  });
  goodPayload.training.sessions = [
    {
      id: "sess-1",
      date: "2026-09-14",
      type: "quiz",
      finishedAt: "2026-09-14T01:00:00+08:00",
      answers: [{ ...ref, ok: false }]
    }
  ];

  const snapshotBefore = await page.evaluate(() => localStorage.getItem("zfl18-camp"));

  async function tryImport(obj, label, expect) {
    await page.evaluate(
      (payload) => {
        const content = typeof payload === "string" ? payload : JSON.stringify(payload);
        const dt = new DataTransfer();
        dt.items.add(new File([content], "bad.json", { type: "application/json" }));
        const input = document.querySelector("#importFile");
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      obj
    );
    await page.waitForTimeout(200);
    const n = (await page.textContent("#campNotice")).trim();
    check(`${label}：拦截并提示「${expect}」`, n.includes(expect), n.slice(0, 120));
  }

  // a) 缺少 sessions 数组（本次报告的崩溃反例）
  const noSessions = JSON.parse(JSON.stringify(goodPayload));
  delete noSessions.training.sessions;
  await tryImport(noSessions, "缺字段-无sessions数组", "sessions");

  // b) sessions 类型错误（不是数组）
  const badSessionsType = JSON.parse(JSON.stringify(goodPayload));
  badSessionsType.training.sessions = "oops";
  await tryImport(badSessionsType, "类型错误-sessions非数组", "sessions");

  // c) 结构不完整：缺少整个 training
  const noTraining = { app: "boardgame-rule-camp", version: 1 };
  await tryImport(noTraining, "结构不完整-缺training", "training");

  // d) 缺少 plan / wrongs / seen / mastery / config 多个顶层字段
  const partial = { app: "boardgame-rule-camp", training: { sessions: [] } };
  await tryImport(partial, "结构不完整-多字段缺失", "结构不完整");

  // e) 场次内字段类型错误：ok 不是布尔、answers 缺 gid
  const badAnswer = JSON.parse(JSON.stringify(goodPayload));
  badAnswer.training.sessions[0].answers = [{ gid: ref.gid, rid: ref.rid, ok: "yes" }];
  await tryImport(badAnswer, "类型错误-ok非布尔", "布尔");
  const missingGid = JSON.parse(JSON.stringify(goodPayload));
  missingGid.training.sessions[0].answers = [{ rid: ref.rid, ok: true }];
  await tryImport(missingGid, "缺字段-答案缺gid", "gid");

  // f) 非法日期（2026-02-30）
  const badDate = JSON.parse(JSON.stringify(goodPayload));
  badDate.training.config.startDate = "2026-02-30";
  await tryImport(badDate, "非法日期-02-30", "有效日期");

  // g) 数字配置写成字符串
  const cfgString = JSON.parse(JSON.stringify(goodPayload));
  cfgString.training.config.perDay = "四";
  await tryImport(cfgString, "类型错误-perDay非数字", "数字");

  // 全部失败后原数据不变
  const snapshotAfter = await page.evaluate(() => localStorage.getItem("zfl18-camp"));
  check("反例导入：原数据完全未被覆盖", snapshotBefore === snapshotAfter);
  check("反例导入后页面无 JS 报错", errors.length === 0, errors.join(" | ").slice(0, 200));

  // h) 正常导入仍然成功（回归）
  await tryImport(goodPayload, "正常导入回归", "导入成功");
  const imported = await page.evaluate(() => ({
    sessions: JSON.parse(localStorage.getItem("zfl18-camp")).sessions.length,
    start: JSON.parse(localStorage.getItem("zfl18-camp")).config.startDate
  }));
  check("正常导入：写入 1 场会话", imported.sessions === 1, `${imported.sessions}`);

  await context.close();
  await browser.close();

  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("失败项：\n - " + failures.join("\n - "));
    process.exit(1);
  }
})();
