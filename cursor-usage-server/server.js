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

  const totalPercentUsed = formatPercent(entry.totalPercentUsed ?? entry.percent);
  const autoPercentUsed = formatPercent(entry.autoPercentUsed);
  const apiPercentUsed = formatPercent(entry.apiPercentUsed);
  const percent = formatPercent(
    resolveMainPercent(totalPercentUsed, autoPercentUsed, apiPercentUsed)
  );

  const formatted = {
    ...entry,
    totalPercentUsed,
    percent,
    autoPercentUsed,
    apiPercentUsed,
  };

  const metrics = computeCycleMetrics(formatted.percent, formatted.reset);
  return metrics ? { ...formatted, ...metrics } : formatted;
}

// ===== Routes =====

// Extension gọi vào đây mỗi khi fetch xong
app.post("/api/updateUsages", (req, res) => {
  const {
    user,
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

  const totalPercentUsed = formatPercent(percent);
  const auto = formatPercent(autoPercentUsed);
  const api = formatPercent(apiPercentUsed);

  store[user] = {
    email: email ?? null,
    totalPercentUsed,
    percent: formatPercent(resolveMainPercent(totalPercentUsed, auto, api)),
    reset: reset ?? null,
    membershipType: membershipType ?? null,
    autoPercentUsed: auto,
    apiPercentUsed: api,
    breakdown: breakdown ?? null,
    updatedAt: new Date().toISOString(),
  };

  saveData(store);

  const enriched = enrichUsage(store[user]);
  const paceNote = enriched.isOverPace
    ? ` ⚠ vượt pace (${enriched.percent}% > ${enriched.allowedPercentNow}% cho phép)`
    : "";
  console.log(
    `[updateUsages] ${user}: ${enriched.percent}% (total ${totalPercentUsed}%, reset ${reset})${paceNote}`
  );
  res.json({ ok: true, user, data: enriched });
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
