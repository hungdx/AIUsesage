document.addEventListener("DOMContentLoaded", async () => {
  await render();

  document.getElementById("fetchNow").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Đang fetch...";
    await chrome.runtime.sendMessage({ type: "FETCH_NOW" });
    await render();
    e.target.disabled = false;
    e.target.textContent = "Fetch now";
  });

  document.getElementById("testToken").addEventListener("click", async (e) => {
    e.target.disabled = true;
    const el = document.getElementById("tokenTest");
    el.className = "muted";
    el.textContent = "Đang lấy session từ popup...";
    try {
      const res = await fetch("https://chatgpt.com/api/auth/session", {
        method: "GET",
        credentials: "include",
        headers: { accept: "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      const accessToken = data?.accessToken;
      const hasToken = typeof accessToken === "string" && accessToken.length > 0;
      const keys = Object.keys(data || {}).join(", ") || "trống";

      if (!hasToken) {
        el.textContent = `Popup: không có token (HTTP ${res.status}, keys: ${keys}).`;
        el.className = "muted error";
        return;
      }

      const config = await chrome.storage.sync.get({
        codexEndpointUrl: "https://chatgpt.com/backend-api/wham/usage",
        serverUrl: "http://localhost:3333",
        user: "hungfire",
      });
      const deviceId = await getCodexDeviceId();
      el.textContent = "Popup: có token. Đang gọi usage từ trang chatgpt.com...";
      const pageResult = await fetchCodexOnChatGptTab(config.codexEndpointUrl, accessToken, deviceId);
      if (!pageResult?.ok) {
        const detail = snippet(pageResult?.body);
        el.textContent = `Popup có token. Usage trong tab: HTTP ${pageResult?.status ?? "?"} — ${detail}`;
        el.className = "muted error";
        await chrome.storage.local.set({
          lastCodexStatus: { ok: false, message: `HTTP ${pageResult?.status ?? "?"}: ${detail}` },
        });
        return;
      }

      const usage = JSON.parse(pageResult.body);
      const parsed = readCodexUsage(usage);
      const email = data?.user?.email ?? null;
      await publishCodexFromPopup(config, email, parsed);
      el.textContent = `Usage ${parsed.percent}%`;
      el.className = "muted ok";
    } catch (err) {
      el.textContent = `Test lỗi: ${err.message}`;
      el.className = "muted error";
    } finally {
      await render();
      e.target.disabled = false;
    }
  });

  document.getElementById("openOptions").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});

async function render() {
  const { lastStatus, lastCodexStatus } = await chrome.storage.local.get([
    "lastStatus",
    "lastCodexStatus",
  ]);
  const codexEl = document.getElementById("codexStatus");
  if (!lastCodexStatus) {
    codexEl.textContent = "Codex: chưa fetch";
  } else if (lastCodexStatus.ok) {
    codexEl.textContent = `Codex: ${lastCodexStatus.percent}%`;
    codexEl.className = "muted ok";
  } else {
    codexEl.textContent = `Codex: ${lastCodexStatus.message}`;
    codexEl.className = "muted error";
  }
  const userLabelEl = document.getElementById("userLabel");
  const percentEl = document.getElementById("percent");
  const breakdownEl = document.getElementById("breakdown");
  const resetEl = document.getElementById("reset");
  const statusEl = document.getElementById("status");

  if (!lastStatus) {
    statusEl.textContent = "Chưa fetch lần nào";
    return;
  }

  percentEl.textContent = lastStatus.percent != null ? `${lastStatus.percent}%` : "--%";
  userLabelEl.textContent = lastStatus.email || lastStatus.user || "";

  const parts = [];
  if (lastStatus.autoPercentUsed != null) parts.push(`Auto ${lastStatus.autoPercentUsed}%`);
  if (lastStatus.apiPercentUsed != null) parts.push(`API ${lastStatus.apiPercentUsed}%`);
  breakdownEl.textContent = parts.join(" · ");

  resetEl.textContent = `reset: ${formatReset(lastStatus.reset)}`;
  statusEl.textContent = lastStatus.ok ? lastStatus.message : `Lỗi: ${lastStatus.message}`;
  statusEl.className = `muted ${lastStatus.ok ? "ok" : "error"}`;
}

async function getCodexDeviceId() {
  const { codexDeviceId } = await chrome.storage.local.get("codexDeviceId");
  if (typeof codexDeviceId === "string" && codexDeviceId) return codexDeviceId;
  const deviceId = crypto.randomUUID();
  await chrome.storage.local.set({ codexDeviceId: deviceId });
  return deviceId;
}

function snippet(body) {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "response rỗng";
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.detail === "string") return parsed.detail;
  } catch {
    // Giữ text gốc.
  }
  return text.slice(0, 180);
}

function readCodexUsage(json) {
  const windowUsage = json?.rate_limit?.primary_window ?? {};
  const percent = typeof windowUsage.used_percent === "number" ? windowUsage.used_percent : null;
  const reset = typeof windowUsage.reset_at === "number"
    ? new Date(windowUsage.reset_at * 1000).toISOString()
    : null;
  return { percent, reset, planType: json?.plan_type ?? null };
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

function codexUsageInPage(usageUrl, deviceId, accessToken) {
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

  return fetch(usageUrl, { method: "GET", credentials: "include", headers }).then(async (usageRes) => ({
    ok: usageRes.ok,
    status: usageRes.status,
    body: await usageRes.text(),
  }));
}

async function fetchCodexOnChatGptTab(usageUrl, accessToken, deviceId) {
  if (!chrome.scripting?.executeScript) {
    throw new Error("Chưa có quyền scripting. Vào chrome://extensions, bấm Reload, rồi thử lại.");
  }
  const url = new URL(usageUrl);
  if (url.origin !== "https://chatgpt.com") {
    throw new Error("Codex URL phải thuộc https://chatgpt.com");
  }

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
      args: [url.toString(), deviceId, accessToken],
    });
    if (!injected?.result) throw new Error("Không chạy được script trên tab chatgpt.com");
    return injected.result;
  } finally {
    if (createdId != null) {
      try {
        await chrome.tabs.remove(createdId);
      } catch {
        // Tab đã đóng.
      }
    }
  }
}

async function publishCodexFromPopup(config, email, parsed) {
  if (parsed.percent === null) {
    throw new Error("Response không có rate_limit.primary_window.used_percent");
  }
  const user = email || config.user || "unknown";
  const response = await fetch(`${config.serverUrl}/api/updateUsages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "codex",
      user,
      email,
      percent: parsed.percent,
      reset: parsed.reset,
      membershipType: parsed.planType,
    }),
  });
  if (!response.ok) throw new Error(`Local server HTTP ${response.status}`);
  await chrome.storage.local.set({
    lastCodexStatus: {
      ok: true,
      user,
      email,
      percent: parsed.percent,
      reset: parsed.reset,
      message: `Cập nhật lúc ${new Date().toLocaleString("vi-VN")}`,
    },
  });
}

function formatReset(iso) {
  if (!iso) return "--";
  try {
    return new Date(iso).toLocaleDateString("vi-VN");
  } catch {
    return iso;
  }
}
