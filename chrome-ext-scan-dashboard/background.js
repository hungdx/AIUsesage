// ===== Config mặc định (sửa qua trang Options, không sửa trực tiếp ở đây) =====
const DEFAULT_CONFIG = {
  endpointUrl: "https://cursor.com/api/usage-summary", // BẮT BUỘC điền: URL lấy được từ Network tab ở Phase 0
  serverUrl: "http://localhost:3333",
  user: "hungfire",
  intervalMinutes: 10,
};

const ALARM_NAME = "cursor-usage-check";

async function getConfig() {
  return chrome.storage.sync.get(DEFAULT_CONFIG);
}

async function setStatus(status) {
  await chrome.storage.local.set({ lastStatus: status });
}

/**
 * Shape thật của response (xác nhận từ Network tab):
 * {
 *   billingCycleEnd: "2026-07-06T17:01:01.457Z",
 *   membershipType: "free",
 *   individualUsage: {
 *     plan: {
 *       autoPercentUsed: 76,
 *       apiPercentUsed: 100,
 *       totalPercentUsed: 75.5,   // <- số % tổng, khớp với dashboard
 *       breakdown: { included, bonus, total }
 *     }
 *   }
 * }
 */
function extractUsageData(json) {
  const plan = json.individualUsage?.plan ?? {};

  const percent = plan.totalPercentUsed ?? null;
  const reset = json.billingCycleEnd ?? null;

  if (percent === null || reset === null) {
    console.warn(
      "[CursorUsageTracker] Không lấy được totalPercentUsed/billingCycleEnd — Cursor có thể đã đổi response shape. Raw response:",
      json
    );
  }

  return {
    percent,
    reset,
    membershipType: json.membershipType ?? null,
    autoPercentUsed: plan.autoPercentUsed ?? null,
    apiPercentUsed: plan.apiPercentUsed ?? null,
    breakdown: plan.breakdown ?? null, // { included, bonus, total }
    raw: json,
  };
}

const AUTH_ME_URL = "https://cursor.com/api/auth/me";

/**
 * Lấy email thật từ tài khoản đang login, dùng làm "user" label
 * thay vì phải gõ tay trong Options. Nếu lỗi (chưa login, đổi shape...)
 * trả về null để fetchAndPush() fallback qua config.user.
 */
async function fetchUserEmail() {
  try {
    const res = await fetch(AUTH_ME_URL, {
      method: "GET",
      credentials: "include",
    });
    if (!res.ok) throw new Error(`auth/me trả về status ${res.status}`);
    const data = await res.json();
    return data.email ?? null;
  } catch (err) {
    console.warn("[CursorUsageTracker] Không lấy được email từ /api/auth/me, dùng fallback config.user:", err);
    return null;
  }
}

async function fetchAndPush() {
  const config = await getConfig();

  try {
    // credentials: "include" -> browser tự gắn cookie session cursor.com,
    // KHÔNG cần tự copy/lưu cookie tay
    const usageRes = await fetch(DEFAULT_CONFIG.endpointUrl, {
      method: "GET",
      credentials: "include",
    });

    if (!usageRes.ok) {
      throw new Error(`Cursor endpoint trả về status ${usageRes.status} (có thể chưa login hoặc URL sai)`);
    }

    const usageJson = await usageRes.json();
    const { percent, reset, membershipType, autoPercentUsed, apiPercentUsed, breakdown, raw } =
      extractUsageData(usageJson);

    // Lấy email thật làm user label; nếu fail thì fallback qua config.user
    const email = await fetchUserEmail();
    const user = email || config.user || "unknown";

    const pushRes = await fetch(`${config.serverUrl}/api/updateUsages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user,
        email,
        percent,
        reset,
        membershipType,
        autoPercentUsed,
        apiPercentUsed,
        breakdown,
        raw,
      }),
    });

    if (!pushRes.ok) {
      throw new Error(`Local server trả về status ${pushRes.status}`);
    }

    await setStatus({
      ok: true,
      message: `Cập nhật lúc ${new Date().toLocaleString("vi-VN")}`,
      user,
      email,
      percent,
      reset,
      autoPercentUsed,
      apiPercentUsed,
    });
  } catch (err) {
    console.error("[CursorUsageTracker] Fetch/push thất bại:", err);
    await setStatus({ ok: false, message: err.message });
  }
}

// ===== Lập lịch =====
chrome.runtime.onInstalled.addListener(async () => {
  const config = await getConfig();
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: config.intervalMinutes });
});

chrome.runtime.onStartup.addListener(fetchAndPush);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) fetchAndPush();
});

// Cho popup/options gọi vào service worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "FETCH_NOW") {
    fetchAndPush().then(() => sendResponse({ done: true }));
    return true; // giữ kênh async mở cho sendResponse
  }
  if (message.type === "RESCHEDULE") {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: message.intervalMinutes });
    sendResponse({ done: true });
  }
});
