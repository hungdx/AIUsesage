// ===== Config mặc định (sửa qua trang Options, không sửa trực tiếp ở đây) =====
const DEFAULT_CONFIG = {
  endpointUrl: "https://cursor.com/api/usage-summary",
  codexEndpointUrl: "https://chatgpt.com/backend-api/wham/usage", // BẮT BUỘC điền: URL lấy được từ Network tab ở Phase 0
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

function extractCodexUsageData(json) {
  const primaryWindow = json.rate_limit?.primary_window ?? {};
  const usedPercent =
    typeof primaryWindow.used_percent === "number"
      ? primaryWindow.used_percent
      : Number.NaN;
  const resetSeconds =
    typeof primaryWindow.reset_at === "number"
      ? primaryWindow.reset_at
      : Number.NaN;

  return {
    percent: Number.isFinite(usedPercent) ? usedPercent : null,
    reset: Number.isFinite(resetSeconds)
      ? new Date(resetSeconds * 1000).toISOString()
      : null,
    planType: json.plan_type ?? null,
    raw: json,
  };
}

async function pushUsage(serverUrl, payload) {
  const response = await fetch(`${serverUrl}/api/updateUsages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) throw new Error(`Local server returned status ${response.status}`);
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

async function getCodexDeviceId() {
  const { codexDeviceId } = await chrome.storage.local.get("codexDeviceId");
  if (typeof codexDeviceId === "string" && codexDeviceId) return codexDeviceId;
  const deviceId = crypto.randomUUID();
  await chrome.storage.local.set({ codexDeviceId: deviceId });
  return deviceId;
}

function assertChatGptUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.origin !== "https://chatgpt.com") {
    throw new Error("Codex URL phải thuộc https://chatgpt.com");
  }
  return url.toString();
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error("Tab chatgpt.com tải quá lâu"));
      }, 20000);
      function onUpdated(id, info) {
        if (id === tabId && info.status === "complete") {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    }).catch((err) => reject(err));
  });
}

// Chạy trong trang chatgpt.com để request là same-origin, giống fetch đã bắt được.
// Token chỉ dùng trong trang, không trả về extension.
function codexUsageInPage(usageUrl, deviceId, knownAccessToken) {
  function accountIdOf(token) {
    try {
      const segment = String(token).split(".")[1];
      if (!segment) return null;
      const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
      const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
      return typeof accountId === "string" && accountId ? accountId : null;
    } catch {
      return null;
    }
  }

  return (async () => {
    let session = {};
    let accessToken = knownAccessToken || "";
    if (!accessToken) {
      const sessionRes = await fetch("https://chatgpt.com/api/auth/session", {
        method: "GET",
        credentials: "include",
        headers: { accept: "application/json" },
      });
      try {
        session = await sessionRes.json();
      } catch {
        session = {};
      }
      accessToken = session?.accessToken || "";
      if (!accessToken) {
        return {
          ok: false,
          hasToken: false,
          sessionStatus: sessionRes.status,
          sessionKeys: Object.keys(session || {}),
          error: "Tab chatgpt.com không trả accessToken",
        };
      }
    }

    let pageDeviceId = deviceId;
    try {
      pageDeviceId = localStorage.getItem("oai-did") || deviceId;
    } catch {
      pageDeviceId = deviceId;
    }

    const headers = {
      accept: "*/*",
      authorization: `Bearer ${accessToken}`,
      "oai-app-brand": "chatgpt",
      "oai-did": pageDeviceId,
      "oai-language": "en-US",
      originator: "Codex Browser",
      "x-openai-codex-pricing-chooser": "1",
      "x-openai-codex-window-type": "browser",
      "x-openai-web-frontend": "codex_webview",
    };
    const accountId = accountIdOf(accessToken);
    if (accountId) headers["chatgpt-account-id"] = accountId;

    const usageRes = await fetch(usageUrl, {
      method: "GET",
      credentials: "include",
      headers,
    });
    return {
      ok: usageRes.ok,
      hasToken: true,
      email: session?.user?.email ?? null,
      status: usageRes.status,
      body: await usageRes.text(),
    };
  })();
}

async function fetchCodexFromOpenPage(usageUrl, knownAccessToken) {
  const existing = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  let tabId = existing.find((tab) => tab.id != null)?.id ?? null;
  let createdId = null;
  if (tabId == null) {
    const created = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
    tabId = created.id;
    createdId = created.id;
  }
  if (tabId == null) throw new Error("Không mở được tab chatgpt.com");

  try {
    await waitForTabComplete(tabId);
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: codexUsageInPage,
      args: [usageUrl, await getCodexDeviceId(), knownAccessToken || ""],
    });
    const result = injected?.result;
    if (!result) throw new Error("Không chạy được script trên tab chatgpt.com");
    if (!result.hasToken) {
      const keys = result.sessionKeys?.length ? result.sessionKeys.join(", ") : "trống";
      throw new Error(`${result.error} (HTTP ${result.sessionStatus}, keys: ${keys})`);
    }
    if (!result.ok) {
      throw new Error(`Codex trong tab chatgpt.com: HTTP ${result.status}: ${snippet(result.body)}`);
    }
    return { json: JSON.parse(result.body), email: result.email ?? null };
  } finally {
    if (createdId != null) {
      try {
        await chrome.tabs.remove(createdId);
      } catch {
        // Tab tự đóng hoặc đã đóng.
      }
    }
  }
}

function snippet(body) {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "response rỗng";
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.detail === "string") return parsed.detail;
  } catch {
    // Giữ nguyên text bên dưới.
  }
  return text.slice(0, 180);
}

async function publishCodexUsage(codexJson, emailHint) {
  const config = await getConfig();
  console.log("[UsageTracker] Codex response:", codexJson);
  const codexUsage = extractCodexUsageData(codexJson);
  if (codexUsage.percent === null) {
    throw new Error("Codex response thiếu rate_limit.primary_window.used_percent");
  }

  const email = emailHint ?? codexJson.email ?? null;
  const user = email || config.user || "unknown";
  await pushUsage(config.serverUrl, {
    provider: "codex",
    user,
    email,
    percent: codexUsage.percent,
    reset: codexUsage.reset,
    membershipType: codexUsage.planType,
  });
  const status = {
    ok: true,
    user,
    email,
    percent: codexUsage.percent,
    reset: codexUsage.reset,
    message: `Cập nhật lúc ${new Date().toLocaleString("vi-VN")}`,
  };
  await chrome.storage.local.set({ lastCodexStatus: status });
  return status;
}

async function fetchCodexWithAccessToken(accessToken, emailHint) {
  const config = await getConfig();
  const usageUrl = assertChatGptUrl(config.codexEndpointUrl);
  const { json, email } = await fetchCodexFromOpenPage(usageUrl, accessToken);
  return publishCodexUsage(json, emailHint ?? email);
}

async function fetchCodexAndPush() {
  const config = await getConfig();
  if (!config.codexEndpointUrl) return { ok: false, message: "Chưa có Codex URL" };

  try {
    const usageUrl = assertChatGptUrl(config.codexEndpointUrl);
    const { json, email } = await fetchCodexFromOpenPage(usageUrl);
    return await publishCodexUsage(json, email);
  } catch (err) {
    console.error("[UsageTracker] Codex fetch/push failed:", err);
    const status = { ok: false, message: err.message };
    await chrome.storage.local.set({ lastCodexStatus: status });
    return status;
  }
}

async function fetchAllAndPush() {
  await Promise.all([fetchAndPush(), fetchCodexAndPush()]);
}

async function fetchAndPush() {
  const config = await getConfig();

  try {
    // credentials: "include" -> browser tự gắn cookie session cursor.com,
    // KHÔNG cần tự copy/lưu cookie tay
    const usageRes = await fetch(config.endpointUrl, {
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
        provider: "cursor",
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

chrome.runtime.onStartup.addListener(fetchAllAndPush);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) fetchAllAndPush();
});

// Cho popup/options gọi vào service worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "FETCH_NOW") {
    fetchAllAndPush().then(() => sendResponse({ done: true }));
    return true; // giữ kênh async mở cho sendResponse
  }
  if (message.type === "FETCH_CODEX") {
    fetchCodexAndPush().then((status) => sendResponse(status));
    return true;
  }
  if (message.type === "CODEX_WITH_TOKEN") {
    fetchCodexWithAccessToken(message.accessToken, message.email)
      .then((status) => sendResponse(status))
      .catch(async (err) => {
        const pageStatus = await fetchCodexAndPush();
        sendResponse({
          ...pageStatus,
          message: pageStatus.ok
            ? pageStatus.message
            : `${err.message}. Tab: ${pageStatus.message}`,
        });
      });
    return true;
  }
  if (message.type === "RESCHEDULE") {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: message.intervalMinutes });
    sendResponse({ done: true });
  }
});
