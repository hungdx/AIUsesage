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

  document.getElementById("openOptions").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});

async function render() {
  const { lastStatus } = await chrome.storage.local.get("lastStatus");
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

function formatReset(iso) {
  if (!iso) return "--";
  try {
    return new Date(iso).toLocaleDateString("vi-VN");
  } catch {
    return iso;
  }
}
