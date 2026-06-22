const DEFAULT_CONFIG = {
  endpointUrl: "https://cursor.com/api/usage-summary",
  serverUrl: "http://localhost:3333",
  user: "hungfire",
  intervalMinutes: 10,
};

document.addEventListener("DOMContentLoaded", async () => {
  const config = await chrome.storage.sync.get(DEFAULT_CONFIG);
  document.getElementById("endpointUrl").value = config.endpointUrl;
  document.getElementById("serverUrl").value = config.serverUrl;
  document.getElementById("user").value = config.user;
  document.getElementById("intervalMinutes").value = config.intervalMinutes;

  document.getElementById("save").addEventListener("click", async () => {
    const newConfig = {
      endpointUrl: document.getElementById("endpointUrl").value.trim(),
      serverUrl: document.getElementById("serverUrl").value.trim() || DEFAULT_CONFIG.serverUrl,
      user: document.getElementById("user").value.trim() || DEFAULT_CONFIG.user,
      intervalMinutes: Math.max(1, Number(document.getElementById("intervalMinutes").value) || DEFAULT_CONFIG.intervalMinutes),
    };

    await chrome.storage.sync.set(newConfig);
    await chrome.runtime.sendMessage({ type: "RESCHEDULE", intervalMinutes: newConfig.intervalMinutes });

    const saved = document.getElementById("saved");
    saved.textContent = `Đã lưu lúc ${new Date().toLocaleTimeString("vi-VN")}`;
  });
});
