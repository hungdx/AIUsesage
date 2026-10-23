import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "data.json");
const PORT = process.env.PORT || 3333;

const app = express();
app.use(cors()); // cho phép extension (chrome-extension://...) gọi vào
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== Persist đơn giản ra file JSON, load lại mỗi lần server start =====
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return {}; // chưa có file hoặc file lỗi -> bắt đầu rỗng
  }
}

function saveData(data) {
  fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), (err) => {
    if (err) console.error("[server] Lỗi ghi data.json:", err);
  });
}

let store = loadData();

const MS_PER_DAY = 86400000;
const RESET_BUFFER_DAYS = 10;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function formatPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Number(value).toFixed(2);
}

function toNum(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Number(value);
}

function normalizeProvider(value) {
  const provider = String(value ?? "cursor").trim().toLowerCase();
  return provider === "codex" ? "codex" : "cursor";
}

function getUsageKey(provider, user) {
  return `${provider}:${user}`;
}

function getLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isSameCycle(firstReset, secondReset) {
  if (firstReset == null || secondReset == null) {
    return firstReset === secondReset;
  }

  const firstTime = new Date(firstReset).getTime();
  const secondTime = new Date(secondReset).getTime();
  return Number.isNaN(firstTime) || Number.isNaN(secondTime)
    ? firstReset === secondReset
    : firstTime === secondTime;
}

function trackDailyUsage(previousEntry, currentPercent, reset, now) {
  const today = getLocalDateKey(now);
  const dailyUsage = {
    ...(previousEntry?.dailyUsagePercentByDate ?? {}),
  };

  if (currentPercent != null) {
    dailyUsage[today] ??= 0;
    dailyUsage[today] = toNum(dailyUsage[today]) ?? 0;

    const tracking = previousEntry?.dailyUsageTracking;
    let previousDate = tracking?.date;
    let previousPercent = toNum(tracking?.percent);
    let previousReset = tracking?.reset;

    if (!tracking && previousEntry?.updatedAt) {
      const previousUpdatedAt = new Date(previousEntry.updatedAt);
      if (!Number.isNaN(previousUpdatedAt.getTime())) {
        previousDate = getLocalDateKey(previousUpdatedAt);
        previousPercent = toNum(
          resolveMainPercent(
            previousEntry.totalPercentUsed ?? previousEntry.percent,
            previousEntry.autoPercentUsed,
            previousEntry.apiPercentUsed
          )
        );
        previousReset = previousEntry.reset;
      }
    }

    // Delta since the last sample belongs to today, including the first
    // sample after midnight. Requiring previousDate === today dropped that
    // usage, so a new day was saved as 0 and yesterday never received it.
    if (
      previousDate &&
      previousPercent != null &&
      currentPercent >= previousPercent &&
      isSameCycle(previousReset, reset)
    ) {
      dailyUsage[today] = round2(
        dailyUsage[today] + currentPercent - previousPercent
      );
    }
  }

  const oldestDate = new Date(now);
  oldestDate.setDate(oldestDate.getDate() - 365);
  const oldestDateKey = getLocalDateKey(oldestDate);
  for (const date of Object.keys(dailyUsage)) {
    if (date < oldestDateKey) delete dailyUsage[date];
  }

  return {
    dailyUsagePercentByDate: dailyUsage,
    dailyUsageTracking:
      currentPercent == null
        ? previousEntry?.dailyUsageTracking ?? null
        : { date: today, percent: currentPercent, reset },
  };
}

/** Nếu chỉ Auto hoặc chỉ API đang có usage, dùng nó làm % chính; không thì dùng total */
function resolveMainPercent(totalPercentUsed, autoPercentUsed, apiPercentUsed) {
  const auto = toNum(autoPercentUsed);
  const api = toNum(apiPercentUsed);
  const total = toNum(totalPercentUsed);

  const hasAuto = auto != null && auto > 0;
  const hasApi = api != null && api > 0;

  if (hasAuto && !hasApi) return auto;
  if (hasApi && !hasAuto) return api;
  return total;
}

/** billingCycleEnd = cuối chu kỳ; bắt đầu = cùng ngày tháng trước */
function getCycleBounds(resetIso) {
  const end = new Date(resetIso);
  if (Number.isNaN(end.getTime())) return null;

  const start = new Date(end);
  start.setMonth(start.getMonth() - 1);
  return { start, end };
}

function computeCycleMetrics(percent, resetIso, now = new Date()) {
  const bounds = getCycleBounds(resetIso);
  if (!bounds || percent == null || Number.isNaN(Number(percent))) {
    return null;
  }

  const usage = Number(percent);
  const { start, end } = bounds;
  const totalDays = Math.max((end - start) / MS_PER_DAY, 1);
  const elapsedDays = Math.min(
    Math.max((now - start) / MS_PER_DAY, 0),
    totalDays
  );
  const remainingDays = Math.max((end - now) / MS_PER_DAY, 0);
  const remainingPercent = Math.max(100 - usage, 0);

  const currentAvgPercent =
    elapsedDays > 0 ? usage / elapsedDays : usage;

  // Trải % còn lại trên số ngày trước vùng đệm 10 ngày cuối chu kỳ
  const budgetDays =
    remainingDays > RESET_BUFFER_DAYS
      ? remainingDays - RESET_BUFFER_DAYS
      : Math.max(remainingDays, 1);
  const allowedAvgPercent =
    usage >= 100 ? 0 : remainingPercent / budgetDays;

  const budgetTotalDays = Math.max(totalDays - RESET_BUFFER_DAYS, 1);
  const allowedPercentNow = Math.min(
    (elapsedDays / budgetTotalDays) * 100,
    100
  );

  const isOverPace =
    usage >= 100 ||
    (elapsedDays > 0 && currentAvgPercent > allowedAvgPercent);

  return {
    cycleStart: start.toISOString(),
    cycleEnd: end.toISOString(),
    elapsedDays: round2(elapsedDays),
    totalDays: round2(totalDays),
    remainingDays: round2(remainingDays),
    remainingPercent: round2(remainingPercent),
    currentAvgPercent: round2(currentAvgPercent),
    allowedAvgPercent: round2(allowedAvgPercent),
    allowedPercentNow: round2(allowedPercentNow),
    resetBufferDays: RESET_BUFFER_DAYS,
    isOverPace,
  };
}

function enrichUsage(entry) {
  if (!entry) return entry;

  const {
    dailyUsagePercentByDate = {},
    dailyUsageTracking: _dailyUsageTracking,
    ...publicEntry
  } = entry;
  const totalPercentUsed = formatPercent(entry.totalPercentUsed ?? entry.percent);
  const autoPercentUsed = formatPercent(entry.autoPercentUsed);
  const apiPercentUsed = formatPercent(entry.apiPercentUsed);
  const percent = formatPercent(
    resolveMainPercent(totalPercentUsed, autoPercentUsed, apiPercentUsed)
  );

  const formatted = {
    ...publicEntry,
    totalPercentUsed,
    percent,
    autoPercentUsed,
    apiPercentUsed,
  };

  const metrics = computeCycleMetrics(formatted.percent, formatted.reset);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return {
    ...formatted,
    ...(metrics ?? {}),
    yesterdayUsagePercent: dailyUsagePercentByDate[getLocalDateKey(yesterday)] ?? null,
    todayUsagePercent: dailyUsagePercentByDate[getLocalDateKey(now)] ?? null,
  };
}

// ===== Routes =====

// Extension gọi vào đây mỗi khi fetch xong
app.post("/api/updateUsages", (req, res) => {
  const {
    user,
    provider: requestedProvider = "cursor",
    email,
    percent,
    reset,
    membershipType,
    autoPercentUsed,
    apiPercentUsed,
    breakdown,
  } = req.body ?? {};

  if (!user) {
    return res.status(400).json({ error: "Thiếu field 'user' trong body" });
  }

  const provider = normalizeProvider(requestedProvider);

  const totalPercentUsed = formatPercent(percent);
  const auto = formatPercent(autoPercentUsed);
  const api = formatPercent(apiPercentUsed);

  const updatedAt = new Date();
  const mainPercent = formatPercent(
    resolveMainPercent(totalPercentUsed, auto, api)
  );
  const usageKey = getUsageKey(provider, user);
  // Older Cursor records used the bare user name as their key. Reuse that
  // record on its first provider-aware update so history is retained.
  const legacyCursorEntry = provider === "cursor" ? store[user] : undefined;
  const previousEntry = store[usageKey] ?? legacyCursorEntry;
  const dailyUsage = trackDailyUsage(
    previousEntry,
    toNum(mainPercent),
    reset ?? null,
    updatedAt
  );

  store[usageKey] = {
    user,
    provider,
    email: email ?? null,
    totalPercentUsed,
    percent: mainPercent,
    reset: reset ?? null,
    membershipType: membershipType ?? null,
    autoPercentUsed: auto,
    apiPercentUsed: api,
    breakdown: breakdown ?? null,
    updatedAt: updatedAt.toISOString(),
    ...dailyUsage,
  };

  if (legacyCursorEntry && usageKey !== user) {
    delete store[user];
  }

  saveData(store);

  const enriched = enrichUsage(store[usageKey]);
  const paceNote = enriched.isOverPace
    ? ` ⚠ vượt pace (${enriched.percent}% > ${enriched.allowedPercentNow}% cho phép)`
    : "";
  console.log(
    `[updateUsages] ${provider}:${user}: ${enriched.percent}% (total ${totalPercentUsed}%, reset ${reset})${paceNote}`
  );
  res.json({ ok: true, user, provider, data: enriched });
});

// Lấy toàn bộ data (dashboard dùng cái này)
app.get("/api/usages", (_req, res) => {
  const enriched = Object.fromEntries(
    Object.entries(store).map(([user, entry]) => [user, enrichUsage(entry)])
  );
  res.json(enriched);
});

// Lấy data của 1 user cụ thể
app.get("/api/usages/:user", (req, res) => {
  const data = store[req.params.user];
  if (!data) return res.status(404).json({ error: "Không tìm thấy user này" });
  res.json(enrichUsage(data));
});

app.listen(PORT, () => {
  console.log(`Cursor usage server đang chạy tại http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
});
