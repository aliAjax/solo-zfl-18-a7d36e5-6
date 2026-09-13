/* 规则记忆训练营：计划生成 / 调度约束 / 答题 / 错题复习 / 撤销 / 导入导出 */
(function () {
  "use strict";

  const CAMP_VERSION = 1;
  const MAX_UNDO = 30;
  const REST_EVERY = 4; // 每 4 天一个轻量休息日
  const focusLabels = {
    forgets: "容易忘的规则",
    disputes: "常见争议",
    setup: "开局准备",
    scoring: "计分提醒"
  };

  // ---------- 工具 ----------
  const $ = (selector, root = document) => root.querySelector(selector);
  const uid = () => crypto.randomUUID();

  function addDays(iso, n) {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() + n);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function todayIso() {
    // 必须取本地日期：toISOString() 是 UTC，上海凌晨会落到前一天
    const d = new Date();
    return localIso(d);
  }

  function localIso(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function daysBetween(a, b) {
    return Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
  }

  function daysSince(dateString) {
    return Math.max(0, daysBetween(dateString, todayIso()));
  }

  function esc(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  const getGame = (gid) => state.games.find((g) => g.id === gid);

  function getRule(gid, rid) {
    const game = getGame(gid);
    if (!game) return null;
    for (const cat of ruleCategories) {
      const rule = game[cat].find((r) => r.id === rid);
      if (rule) return { game, category: cat, ...rule };
    }
    return null;
  }

  function allRuleRefs() {
    const refs = [];
    for (const game of state.games) {
      for (const category of ruleCategories) {
        for (const rule of game[category]) refs.push({ gid: game.id, rid: rule.id, category });
      }
    }
    return refs;
  }

  function refExists(gid, rid) {
    const game = getGame(gid);
    return !!game && ruleCategories.some((cat) => game[cat].some((r) => r.id === rid));
  }

  // ---------- 训练营状态 ----------
  const defaultConfig = () => ({
    playerCount: 3,
    focus: ["forgets", "disputes"],
    perDay: 4,
    days: 7,
    startDate: todayIso()
  });

  const defaultCamp = () => ({
    version: CAMP_VERSION,
    config: defaultConfig(),
    plan: [],
    sessions: [],
    mastery: {},
    wrongs: [],
    seen: [],
    dayOverrides: {}
  });

  let camp = null;
  const undoStack = [];
  let notice = { type: "", text: "" };
  let runner = null; // 当前进行中的答题会话

  function loadCamp() {
    const saved = localStorage.getItem("zfl18-camp");
    if (!saved) return defaultCamp();
    try {
      const parsed = { ...defaultCamp(), ...JSON.parse(saved) };
      parsed.config = { ...defaultConfig(), ...(parsed.config || {}) };
      // 数字配置类型/范围清洗，防止手工损坏的存档导致排程异常
      if (!Number.isFinite(parsed.config.playerCount)) parsed.config.playerCount = defaultConfig().playerCount;
      if (!Number.isFinite(parsed.config.perDay) || parsed.config.perDay < 1) parsed.config.perDay = defaultConfig().perDay;
      if (!Number.isFinite(parsed.config.days) || parsed.config.days < 1) parsed.config.days = defaultConfig().days;
      if (!Array.isArray(parsed.config.focus) || !parsed.config.focus.length ||
          !parsed.config.focus.every((f) => ruleCategories.includes(f))) {
        parsed.config.focus = ["forgets", "disputes"];
      }
      if (!isIsoDate(parsed.config.startDate)) parsed.config.startDate = defaultConfig().startDate;
      for (const key of ["plan", "sessions", "wrongs", "seen"]) {
        if (!Array.isArray(parsed[key])) parsed[key] = [];
      }
      for (const key of ["mastery", "dayOverrides"]) {
        if (!parsed[key] || typeof parsed[key] !== "object") parsed[key] = {};
      }
      return parsed;
    } catch {
      return defaultCamp();
    }
  }

  function saveCamp() {
    localStorage.setItem("zfl18-camp", JSON.stringify(camp));
  }

  function snapshot() {
    undoStack.push(
      JSON.stringify({
        config: camp.config,
        plan: camp.plan,
        sessions: camp.sessions,
        mastery: camp.mastery,
        wrongs: camp.wrongs,
        seen: camp.seen,
        dayOverrides: camp.dayOverrides
      })
    );
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    updateUndoButton();
  }

  function undo() {
    const prev = undoStack.pop();
    if (!prev) return;
    Object.assign(camp, JSON.parse(prev));
    runner = null;
    notice = { type: "ok", text: "已撤销上一步操作。" };
    saveCamp();
    renderCamp();
  }

  function updateUndoButton() {
    const btn = $("#undoBtn");
    if (btn) btn.disabled = undoStack.length === 0;
  }

  // ---------- 优先级 ----------
  const levelOf = (rid) => camp.mastery[rid]?.level ?? 0;
  const wrongCountOf = (rid) => camp.wrongs.filter((w) => w.rid === rid).length;
  const boostOf = (gid) =>
    Object.values(camp.mastery).reduce((sum, m) => sum + (m.gid === gid ? m.gameBoost || 0 : 0), 0);

  // 答错桌游整体提权，连对降级；错题次数越多越靠前
  function rulePriority(ref) {
    const game = getGame(ref.gid);
    const stale = game ? daysSince(game.lastPlayed) : 0;
    const activeWrong = camp.wrongs.some((w) => w.rid === ref.rid) ? 2 : 0;
    return levelOf(ref.rid) * 100 + activeWrong * 40 + wrongCountOf(ref.rid) * 12 + boostOf(ref.gid) * 8 + stale;
  }

  // ---------- 计划生成 ----------
  function eligibleRefs() {
    const { playerCount, focus } = camp.config;
    return allRuleRefs().filter((ref) => {
      const game = getGame(ref.gid);
      if (!game) return false;
      if (playerCount < game.minPlayers || playerCount > game.maxPlayers) return false;
      if (!focus.includes(ref.category)) return false;
      return true;
    });
  }

  function ruleName(gid, rid) {
    const rule = getRule(gid, rid);
    if (!rule) return "已删除规则";
    return `${rule.game.name}·${rule.text.slice(0, 12)}`;
  }

  /**
   * 重排计划。
   * - locked / 已完成的整天保留原内容
   * - 其它天沿用每天独立的换题 pin/ban 与停一天设置
   * 约束：同款桌游不连续两天出现；错题在 due 与 due+2 各复习一次（3 天内 2 次）
   */
  function buildPlan(overrides = {}) {
    const warnings = [];
    const cfg = camp.config;
    const { days, perDay, startDate } = cfg;

    const oldPlan = Array.isArray(camp.plan) ? camp.plan : [];
    const oldByDate = new Map(oldPlan.map((d) => [d.date, d]));
    const savedOverrides = camp.dayOverrides || {};
    const newOverrides = {};

    const memoTarget = Math.max(1, Math.ceil(perDay / 2));
    const quizTarget = Math.max(1, perDay - memoTarget);

    // 错题复习到期表：due 与 due+2 两天各一次
    const dueTable = new Map();
    const pushDue = (date, w) => {
      if (!dueTable.has(date)) dueTable.set(date, []);
      if (!dueTable.get(date).some((x) => x.rid === w.rid)) dueTable.get(date).push(w);
    };
    for (const w of camp.wrongs) {
      pushDue(w.due, w);
      pushDue(addDays(w.due, 2), w);
      if (w.due < startDate) pushDue(startDate, w); // 已逾期：开营首日补练
    }

    const seenSet = new Set(camp.seen);
    const plan = [];
    let prevPractice = new Set(); // 前一天速记/问答用过的桌游（纠错块豁免同款连用）

    for (let i = 0; i < days; i++) {
      const date = addDays(startDate, i);
      const old = oldByDate.get(date);
      const override = { ...(savedOverrides[date] || {}), ...overrides };
      newOverrides[date] = override;

      // 已完成或被锁定的日程原样保留
      if (old && (old.locked || old.completed)) {
        plan.push(old);
        prevPractice = new Set((old.slots || []).filter((s) => s.type !== "review").map((s) => s.gid));
        continue;
      }

      // 重排未完成天时保留“已练”标记
      const doneRids = new Set((old?.slots || []).filter((s) => s.done).map((s) => s.rid));
      const skipped = override.skipped === true;
      const isRestDay = (i + 1) % REST_EVERY === 0;
      const day = {
        date,
        locked: false,
        skipped,
        completed: false,
        slots: [],
        restNote: isRestDay
          ? "轻量休息日：新题减半，以错题巩固为主。"
          : "完成全部训练后休息 5 分钟，再回顾一遍错题。",
        warnings: []
      };

      if (skipped) {
        day.restNote = "已停一天：本日不安排训练，其它天顺延重排。";
        plan.push(day);
        prevPractice = new Set();
        continue;
      }

      const pins = override.pins || {};
      const bans = override.bans || {};
      // 纠错优先占用当天题量，余下容量再分给速记/问答；休息日新题减半
      const reviewCapRaw = Math.min(perDay, (dueTable.get(date) || []).filter((w) => refExists(w.gid, w.rid)).length);
      const remainingForNew = perDay - reviewCapRaw;
      const ratioMemo = memoTarget / Math.max(1, memoTarget + quizTarget);
      let memoCap = isRestDay ? Math.floor(memoTarget / 2) : memoTarget;
      let quizCap = isRestDay ? Math.floor(quizTarget / 2) : quizTarget;
      memoCap = Math.max(0, Math.min(memoCap, Math.ceil(remainingForNew * ratioMemo)));
      quizCap = Math.max(0, Math.min(quizCap, remainingForNew - memoCap));
      // 普通日仍有富余容量时补回速记；休息日刻意减量，保留休息时间
      if (!isRestDay && memoCap + quizCap < remainingForNew) {
        memoCap = Math.min(memoTarget, memoCap + remainingForNew - memoCap - quizCap);
      }

      // 速记候选：全新规则优先铺开；都学完后再做高优先级巩固
      const freshMemoRefs = (gid) =>
        eligibleRefs()
          .filter((ref) => (!gid || ref.gid === gid) && !seenSet.has(ref.rid))
          .sort((a, b) => rulePriority(b) - rulePriority(a));
      const reviewMemoRefs = (gid) =>
        eligibleRefs()
          .filter((ref) => (!gid || ref.gid === gid) && seenSet.has(ref.rid))
          .sort((a, b) => rulePriority(b) - rulePriority(a));

      // 问答候选：已学规则优先；未学规则也可“先回忆再看答案”，错题除外
      const quizRefs = (gid) =>
        eligibleRefs()
          .filter((ref) => (!gid || ref.gid === gid) && !camp.wrongs.some((w) => w.rid === ref.rid))
          .sort(
            (a, b) =>
              Number(seenSet.has(b.rid)) - Number(seenSet.has(a.rid)) ||
              rulePriority(b) - rulePriority(a)
          );

      // 每天主打一个桌游：综合规则最高优先级与未学规则覆盖度选游戏，且不与前一天同款
      const gameScore = (gid) => {
        const top = Math.max(0, ...eligibleRefs().filter((ref) => ref.gid === gid).map((ref) => rulePriority(ref)));
        const unseen = eligibleRefs().filter((ref) => ref.gid === gid && !seenSet.has(ref.rid)).length;
        return top + unseen * 50; // 未学规则多的游戏优先，避免长期被冷落
      };
      const eligibleGameIds = [...new Set(eligibleRefs().map((ref) => ref.gid))];
      let dayGame =
        eligibleGameIds
          .filter((gid) => !prevPractice.has(gid))
          .sort((a, b) => gameScore(b) - gameScore(a))[0] ||
        eligibleGameIds.sort((a, b) => gameScore(b) - gameScore(a))[0];

      function place(type, capacity) {
        // bans 统一为 {gid,rid} 对象数组，兼容旧版纯规则 ID 字符串
        const banned = new Set((bans[type] || []).map((b) => (typeof b === "string" ? b : b.rid)));
        let pinCursor = 0;
        const pinList = pins[type] || [];

        const supply = () => {
          if (type === "review") {
            const due = dueTable.get(date) || [];
            return due
              .map((w) => ({ ref: { gid: w.gid, rid: w.rid }, wrong: w }))
              .filter((x) => refExists(x.ref.gid, x.ref.rid))
              .filter((x) => !day.slots.some((s) => s.type === "review" && s.rid === x.ref.rid))
              .sort((a, b) => daysSince(b.wrong.due) - daysSince(a.wrong.due));
          }
          if (type === "memo") {
            // 只在当天主打游戏内安排：未学规则优先，耗尽后巩固该游戏旧规则（间隔重复）
            const pool = freshMemoRefs(dayGame).length ? freshMemoRefs(dayGame) : reviewMemoRefs(dayGame);
            return pool.map((ref) => ({ ref }));
          }
          return quizRefs(dayGame).map((ref) => ({ ref }));
        };

        let placed = 0;
        let relaxed = false;
        while (placed < capacity) {
          // pin 优先（换题后固定下来的题）
          if (pinCursor < pinList.length) {
            const pin = pinList[pinCursor++];
            if (banned.has(pin.rid) || !refExists(pin.gid, pin.rid)) continue;
            if (day.slots.some((s) => s.rid === pin.rid && s.type === type)) continue;
            if (type !== "review" && prevPractice.has(pin.gid)) {
              warnings.push(`${date} 锁定的“${type === "memo" ? "速记" : "问答"}”题与前一天同款桌游冲突，已尽量保留。`);
            }
            day.slots.push({ type, gid: pin.gid, rid: pin.rid, pinned: true, done: doneRids.has(pin.rid) });
            if (type !== "review") seenSet.add(pin.rid);
            placed++;
            continue;
          }

          // 速记块同一天不重复同一规则；问答块可复用当天速记刚学的规则
          const available = supply().filter(
            (x) =>
              !banned.has(x.ref.rid) &&
              !day.slots.some((s) => s.rid === x.ref.rid && (type === "memo" || s.type === type))
          );

          let choice = null;
          if (type === "review") {
            // 纠错块为强制复习，豁免同款连用
            choice = available[0];
          } else {
            // 主打游戏优先，其次任意非前日游戏，最后才被迫连用
            choice =
              available.find((x) => x.ref.gid === dayGame) ||
              available.find((x) => !prevPractice.has(x.ref.gid)) ||
              available[0];
            if (choice && prevPractice.has(choice.ref.gid)) relaxed = true;
          }

          if (!choice) {
            if (placed === 0 && type !== "review") {
              day.warnings.push(type === "memo" ? "没有可安排的速记规则，先在收藏库补充规则或调整重点。" : "没有可问答的规则，先在收藏库补充规则或调整重点。");
            }
            break;
          }
          day.slots.push({
            type,
            gid: choice.ref.gid,
            rid: choice.ref.rid,
            done: doneRids.has(choice.ref.rid),
            forced: type !== "review" && relaxed && prevPractice.has(choice.ref.gid)
          });
          if (type !== "review") seenSet.add(choice.ref.rid);
          placed++;
        }
        if (relaxed && type !== "review") {
          warnings.push(`${date} 的“${type === "memo" ? "速记" : "问答"}”受题库所限，同款桌游连续两天出现。`);
        }
      }

      // 纠错优先占用：到期错题必须排进当天
      const dueToday = dueTable.get(date) || [];
      const reviewNeed = new Set(
        dueToday.filter((w) => refExists(w.gid, w.rid)).map((w) => w.rid)
      ).size;
      place("review", reviewNeed);
      place("memo", memoCap);
      place("quiz", quizCap);

      // 槽位顺序：速记 → 问答 → 纠错
      const order = { memo: 0, quiz: 1, review: 2 };
      day.slots.sort((a, b) => order[a.type] - order[b.type]);

      // 时间不足：到期错题挤占了计划中的新题
      if (reviewCapRaw > 0 && memoCap + quizCap < memoTarget + quizTarget) {
        warnings.push(`${date} 到期错题 ${reviewCapRaw} 道叠加计划题量，当天时间不足，新题已让位给错题复习。`);
      }

      plan.push(day);
      prevPractice = new Set(day.slots.filter((s) => s.type !== "review").map((s) => s.gid));
    }

    // 错题 3 天 2 次约束：逐日核对到期日是否真的排上
    for (const w of camp.wrongs) {
      if (!refExists(w.gid, w.rid)) continue;
      for (const targetDate of [w.due, addDays(w.due, 2)]) {
        const idx = daysBetween(startDate, targetDate);
        if (idx < 0 || idx >= days) {
          if (targetDate <= addDays(startDate, days - 1)) {
            warnings.push(`错题「${ruleName(w.gid, w.rid)}」的复习日 ${targetDate} 已在窗口外，建议提前开始日期或手动加练。`);
          }
          continue;
        }
        const targetDay = plan[idx];
        if (targetDay.skipped) {
          warnings.push(`${targetDate} 停一天，错题「${ruleName(w.gid, w.rid)}」复习顺延，请尽快补练。`);
          continue;
        }
        if (!targetDay.slots.some((s) => s.type === "review" && s.rid === w.rid)) {
          warnings.push(`${targetDate} 时间不足，错题「${ruleName(w.gid, w.rid)}」排不进去，3 天 2 次复习无法保证，请降低题量或延长天数。`);
        }
      }
    }

    // 覆盖度提示：窗口内学不完的重点规则
    const remaining = eligibleRefs().filter((ref) => !seenSet.has(ref.rid));
    if (remaining.length) {
      const needDays = Math.ceil(remaining.length / Math.max(1, memoTarget));
      warnings.push(`按当前题量，${remaining.length} 条重点规则还需约 ${needDays} 天才能覆盖，时间不足可提高每日题量或延长可用天数。`);
    }

    camp.plan = plan;
    camp.seen = [...seenSet];
    camp.dayOverrides = newOverrides;
    return warnings;
  }

  function regenerate(opts = {}) {
    const warnings = buildPlan(opts.overrides || {});
    saveCamp();
    if (campViewActive()) renderCamp();
    if (opts.notice !== false) {
      notice = warnings.length
        ? { type: "warn", text: `计划已立即重排。${warnings.join(" ")}` }
        : { type: "ok", text: "计划已立即重排，时间安排充足。" };
      renderNotice();
    }
  }

  function campViewActive() {
    return !$("#campView")?.hidden;
  }

  // ---------- 答题会话与得分 ----------
  function startSession(date, type) {
    const day = camp.plan.find((d) => d.date === date);
    if (!day || day.skipped) return;
    const slots = day.slots.filter((s) => s.type === type && !s.done);
    if (!slots.length) {
      notice = { type: "warn", text: "当天这类题已经练完。" };
      renderCamp();
      return;
    }
    runner = { date, type, slots, index: 0, answers: [], reveal: false, graded: false, lastOk: null };
    renderCamp();
  }

  function answer(ok) {
    if (!runner || !runner.reveal || runner.graded) return;
    const slot = runner.slots[runner.index];
    runner.answers.push({ gid: slot.gid, rid: slot.rid, ok });
    runner.graded = true;
    runner.lastOk = ok;
    renderCamp();
  }

  function nextQuestion() {
    if (!runner) return;
    runner.index++;
    runner.reveal = false;
    runner.graded = false;
    runner.lastOk = null;
    if (runner.index >= runner.slots.length) finishSession();
    else renderCamp();
  }

  function quitSession() {
    runner = null;
    renderCamp();
  }

  function finishSession() {
    if (!runner) return;
    const { date, type, answers } = runner;
    if (!answers.length) {
      runner = null;
      return;
    }
    snapshot();

    const score = Math.round((answers.filter((a) => a.ok).length / answers.length) * 100);
    camp.sessions.push({
      id: uid(),
      date,
      type,
      finishedAt: new Date().toISOString(),
      answers
    });

    for (const a of answers) {
      const prev = camp.mastery[a.rid] || { gid: a.gid, level: 0, streak: 0, gameBoost: 0 };
      prev.gid = a.gid;
      if (a.ok) {
        prev.streak += 1;
        if (prev.streak >= 2) {
          // 连续答对再降级
          prev.level = Math.max(0, prev.level - 1);
          prev.streak = 0;
        }
        prev.gameBoost = Math.max(0, (prev.gameBoost || 0) - 1);
        // 纠错块答对：累计一次复习，满 2 次销账
        if (type === "review") {
          const w = camp.wrongs.find((x) => x.rid === a.rid);
          if (w) {
            w.times = (w.times || 0) + 1;
            if (w.times >= 2) camp.wrongs.splice(camp.wrongs.indexOf(w), 1);
          }
        }
      } else {
        prev.streak = 0;
        prev.level = Math.min(5, prev.level + 1); // 答错提高后续优先级
        prev.gameBoost = Math.min(5, (prev.gameBoost || 0) + 1); // 整张桌游提权
        const existing = camp.wrongs.find((w) => w.rid === a.rid);
        if (existing) {
          existing.due = addDays(date, 1); // 再次答错，复习节奏从头开始
          existing.times = 0;
        } else {
          // 次日起到期：due 与 due+2 各复习一次
          camp.wrongs.push({ id: uid(), gid: a.gid, rid: a.rid, due: addDays(date, 1), times: 0 });
        }
      }
      camp.mastery[a.rid] = prev;
    }

    const doneRids = new Set(answers.map((a) => a.rid));
    const day = camp.plan.find((d) => d.date === date);
    if (day) {
      for (const s of day.slots) if (doneRids.has(s.rid)) s.done = true;
      if (day.slots.length && day.slots.every((s) => s.done)) day.completed = true;
    }

    const wrongCount = answers.filter((a) => !a.ok).length;
    runner = null;
    const warnings = buildPlan();
    saveCamp();
    renderCamp();
    notice = wrongCount
      ? { type: "warn", text: `本组得分 ${score} 分：${wrongCount} 道答错的桌游已提高优先级并进错题本，次日起 3 天内复习 2 次。${warnings.join(" ")}` }
      : { type: "ok", text: `本组得分 ${score} 分，全部答对；连续答对的规则已降级。` };
    renderNotice();
  }

  // ---------- 计划操作：换题 / 锁定 / 停一天 ----------
  function swapQuestion(date, type, index) {
    if (type === "review") {
      notice = { type: "warn", text: "错题不能换掉：错题必须在 3 天内复习 2 次。" };
      renderCamp();
      return;
    }
    const day = camp.plan.find((d) => d.date === date);
    if (!day || day.locked || day.completed || day.skipped) return;
    const group = day.slots.filter((s) => s.type === type);
    const slot = group[index];
    if (!slot) return;

    snapshot();
    const overrides = camp.dayOverrides[date] || {};
    const pins = { ...(overrides.pins || {}) };
    const bans = { ...(overrides.bans || {}) };
    pins[type] = [...(pins[type] || [])];
    bans[type] = [...(bans[type] || [])];

    if (slot.pinned) {
      const pos = pins[type].findIndex((p) => p.rid === slot.rid);
      if (pos >= 0) pins[type].splice(pos, 1);
    }
    bans[type].push({ gid: slot.gid, rid: slot.rid });

    const slotGid = slot.gid;
    const supply =
      type === "memo"
        ? (() => {
            const fresh = eligibleRefs()
              .filter((ref) => !camp.seen.includes(ref.rid))
              .sort((a, b) => rulePriority(b) - rulePriority(a));
            return fresh.length
              ? fresh
              : eligibleRefs().sort((a, b) => rulePriority(b) - rulePriority(a));
          })()
        : eligibleRefs()
            .filter((ref) => !camp.wrongs.some((w) => w.rid === ref.rid))
            .sort(
              (a, b) =>
                Number(camp.seen.includes(b.rid)) - Number(camp.seen.includes(a.rid)) ||
                rulePriority(b) - rulePriority(a)
            );

    const prevPractice = new Set(
      (camp.plan.find((d) => d.date === addDays(date, -1))?.slots || [])
        .filter((s) => s.type !== "review")
        .map((s) => s.gid)
    );
    const usedToday = new Set(day.slots.map((s) => s.rid));
    const banned = new Set((bans[type] || []).map((b) => (typeof b === "string" ? b : b.rid)));
    const usable = (ref) => !banned.has(ref.rid) && !usedToday.has(ref.rid) && !prevPractice.has(ref.gid);
    // 优先在同一款桌游内换题，保持当日主打游戏不变
    let pick = supply.find((ref) => ref.gid === slotGid && usable(ref)) || supply.find(usable);
    if (!pick) {
      pick = supply.find((ref) => ref.gid === slotGid && !banned.has(ref.rid) && !usedToday.has(ref.rid)) ||
        supply.find((ref) => !banned.has(ref.rid) && !usedToday.has(ref.rid));
    }

    if (!pick) {
      undoStack.pop();
      updateUndoButton();
      notice = { type: "warn", text: "没有可替换的题目：题库已用完，请先在收藏库补充规则或调整重点分类。" };
      renderCamp();
      return;
    }

    const globalIndex = day.slots.indexOf(slot);
    day.slots.splice(globalIndex, 1, { type, gid: pick.gid, rid: pick.rid, pinned: true });
    pins[type].push({ gid: pick.gid, rid: pick.rid });
    if (type === "memo" && !camp.seen.includes(pick.rid)) camp.seen.push(pick.rid);
    camp.dayOverrides[date] = { ...overrides, pins, bans };

    const warnings = buildPlan();
    saveCamp();
    renderCamp();
    notice = warnings.length
      ? { type: "warn", text: `已换题并固定，计划立即重排。${warnings.join(" ")}` }
      : { type: "ok", text: "已换题并固定，其它未锁定日已同步重排。" };
    renderNotice();
  }

  function toggleLock(date) {
    const day = camp.plan.find((d) => d.date === date);
    if (!day || day.skipped || day.completed) return;
    snapshot();
    day.locked = !day.locked;
    camp.dayOverrides[date] = { ...(camp.dayOverrides[date] || {}), locked: day.locked };
    const warnings = buildPlan();
    saveCamp();
    renderCamp();
    notice = day.locked
      ? { type: "ok", text: `${date} 日程已锁定，重排不会改动这一天。` }
      : { type: "warn", text: `${date} 已解锁并参与重新排程。${warnings.join(" ")}` };
    renderNotice();
  }

  function toggleSkip(date) {
    const day = camp.plan.find((d) => d.date === date);
    if (!day || day.completed) return;
    snapshot();
    const skipped = !day.skipped;
    camp.dayOverrides[date] = { ...(camp.dayOverrides[date] || {}), skipped };
    const warnings = buildPlan();
    saveCamp();
    renderCamp();
    notice = skipped
      ? { type: "warn", text: `${date} 已停一天，计划立即重排，错题复习会绕开这一天。${warnings.join(" ")}` }
      : { type: "warn", text: `${date} 已恢复训练，计划立即重排。${warnings.join(" ")}` };
    renderNotice();
  }

  // ---------- 导出 / 导入 ----------
  function exportData() {
    const payload = {
      app: "boardgame-rule-camp",
      version: CAMP_VERSION,
      exportedAt: new Date().toISOString(),
      training: {
        config: camp.config,
        plan: camp.plan,
        sessions: camp.sessions,
        mastery: camp.mastery,
        wrongs: camp.wrongs,
        seen: camp.seen,
        dayOverrides: camp.dayOverrides
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rule-camp-${todayIso()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notice = { type: "ok", text: "训练营数据已导出（含会话、得分与错题）。" };
    renderNotice();
  }

  function isObj(v) {
    return v && typeof v === "object" && !Array.isArray(v);
  }

  const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
  const isBool = (v) => typeof v === "boolean";
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  // 严格日期：YYYY-MM-DD 且必须是真实存在的日期（拒绝 2026-02-30 等）
  function isIsoDate(v) {
    if (!isNonEmptyString(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split("-").map(Number);
    const dt = new Date(`${v}T00:00:00`);
    return !Number.isNaN(dt) && dt.getFullYear() === y && dt.getMonth() + 1 === m && dt.getDate() === d;
  }

  /**
   * 严格结构校验：缺字段、类型错误、结构不完整、引用失效、重复/冲突都会被拦截。
   * 只有返回空数组时才允许写入，保证任何失败都不覆盖原数据。
   */
  function validateImport(payload) {
    const errors = [];
    if (!isObj(payload) || payload.app !== "boardgame-rule-camp") {
      return ["文件格式不正确：不是本应用导出的训练营文件（缺少标识 app）。"];
    }
    // 导出契约：version 是必需字段
    if (!("version" in payload)) errors.push("结构不完整：缺少顶层字段「version」。");
    else if (!isNum(payload.version)) errors.push("类型错误：顶层字段「version」必须是数字。");

    const t = payload.training;
    if (!isObj(t)) {
      return ["文件结构不完整：缺少 training 数据对象。"];
    }

    // ---------- training 必需键：逐项核对，缺失即报字段名 ----------
    const requiredArrays = ["plan", "sessions", "wrongs", "seen"];
    for (const key of requiredArrays) {
      if (!(key in t)) errors.push(`结构不完整：缺少「${key}」数组。`);
      else if (!Array.isArray(t[key])) errors.push(`类型错误：「${key}」必须是数组。`);
    }
    for (const key of ["config", "mastery", "dayOverrides"]) {
      if (!(key in t)) errors.push(`结构不完整：缺少「${key}」对象。`);
      else if (!isObj(t[key])) errors.push(`类型错误：「${key}」必须是对象。`);
    }
    if (errors.length) return [...new Set(errors)]; // 结构都不完整时，后续逐项检查没有意义

    // ---------- config ----------
    const cfg = t.config;
    if (!isObj(cfg)) {
      errors.push("结构不完整：config 不是对象。");
    } else {
      for (const key of ["playerCount", "perDay", "days"]) {
        if (!(key in cfg)) errors.push(`配置缺失：没有「${key}」字段。`);
        else if (!isNum(cfg[key])) errors.push(`配置类型错误：「${key}」必须是数字。`);
      }
      if (isNum(cfg.playerCount) && !(cfg.playerCount >= 1 && cfg.playerCount <= 12)) errors.push("配置：人数必须在 1-12 之间。");
      if (isNum(cfg.perDay) && !(cfg.perDay >= 1 && cfg.perDay <= 50)) errors.push("配置：每日题量必须在 1-50 之间。");
      if (isNum(cfg.days) && !(cfg.days >= 1 && cfg.days <= 365)) errors.push("配置：可用天数必须在 1-365 之间。");
      if (!("focus" in cfg)) errors.push("配置缺失：没有「focus」重点分类。");
      else if (!Array.isArray(cfg.focus) || !cfg.focus.length || !cfg.focus.every((f) => typeof f === "string")) {
        errors.push("配置类型错误：「focus」必须是非空字符串数组。");
      } else if (!cfg.focus.every((f) => ruleCategories.includes(f))) {
        errors.push("配置：重点分类包含无效值。");
      }
      if (!("startDate" in cfg)) errors.push("配置缺失：没有「startDate」开始日期。");
      else if (!isIsoDate(cfg.startDate)) errors.push("配置：开始日期不是有效日期（应为 YYYY-MM-DD 且真实存在）。");
    }

    // ---------- sessions：缺数组已在前面拦截，这里逐项严格检查 ----------
    const sessionIds = new Set();
    const timestamps = [];
    t.sessions.forEach((s, i) => {
      const where = `场次#${i + 1}`;
      if (!isObj(s)) return errors.push(`${where}：必须是对象。`);
      if (!isNonEmptyString(s.id)) errors.push(`${where}：缺少或无效的场次 ID。`);
      else if (sessionIds.has(s.id)) errors.push(`${where}：重复场次（ID ${s.id}）。`);
      sessionIds.add(s.id);
      if (!isIsoDate(s.date)) errors.push(`${where}：训练日期缺失或不是有效日期。`);
      const ts = new Date(s.finishedAt).getTime();
      if (!isNonEmptyString(s.finishedAt) || Number.isNaN(ts)) {
        errors.push(`${where}：完成时间 finishedAt 缺失或无法解析。`);
      } else {
        if (timestamps.some((x) => Math.abs(ts - x) < 60000)) {
          errors.push(`${where}：与其它场次时间冲突（完成时间间隔不足 1 分钟）。`);
        }
        timestamps.push(ts);
      }
      if (!["memo", "quiz", "review"].includes(s.type)) errors.push(`${where}：训练类型 type 缺失或无效。`);
      if (!Array.isArray(s.answers)) {
        errors.push(`${where}：答案缺失（answers 必须是数组）。`);
      } else if (s.answers.length === 0) {
        errors.push(`${where}：答案缺失（没有任何答题记录）。`);
      } else {
        s.answers.forEach((a, k) => {
          const at = `${where} 第${k + 1}题`;
          if (!isObj(a)) return errors.push(`${at}：必须是对象。`);
          if (!isNonEmptyString(a.gid) || !isNonEmptyString(a.rid)) {
            errors.push(`${at}：答案缺少 gid/rid 标识。`);
          } else if (!refExists(a.gid, a.rid)) {
            errors.push(`${at}：引用了失效桌游或已删除规则（${ruleName(a.gid, a.rid)}）。`);
          }
          if (!isBool(a.ok)) errors.push(`${at}：判分 ok 必须是布尔值 true/false。`);
        });
      }
    });

    // ---------- plan ----------
    const planDates = new Set();
    t.plan.forEach((d, i) => {
      const where = `计划第${i + 1}天`;
      if (!isObj(d)) return errors.push(`${where}：必须是对象。`);
      if (!isIsoDate(d.date)) errors.push(`${where}：日期缺失或不是有效日期。`);
      else if (planDates.has(d.date)) errors.push(`${where}：计划日期 ${d.date} 重复（时间冲突）。`);
      planDates.add(d.date);
      for (const key of ["locked", "skipped", "completed"]) {
        if (key in d && !isBool(d[key])) errors.push(`${where}：${key} 必须是布尔值。`);
      }
      if (!Array.isArray(d.slots)) {
        errors.push(`${where}：slots 必须是数组。`);
      } else {
        d.slots.forEach((slot, k) => {
          const at = `${where} 第${k + 1}题`;
          if (!isObj(slot)) return errors.push(`${at}：必须是对象。`);
          if (!["memo", "quiz", "review"].includes(slot.type)) errors.push(`${at}：题型 type 缺失或无效。`);
          if (!isNonEmptyString(slot.gid) || !isNonEmptyString(slot.rid)) {
            errors.push(`${at}：缺少 gid/rid 标识。`);
          } else if (!refExists(slot.gid, slot.rid)) {
            errors.push(`${at}：引用了失效桌游或已删除规则（${ruleName(slot.gid, slot.rid)}）。`);
          }
          for (const key of ["done", "pinned", "forced"]) {
            if (key in slot && !isBool(slot[key])) errors.push(`${at}：${key} 必须是布尔值。`);
          }
        });
      }
    });

    // ---------- wrongs ----------
    t.wrongs.forEach((w, i) => {
      const where = `错题#${i + 1}`;
      if (!isObj(w)) return errors.push(`${where}：必须是对象。`);
      if (!isNonEmptyString(w.id)) errors.push(`${where}：缺少错题 ID。`);
      if (!isNonEmptyString(w.gid) || !isNonEmptyString(w.rid)) {
        errors.push(`${where}：缺少 gid/rid 标识。`);
      } else if (!refExists(w.gid, w.rid)) {
        errors.push(`${where}：引用了失效桌游或已删除规则（${ruleName(w.gid, w.rid)}）。`);
      }
      if (!isIsoDate(w.due)) errors.push(`${where}：到期日期 due 缺失或不是有效日期。`);
      if ("times" in w && !isNum(w.times)) errors.push(`${where}：复习次数 times 必须是数字。`);
    });

    // ---------- mastery ----------
    for (const [rid, m] of Object.entries(t.mastery)) {
      if (!isObj(m)) {
        errors.push(`掌握度记录 ${String(rid).slice(0, 8)}：必须是对象。`);
        continue;
      }
      if (!isNonEmptyString(m.gid)) errors.push(`掌握度记录 ${String(rid).slice(0, 8)}：缺少 gid。`);
      else if (!refExists(m.gid, rid)) errors.push(`掌握度记录：引用了失效桌游或已删除规则（${ruleName(m.gid, rid)}）。`);
      for (const key of ["level", "streak", "gameBoost"]) {
        if (key in m && !isNum(m[key])) errors.push(`掌握度记录 ${String(rid).slice(0, 8)}：${key} 必须是数字。`);
      }
    }

    // ---------- seen ----------
    t.seen.forEach((rid, i) => {
      if (!isNonEmptyString(rid)) {
        errors.push(`已学记录第${i + 1}项：必须是非空字符串规则 ID。`);
        return;
      }
      const exists = state.games.some((g) => ruleCategories.some((cat) => g[cat].some((r) => r.id === rid)));
      if (!exists) errors.push(`已学记录：引用了已删除规则（${rid.slice(0, 8)}…）。`);
    });

    // ---------- dayOverrides ----------
    if (isObj(t.dayOverrides)) {
      for (const [date, ov] of Object.entries(t.dayOverrides)) {
        const where = `日程覆盖 ${date}`;
        if (!isObj(ov)) {
          errors.push(`${where}：必须是对象。`);
          continue;
        }
        for (const key of ["skipped", "locked"]) {
          if (key in ov && !isBool(ov[key])) errors.push(`${where}：${key} 必须是布尔值。`);
        }
        for (const key of ["pins", "bans"]) {
          if (!(key in ov)) continue;
          if (!isObj(ov[key])) {
            errors.push(`${where}：${key} 必须是对象。`);
            continue;
          }
          for (const [type, list] of Object.entries(ov[key])) {
            if (!["memo", "quiz", "review"].includes(type)) {
              errors.push(`${where}：${key} 含未知题型 ${type}。`);
            }
            if (!Array.isArray(list)) {
              errors.push(`${where}：${key}.${type} 必须是数组。`);
              continue;
            }
            list.forEach((p, k) => {
              if (key === "bans" && typeof p === "string") return; // 兼容旧版纯规则 ID
              if (!isObj(p) || !isNonEmptyString(p.gid) || !isNonEmptyString(p.rid)) {
                errors.push(`${where}：${key}.${type} 第${k + 1}项缺少 gid/rid。`);
              }
            });
          }
        }
      }
    }

    return [...new Set(errors)];
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let payload;
      try {
        payload = JSON.parse(reader.result);
      } catch {
        notice = { type: "warn", text: "导入失败：文件不是合法 JSON，原数据未改动。" };
        renderNotice();
        return;
      }
      const errors = validateImport(payload);
      if (errors.length) {
        const shown = errors.slice(0, 5).join("；");
        notice = {
          type: "warn",
          text: `导入被拦截（共 ${errors.length} 个问题），原数据未改动：${shown}${errors.length > 5 ? `；等 ${errors.length} 个问题。` : "。"}`
        };
        renderNotice();
        return;
      }
      // 全部通过：先存撤销点再原子替换。深拷贝，避免文件对象与内存状态共享引用
      snapshot();
      const t = payload.training;
      camp = {
        version: CAMP_VERSION,
        config: { ...defaultConfig(), ...structuredClone(t.config) },
        plan: structuredClone(t.plan),
        sessions: structuredClone(t.sessions),
        mastery: structuredClone(t.mastery),
        wrongs: structuredClone(t.wrongs),
        seen: structuredClone(t.seen),
        dayOverrides: isObj(t.dayOverrides) ? structuredClone(t.dayOverrides) : {}
      };
      runner = null;
      saveCamp();
      notice = { type: "ok", text: `导入成功：${camp.sessions.length} 场会话、${camp.wrongs.length} 条错题已恢复，可随时撤销。` };
      renderCamp();
    };
    reader.onerror = () => {
      notice = { type: "warn", text: "读取文件失败，原数据未改动。" };
      renderNotice();
    };
    reader.readAsText(file);
  }

  // ---------- 收藏库变更：清理悬挂引用并重排 ----------
  function pruneTraining() {
    if (!camp) return false;
    let changed = false;

    const sessionsBefore = camp.sessions.length;
    camp.sessions = camp.sessions
      .map((s) => ({ ...s, answers: (s.answers || []).filter((a) => refExists(a.gid, a.rid)) }))
      .filter((s) => s.answers.length > 0);
    if (camp.sessions.length !== sessionsBefore) changed = true;

    const wrongsBefore = camp.wrongs.length;
    camp.wrongs = camp.wrongs.filter((w) => refExists(w.gid, w.rid));
    if (camp.wrongs.length !== wrongsBefore) changed = true;

    const seenBefore = camp.seen.length;
    camp.seen = camp.seen.filter((rid) => state.games.some((g) => ruleCategories.some((cat) => g[cat].some((r) => r.id === rid))));
    if (camp.seen.length !== seenBefore) changed = true;

    for (const [rid, m] of Object.entries(camp.mastery)) {
      if (!refExists(m.gid, rid)) {
        delete camp.mastery[rid];
        changed = true;
      }
    }
    for (const day of camp.plan || []) {
      const before = day.slots?.length || 0;
      day.slots = (day.slots || []).filter((s) => refExists(s.gid, s.rid));
      if (day.slots.length !== before) changed = true;
    }
    if (changed) saveCamp();
    return changed;
  }

  window.appHooks.onDataChanged = () => {
    if (!camp) return;
    const pruned = pruneTraining();
    const warnings = buildPlan();
    saveCamp();
    if (campViewActive()) {
      renderCamp();
      if (pruned) {
        notice = { type: "warn", text: `收藏库变动后，引用失效规则的错题/场次已清理，计划已重排。${warnings.join(" ")}` };
        renderNotice();
      }
    }
  };

  // ---------- 渲染 ----------
  function dayScore(day) {
    const sessions = camp.sessions.filter((s) => s.date === day.date);
    if (!sessions.length) return null;
    const all = sessions.flatMap((s) => s.answers);
    return Math.round((all.filter((a) => a.ok).length / all.length) * 100);
  }

  const typeLabel = { memo: "速记", quiz: "问答", review: "纠错" };

  function renderSlot(slot, day, typeIndex) {
    const rule = getRule(slot.gid, slot.rid);
    if (!rule) return "";
    const locked = day.locked || day.completed;
    const canSwap = !locked && !day.skipped && slot.type !== "review";
    const swapBtn = canSwap
      ? `<button type="button" class="mini" data-act="swap" data-date="${day.date}" data-type="${slot.type}" data-index="${typeIndex}">换题</button>`
      : "";
    const badges = [
      slot.done ? `<span class="badge done">已练</span>` : "",
      slot.forced ? `<span class="badge forced" title="受题库限制，同款桌游连续出现">同款连用</span>` : "",
      slot.type === "review" ? `<span class="badge review">错题</span>` : ""
    ].join("");
    return `
      <li class="slot slot-${slot.type}">
        <div class="slot-main">
          <span class="slot-type">${typeLabel[slot.type]}</span>
          <strong>${esc(rule.game.name)}</strong>
          <p>${esc(rule.text)}</p>
        </div>
        <div class="slot-actions">${badges}${swapBtn}</div>
      </li>`;
  }

  function renderDay(day, index) {
    const score = dayScore(day);
    const locked = day.locked || day.completed;
    const slotsHtml = ["memo", "quiz", "review"]
      .map((type) => {
        const group = day.slots.filter((s) => s.type === type);
        return group.map((s, gi) => renderSlot(s, day, gi)).join("");
      })
      .join("");

    const startable = ["memo", "quiz", "review"]
      .filter((type) => day.slots.some((s) => s.type === type && !s.done))
      .map((type) => `<button type="button" class="primary mini" data-act="start" data-date="${day.date}" data-type="${type}">练${typeLabel[type]}</button>`)
      .join("");

    const warningsHtml = day.warnings.length ? `<p class="day-warn">${esc(day.warnings.join(" "))}</p>` : "";
    const restHtml = day.restNote ? `<p class="rest-note">☕ ${esc(day.restNote)}</p>` : "";

    return `
      <article class="day-card ${day.skipped ? "skipped" : ""} ${locked ? "locked" : ""}">
        <header class="day-head">
          <div>
            <span class="day-no">第 ${index + 1} 天</span>
            <span class="day-date">${day.date}</span>
          </div>
          <div class="day-badges">
            ${score === null ? "" : `<span class="badge score">${score}分</span>`}
            ${day.completed ? '<span class="badge done">完成</span>' : ""}
            ${day.locked && !day.completed ? '<span class="badge lock">已锁定</span>' : ""}
            ${day.skipped ? '<span class="badge skip">停一天</span>' : ""}
          </div>
        </header>
        ${day.skipped ? "" : `<ul class="slots">${slotsHtml || "<li class='empty-slot'>本日无题。</li>"}</ul>`}
        ${warningsHtml}
        ${restHtml}
        ${day.completed ? "" : `
        <footer class="day-foot">
          ${day.skipped ? "" : `<div class="start-row">${startable}</div>`}
          <div class="lock-row">
            <button type="button" class="mini" data-act="lock" data-date="${day.date}" ${day.skipped ? "disabled" : ""}>${day.locked ? "解锁" : "锁日程"}</button>
            <button type="button" class="mini" data-act="skip" data-date="${day.date}">${day.skipped ? "恢复训练" : "停一天"}</button>
          </div>
        </footer>`}
      </article>`;
  }

  function renderRunner() {
    if (!runner) return "";
    const slot = runner.slots[runner.index];
    const rule = getRule(slot.gid, slot.rid);
    if (!rule) return "";
    const total = runner.slots.length;

    let body;
    if (runner.type === "memo") {
      body = `
        <p class="runner-prompt">先快速记住下面这条，再自评：</p>
        <div class="runner-rule">${esc(rule.text)}</div>
        <p class="runner-sub">${esc(rule.game.name)} · ${focusLabels[rule.category]}</p>
        ${
          runner.reveal
            ? runner.graded
              ? `<p class="runner-feedback ${runner.lastOk ? "ok" : "bad"}">${runner.lastOk ? "已记录：记住了" : "已记录：没记住，进错题本"}</p>
                 <button type="button" class="primary" data-act="next">${runner.index + 1 < total ? "下一题" : "结束本组"}</button>`
              : `<div class="runner-grade">
                   <button type="button" class="primary" data-act="grade" data-ok="true">记住了 ✓</button>
                   <button type="button" data-act="grade" data-ok="false">没记住 ✗</button>
                 </div>`
            : `<button type="button" class="primary" data-act="reveal">自评答题</button>`
        }`;
    } else {
      body = `
        <p class="runner-prompt">${runner.type === "review" ? "错题巩固" : "遮住答案回忆"}：这条规则是什么？</p>
        <div class="runner-rule runner-hidden">${esc(rule.game.name)} · ${focusLabels[rule.category]}</div>
        ${
          runner.reveal
            ? `<div class="runner-answer">${esc(rule.text)}</div>
               ${
                 runner.graded
                   ? `<p class="runner-feedback ${runner.lastOk ? "ok" : "bad"}">${runner.lastOk ? "已记录：答对" : "已记录：答错，桌游提权"}</p>
                      <button type="button" class="primary" data-act="next">${runner.index + 1 < total ? "下一题" : "结束本组"}</button>`
                   : `<div class="runner-grade">
                        <button type="button" class="primary" data-act="grade" data-ok="true">答对 ✓</button>
                        <button type="button" data-act="grade" data-ok="false">答错 ✗</button>
                      </div>`
               }`
            : `<button type="button" class="primary" data-act="reveal">显示正确答案</button>`
        }`;
    }

    return `
      <div class="runner-mask">
        <div class="runner-box" role="dialog" aria-modal="true">
          <header>
            <span>${typeLabel[runner.type]}训练 · 第 ${runner.index + 1}/${total} 题</span>
            <button type="button" class="mini" data-act="quit">退出（不计分）</button>
          </header>
          ${body}
        </div>
      </div>`;
  }

  function renderWrongBook() {
    if (!camp.wrongs.length) {
      return `<p class="empty">还没有错题。答错的规则会进这里，次日起 3 天内安排至少 2 次复习。</p>`;
    }
    const rows = [...camp.wrongs]
      .sort((a, b) => daysSince(b.due) - daysSince(a.due))
      .map((w) => {
        const rule = getRule(w.gid, w.rid);
        if (!rule) return "";
        const overdue = daysSince(w.due);
        return `
          <li>
            <div>
              <strong>${esc(rule.game.name)}</strong>
              <span>${esc(rule.text)}</span>
            </div>
            <em class="${overdue > 0 ? "overdue" : ""}">到期 ${w.due}${overdue > 0 ? `（逾期${overdue}天）` : ""} · 已复习${w.times || 0}/2</em>
          </li>`;
      })
      .join("");
    return `<ul class="wrong-list">${rows}</ul>`;
  }

  function renderStats() {
    const answers = camp.sessions.flatMap((s) => s.answers);
    const accuracy = answers.length ? Math.round((answers.filter((a) => a.ok).length / answers.length) * 100) : null;
    const mastered = Object.values(camp.mastery).filter((m) => m.level === 0).length;
    return `
      <div class="stat"><span>训练场次</span><strong>${camp.sessions.length}</strong></div>
      <div class="stat"><span>总正确率</span><strong>${accuracy === null ? "-" : accuracy + "%"}</strong></div>
      <div class="stat"><span>错题待复习</span><strong>${camp.wrongs.length}</strong></div>
      <div class="stat"><span>已降级规则</span><strong>${mastered}</strong></div>`;
  }

  function renderNotice() {
    const el = $("#campNotice");
    if (!el) return;
    el.className = `notice ${notice.type}`;
    el.textContent = notice.text || "";
    el.hidden = !notice.text;
  }

  function renderCamp() {
    if (!$("#campView")) return;
    $("#campStats").innerHTML = renderStats();
    $("#planBoard").innerHTML =
      (camp.plan || []).map(renderDay).join("") || `<p class="empty">点击“生成/重排计划”开始。</p>`;
    $("#wrongBook").innerHTML = renderWrongBook();
    $("#runnerHost").innerHTML = renderRunner();
    $("#playerCountInput").value = camp.config.playerCount;
    $("#perDayInput").value = camp.config.perDay;
    $("#daysInput").value = camp.config.days;
    $("#startDateInput").value = camp.config.startDate;
    for (const cb of document.querySelectorAll(".focus-check")) {
      cb.checked = camp.config.focus.includes(cb.value);
    }
    renderNotice();
    updateUndoButton();
  }

  // ---------- 配置与事件 ----------
  function applyConfigAndBuild() {
    const focus = [...document.querySelectorAll(".focus-check:checked")].map((cb) => cb.value);
    if (!focus.length) {
      notice = { type: "warn", text: "至少选择一个重点分类，计划未改动。" };
      renderNotice();
      renderCamp();
      return;
    }
    camp.config = {
      playerCount: Number($("#playerCountInput").value),
      focus,
      perDay: Number($("#perDayInput").value),
      days: Number($("#daysInput").value),
      startDate: $("#startDateInput").value
    };
    const warnings = buildPlan();
    notice = warnings.length
      ? { type: "warn", text: `计划已按新设置立即重排。${warnings.join(" ")}` }
      : { type: "ok", text: "计划已按新设置立即重排，时间安排充足。" };
    saveCamp();
    renderCamp();
  }

  function bindCamp() {
    $("#libraryTab").addEventListener("click", () => switchTab("library"));
    $("#campTab").addEventListener("click", () => switchTab("camp"));

    $("#buildPlanBtn").addEventListener("click", applyConfigAndBuild);
    for (const id of ["playerCountInput", "perDayInput", "daysInput", "startDateInput"]) {
      $("#" + id).addEventListener("change", applyConfigAndBuild);
    }
    document.querySelectorAll(".focus-check").forEach((cb) => cb.addEventListener("change", applyConfigAndBuild));

    $("#planBoard").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-act]");
      if (!btn) return;
      const { act, date, type, index } = btn.dataset;
      if (act === "start") startSession(date, type);
      if (act === "lock") toggleLock(date);
      if (act === "skip") toggleSkip(date);
      if (act === "swap") swapQuestion(date, type, Number(index));
    });

    $("#runnerHost").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-act]");
      if (!btn || !runner) return;
      if (btn.dataset.act === "quit") quitSession();
      if (btn.dataset.act === "reveal") {
        runner.reveal = true;
        renderCamp();
      }
      if (btn.dataset.act === "grade") answer(btn.dataset.ok === "true");
      if (btn.dataset.act === "next") nextQuestion();
    });

    $("#undoBtn").addEventListener("click", undo);
    $("#exportBtn").addEventListener("click", exportData);
    $("#importBtn").addEventListener("click", () => $("#importFile").click());
    $("#importFile").addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (file) importData(file);
      event.target.value = "";
    });
  }

  function switchTab(name) {
    const isCamp = name === "camp";
    $("#libraryView").hidden = isCamp;
    $("#campView").hidden = !isCamp;
    $("#libraryTab").classList.toggle("active", !isCamp);
    $("#campTab").classList.toggle("active", isCamp);
    if (isCamp) renderCamp();
  }

  // ---------- 启动 ----------
  document.addEventListener("DOMContentLoaded", () => {
    camp = loadCamp();
    pruneTraining();
    // 刷新恢复：有旧计划直接恢复展示；首次使用自动生成
    if (!camp.plan || !camp.plan.length) {
      buildPlan();
      notice = { type: "", text: "" };
    }
    saveCamp();
    bindCamp();
    updateUndoButton();
  });
})();