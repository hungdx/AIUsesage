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

  store[user] = {
    email: email ?? null,
    percent: percent ?? null,
    reset: reset ?? null,
    membershipType: membershipType ?? null,
    autoPercentUsed: autoPercentUsed ?? null,
    apiPercentUsed: apiPercentUsed ?? null,
    breakdown: breakdown ?? null,
    updatedAt: new Date().toISOString(),
  };

  saveData(store);
  console.log(`[updateUsages] ${user}: ${percent}% (reset ${reset})`);
  res.json({ ok: true, user, data: store[user] });
});

// Lấy toàn bộ data (dashboard dùng cái này)
app.get("/api/usages", (_req, res) => {
  res.json(store);
});

// Lấy data của 1 user cụ thể
app.get("/api/usages/:user", (req, res) => {
  const data = store[req.params.user];
  if (!data) return res.status(404).json({ error: "Không tìm thấy user này" });
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`Cursor usage server đang chạy tại http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
});
