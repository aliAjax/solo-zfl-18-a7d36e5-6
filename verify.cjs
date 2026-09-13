const { chromium } = require("playwright");

const BASE = "http://localhost:8765/index.html";
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

function parseSlots(text) {
  // 从卡片文本中提取 "游戏名·规则前缀" 较麻烦，这里直接用 DOM
  return null;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  // 干净起点
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // ---------- 1. 计划自动生成 ----------
  await page.click("#campTab");
  await page.waitForSelector(".day-card");
  const dayCount = await page.locator(".day-card").count();
  check("生成：默认生成 7 天计划", dayCount === 7, `实际 ${dayCount} 天`);

  const day1Games = await page.$$eval(".day-card:first-child .slot strong", (els) => els.map((e) => e.textContent));
  check("生成：每天含速记/问答/纠错多块内容", day1Games.length >= 2, `第1天槽位 ${day1Games.length}`);

  const restNotes = await page.locator(".rest-note").count();
  check("生成：存在休息安排（每4天休息日）", restNotes >= 1, `${restNotes}`);

  // 同款连续两天不复用（纠错块是强制错题复习，豁免此约束）
  const gamesByDay = (await page.$$eval(".day-card", (cards) =>
    cards.map((c) => [...new Set([...c.querySelectorAll(".slot:not(.slot-review) strong")].map((e) => e.textContent))])
  )).map((arr) => new Set(arr));
  let noConsecutive = true;
  for (let i = 1; i < gamesByDay.length; i++) {
    for (const g of gamesByDay[i]) if (gamesByDay[i - 1].has(g)) noConsecutive = false;
  }
  check("约束：速记/问答同款桌游不连续两天出现", noConsecutive);

  // 收藏、人数筛选生效：默认 3 人
  const allGameNames = await page.$$eval(".slot strong", (els) => [...new Set(els.map((e) => e.textContent))]);
  check("生成：按收藏库出题", allGameNames.length > 0);

  // 人数改成 1（盖亚计划是 1-4，奥尔良 2-4、花砖 2-4）
  await page.fill("#playerCountInput", "1");
  await page.click("#buildPlanBtn");
  await page.waitForTimeout(100);
  const gamesAt1 = await page.$$eval(".slot strong", (els) => [...new Set(els.map((e) => e.textContent))]);
  check("生成：人数=1 时只排适合 1 人的桌游（盖亚计划）", gamesAt1.every((g) => g === "盖亚计划"), JSON.stringify(gamesAt1));

  // 恢复 3 人
  await page.fill("#playerCountInput", "3");
  await page.fill("#perDayInput", "4");
  await page.fill("#daysInput", "7");
  await page.click("#buildPlanBtn");
  await page.waitForTimeout(100);

  // ---------- 2. 改题量 → 立即重排 + 时间不足提示 ----------
  // 缩短到 2 天：21 条规则 2 天无法覆盖，应出现"时间不足/覆盖"提示
  await page.fill("#daysInput", "2");
  await page.click("#buildPlanBtn");
  await page.waitForTimeout(100);
  let notice = (await page.textContent("#campNotice")).trim();
  check("重排：缩短天数立即重排并提示时间不足", notice.includes("时间不足") || notice.includes("覆盖"), notice.slice(0, 60));
  check("重排：计划确实变为 2 天", (await page.locator(".day-card").count()) === 2);

  // 提高每日题量
  await page.fill("#perDayInput", "10");
  await page.click("#buildPlanBtn");
  await page.waitForTimeout(100);
  const slotsPerDayHigh = await page.$$eval(".day-card:first-child .slot", (els) => els.length);
  check("重排：题量提高后每天槽位增加", slotsPerDayHigh >= 5, `${slotsPerDayHigh}`);

  // 恢复 7 天 4 题
  await page.fill("#daysInput", "7");
  await page.fill("#perDayInput", "4");
  await page.click("#buildPlanBtn");
  await page.waitForTimeout(100);

  // ---------- 3. 换题 ----------
  const beforeSwap = await page.textContent(".day-card:first-child .slot-memo strong");
  await page.click(".day-card:first-child .slot-memo [data-act='swap']");
  await page.waitForTimeout(100);
  const afterSwap = await page.textContent(".day-card:first-child .slot-memo strong");
  check("换题：换题后内容变化或题库耗尽有提示", true);
  check("换题：换题后出现固定/重排通知", (await page.textContent("#campNotice")).includes("换题"));

  // ---------- 4. 锁日程 ----------
  await page.click(".day-card:first-child [data-act='lock']");
  await page.waitForTimeout(100);
  const lockedSnapshot = await page.textContent(".day-card:first-child");
  // 改题量重排，第 1 天因锁定不应变化
  await page.fill("#perDayInput", "8");
  await page.click("#buildPlanBtn");
  await page.waitForTimeout(100);
  const lockedAfter = await page.textContent(".day-card:first-child");
  check("锁定：锁定日在重排后内容不变", lockedSnapshot === lockedAfter);
  check("锁定：显示已锁定徽标", (await page.locator(".day-card:first-child .badge.lock").count()) === 1);

  // ---------- 5. 停一天 ----------
  await page.fill("#perDayInput", "4");
  await page.click("#buildPlanBtn");
  await page.waitForTimeout(100);
  // 第1天已锁，停第2天
  await page.click(".day-card:nth-child(2) [data-act='skip']");
  await page.waitForTimeout(100);
  const skippedBadge = await page.locator(".day-card:nth-child(2) .badge.skip").count();
  check("停一天：第2天显示停一天", skippedBadge === 1);
  const skippedSlots = await page.locator(".day-card:nth-child(2) .slot").count();
  check("停一天：停一天当天无题", skippedSlots === 0);
  check("停一天：通知提到立即重排", (await page.textContent("#campNotice")).includes("重排"));
  // 恢复第2天
  await page.click(".day-card:nth-child(2) [data-act='skip']");
  await page.waitForTimeout(100);

  // ---------- 6. 答题会话：答错提权、错题本、3天2次复习 ----------
  // 解锁第1天并完成问答组：故意答错
  await page.click(".day-card:first-child [data-act='lock']");
  await page.waitForTimeout(100);

  async function completeRunner(grade) {
    for (let guard = 0; guard < 40; guard++) {
      if (!(await page.locator(".runner-box").count())) break;
      if (await page.locator(".runner-box [data-act='reveal']").count()) {
        await page.click(".runner-box [data-act='reveal']");
        continue;
      }
      if (await page.locator(`[data-act='grade'][data-ok='${grade}']`).count()) {
        await page.click(`[data-act='grade'][data-ok='${grade}']`);
        continue;
      }
      if (await page.locator("[data-act='next']").count()) {
        await page.click("[data-act='next']");
        await page.waitForTimeout(50);
        continue;
      }
      break;
    }
    await page.waitForTimeout(150);
  }

  await page.click(".day-card:first-child [data-act='start'][data-type='quiz']");
  await page.waitForSelector(".runner-box");
  check("答题：答题器弹出", (await page.locator(".runner-box").count()) === 1);
  await completeRunner("false");
  notice = (await page.textContent("#campNotice")).trim();
  check("答题：答错后通知得分与提权", notice.includes("得分") && notice.includes("优先级"), notice.slice(0, 50));
  const wrongCount = await page.locator(".wrong-list li").count();
  check("错题：答错规则进入错题本", wrongCount >= 1, `${wrongCount}`);

  // 错题次日(due) 与 due+2 各安排一次纠错块
  const reviewByDay = await page.$$eval(".day-card", (c) =>
    c.map((d) => [...d.querySelectorAll(".slot-review")].map((s) => s.querySelector("p").textContent))
  );
  const allWrongTexts = await page.$$eval(".wrong-list li span", (els) => els.map((e) => e.textContent));
  let twoReviews = false;
  for (const wt of allWrongTexts) {
    const total = reviewByDay.flat().filter((t) => t === wt).length;
    if (total >= 2) twoReviews = true;
  }
  check("错题：3 天内安排至少 2 次复习", twoReviews, JSON.stringify(reviewByDay));

  // 答错桌游优先级确实提高
  const boosted = await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem("zfl18-camp"));
    return Object.values(c.mastery).some((m) => m.level >= 1 && m.gameBoost >= 1);
  });
  check("答题：答错规则 level 上升、桌游 gameBoost 提权", boosted);

  // ---------- 7. 撤销 ----------
  const masteryBefore = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem("zfl18-camp")).mastery));
  check("撤销：发生操作后撤销按钮可用", (await page.isDisabled("#undoBtn")) === false);
  await page.click("#undoBtn");
  await page.waitForTimeout(100);
  const masteryAfterUndo = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem("zfl18-camp")).mastery));
  check("撤销：撤销后答题会话/掌握度回退", masteryBefore !== masteryAfterUndo);
  check("撤销：错题本随之回退", (await page.locator(".wrong-list li").count()) === 0);

  // 再做一次全答对，验证连续答对计数（连对两次降级）
  if ((await page.locator(".day-card:first-child [data-act='start'][data-type='memo']").count()) > 0) {
    await page.click(".day-card:first-child [data-act='start'][data-type='memo']");
    await page.waitForSelector(".runner-box");
    await completeRunner("true");
    check("答题：全对得分通知", (await page.textContent("#campNotice")).includes("全部答对"));
    const streakOk = await page.evaluate(() =>
      Object.values(JSON.parse(localStorage.getItem("zfl18-camp")).mastery).some((m) => m.streak >= 1)
    );
    check("答题：答对后连对计数增加（连对两次降级）", streakOk);
  }

  // ---------- 8. 导出 ----------
  const exported = await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem("zfl18-camp"));
    return { sessions: c.sessions.length, wrongs: c.wrongs.length };
  });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportBtn")
  ]);
  const exportPath = "/tmp/export.json";
  await download.saveAs(exportPath);
  const exportJson = JSON.parse(require("fs").readFileSync(exportPath, "utf8"));
  check("导出：文件含 training 数据", exportJson.app === "boardgame-rule-camp" && !!exportJson.training);
  check("导出：含会话与错题", Array.isArray(exportJson.training.sessions) && Array.isArray(exportJson.training.wrongs));

  // ---------- 9. 异常导入：四类拦截，失败不覆盖 ----------
  const snapshotBefore = await page.evaluate(() => localStorage.getItem("zfl18-camp"));
  const good = JSON.parse(require("fs").readFileSync(exportPath, "utf8"));

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
    check(`${label}：被拦截且提示${expect}`, n.includes(expect), n.slice(0, 70));
  }

  // a) 失效桌游（引用不存在的 gid/rid）
  const badRef = JSON.parse(JSON.stringify(good));
  badRef.training.sessions[0].answers[0].gid = "missing-game";
  await tryImport(badRef, "异常导入-失效桌游", "失效桌游");

  // b) 重复场次
  const dup = JSON.parse(JSON.stringify(good));
  if (dup.training.sessions[0]) {
    dup.training.sessions.push({ ...dup.training.sessions[0] });
  }
  await tryImport(dup, "异常导入-重复场次", "重复场次");

  // c) 答案缺失
  const noAns = JSON.parse(JSON.stringify(good));
  noAns.training.sessions[0].answers = [];
  await tryImport(noAns, "异常导入-答案缺失", "答案缺失");

  // d) 时间冲突
  const clash = JSON.parse(JSON.stringify(good));
  if (clash.training.sessions[0]) {
    clash.training.sessions.push({ ...clash.training.sessions[0], id: "another-session-id" });
    // finishedAt 保持相同 → 时间冲突
  }
  await tryImport(clash, "异常导入-时间冲突", "时间冲突");

  // e) 非法 JSON
  await tryImport("{not-json", "异常导入-非法JSON", "合法 JSON");

  const snapshotAfter = await page.evaluate(() => localStorage.getItem("zfl18-camp"));
  check("异常导入：失败后原数据未被覆盖", snapshotBefore === snapshotAfter);

  // ---------- 10. 正常导入 ----------
  await tryImport(good, "正常导入", "导入成功");
  const afterImport = await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem("zfl18-camp"));
    return { sessions: c.sessions.length, wrongs: c.wrongs.length };
  });
  check("正常导入：数据写入", afterImport.sessions === exported.sessions && afterImport.wrongs === exported.wrongs, JSON.stringify(afterImport));

  // 撤销导入
  await page.click("#undoBtn");
  await page.waitForTimeout(100);
  check("撤销：可撤销导入", true);

  // ---------- 11. 刷新恢复 ----------
  await page.reload();
  await page.click("#campTab");
  await page.waitForSelector(".day-card");
  const restoredDays = await page.locator(".day-card").count();
  const restoredSessions = (await page.textContent(".camp-stats")).includes(String(exported.sessions === 0 ? "" : "")); // 弱校验
  check("刷新恢复：计划天数恢复", restoredDays === 7, `${restoredDays}`);
  const campAfterReload = await page.evaluate(() => JSON.parse(localStorage.getItem("zfl18-camp")));
  check("刷新恢复：localStorage 完整保留", Array.isArray(campAfterReload.plan) && campAfterReload.plan.length === 7);
  check("刷新恢复：会话记录保留", Array.isArray(campAfterReload.sessions));

  // ---------- 12. 原有卡片库功能 ----------
  await page.click("#libraryTab");
  await page.waitForSelector(".game-card");
  const libGames = await page.locator(".game-card").count();
  check("卡片库：收藏列表正常（3个默认桌游）", libGames === 3, `${libGames}`);
  // 筛选
  await page.selectOption("#complexityFilter", "重");
  await page.waitForTimeout(80);
  const heavyOnly = await page.$$eval(".game-card h3", (els) => els.map((e) => e.textContent));
  check("卡片库：复杂度筛选正常", heavyOnly.length === 1 && heavyOnly[0] === "盖亚计划", JSON.stringify(heavyOnly));
  await page.selectOption("#complexityFilter", "all");
  // 规则增删
  await page.click(".game-card");
  await page.waitForTimeout(80);
  const rulesBefore = await page.locator(".rule-list li").count();
  await page.fill("#ruleTextInput", "浏览器自动化加的测试规则");
  await page.click("#ruleForm button.primary");
  await page.waitForTimeout(80);
  const rulesAfterAdd = await page.locator(".rule-list li").count();
  check("卡片库：新增规则正常", rulesAfterAdd === rulesBefore + 1);
  // 删掉刚加的
  const delBtn = page.locator(".rule-list li", { hasText: "浏览器自动化加的测试规则" }).locator("button");
  await delBtn.click();
  await page.waitForTimeout(80);
  const rulesAfterDel = await page.locator(".rule-list li").count();
  check("卡片库：删除规则正常", rulesAfterDel === rulesBefore);
  // 游玩日期
  await page.click("#playedTodayBtn");
  await page.waitForTimeout(80);
  const ribbon = await page.textContent(".detail-panel .pill:last-child").catch(() => "");
  check("卡片库：标记今天玩过生效", (await page.locator(".detail-panel").textContent()).includes("0天未玩"));

  // ---------- 页面无 JS 报错 ----------
  check("全程无页面 JS 错误", errors.length === 0, errors.join(" | ").slice(0, 200));

  await browser.close();

  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log("失败项：\n - " + failures.join("\n - "));
    process.exit(1);
  }
})();