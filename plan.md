# Plan: Cursor Usage Tracker (Chrome Extension + Local Server)

## Mục tiêu
Tự động lấy % usage tài khoản Cursor (cá nhân) định kỳ, đẩy về local server để lưu/hiển thị realtime, không cần thủ công vào dashboard check mỗi lần.

## Kiến trúc tổng quan

```
┌─────────────────────────┐
│   Chrome (đã login       │
│   cursor.com)            │
│                          │
│  ┌────────────────────┐  │       POST /api/updateUsages
│  │ Extension (MV3)    │  │──────────────────────────────┐
│  │ - background.js    │  │                               │
│  │ - chrome.alarms    │  │                               ▼
│  └────────────────────┘  │                    ┌─────────────────────┐
└──────────┬───────────────┘                    │ Local server :3000   │
           │ fetch (credentials:include)         │ - lưu in-memory/DB   │
           ▼                                     │ - GET /api/usages    │
   cursor.com/<usage-endpoint>                   │ - (optional) SSE     │
   (cookie session tự gắn)                       └─────────────────────┘
```

---

## Phase 0 — Trinh sát endpoint (làm tay, 1 lần)

**Mục đích:** xác định chính xác URL, method, response shape của API usage. Đây là API không công khai nên KHÔNG đoán mò, phải bắt request thật.

| Bước | Việc làm |
|---|---|
| 0.1 | Mở `cursor.com/dashboard`, đăng nhập |
| 0.2 | F12 → tab **Network** → filter **Fetch/XHR** |
| 0.3 | Reload trang, quan sát phần "Your included usage" |
| 0.4 | Tìm request JSON chứa field kiểu `percent`, `resetDate`, `included`... |
| 0.5 | Ghi lại: **URL đầy đủ**, **method** (GET/POST), **request headers** đặc biệt (ngoài cookie), **response JSON mẫu** |
| 0.6 | Test lại bằng `curl`/Postman với cookie copy tay để confirm request lặp lại được, không phụ thuộc state phiên React |

✅ **Output cần có trước khi qua Phase 1:** 1 đoạn JSON mẫu thật + URL + method.

⚠️ Nếu response yêu cầu thêm header đặc biệt (vd `x-requested-with`, custom header chống CSRF) → cần ghi rõ, vì `fetch` từ extension phải replicate y chang.

---

## Phase 1 — Local server (làm trước, dễ test độc lập)

**Mục đích:** có chỗ nhận data trước khi đụng tới extension, để test bằng `curl` giả lập.

| Bước | Việc làm |
|---|---|
| 1.1 | Khởi tạo project Node (Express hoặc Fastify) |
| 1.2 | Route `POST /api/updateUsages` — nhận `user`, `percent`, `reset` (query hoặc body), lưu vào object in-memory (hoặc file JSON / SQLite nếu muốn persist) |
| 1.3 | Route `GET /api/usages` — trả toàn bộ data hiện có |
| 1.4 | (Optional) `GET /api/stream` — SSE để client web tự cập nhật mà không cần poll |
| 1.5 | Bật `cors` middleware — origin sẽ là `chrome-extension://<extension-id>`, cần whitelist đúng |
| 1.6 | Test bằng `curl -X POST "localhost:3000/api/updateUsages?user=hungfire&percent=70&reset=2026-07-01"` → confirm `GET /api/usages` trả đúng |

✅ **Output:** server chạy local, nhận/trả data đúng qua curl, chưa cần extension.

---

## Phase 2 — Chrome Extension (Manifest V3)

| Bước | Việc làm |
|---|---|
| 2.1 | `manifest.json`: khai báo `permissions: ["alarms", "storage"]`, `host_permissions: ["https://cursor.com/*", "http://localhost:3000/*"]` |
| 2.2 | `background.js` (service worker): hàm `fetchAndPush()` — gọi endpoint từ Phase 0 với `credentials: "include"`, parse JSON, rồi `fetch` POST sang `localhost:3000` |
| 2.3 | `chrome.alarms.create("checkUsage", { periodInMinutes: N })` + listener gọi `fetchAndPush` |
| 2.4 | `chrome.runtime.onStartup.addListener(fetchAndPush)` — chạy ngay khi mở Chrome |
| 2.5 | Load unpacked extension (`chrome://extensions` → Developer mode → Load unpacked) để test |
| 2.6 | Kiểm tra Service Worker console (qua `chrome://extensions` → "Inspect views: service worker") để debug fetch lỗi |

✅ **Output:** extension chạy nền, tự fetch theo lịch, gọi đúng server local.

---

## Phase 3 — Tích hợp & kiểm thử end-to-end

| Bước | Việc làm |
|---|---|
| 3.1 | Chạy server local |
| 3.2 | Load extension, đợi alarm trigger (hoặc thêm nút "Fetch now" trong popup để test nhanh thay vì chờ alarm) |
| 3.3 | Confirm `GET /api/usages` trả data mới, đúng % và reset date so với dashboard thật |
| 3.4 | Test case lỗi: cookie hết hạn / chưa login → server nên nhận được lỗi rõ ràng (không phải JSON parse exception im lặng) |
| 3.5 | (Optional) Build UI nhỏ ở `localhost:3000` (1 trang HTML) hiển thị % realtime qua SSE/polling |

---

## Rủi ro & lưu ý

- **API không chính thức** — Cursor có thể đổi response shape/endpoint bất kỳ lúc nào, không báo trước → cần try/catch + log rõ khi parse thất bại.
- **Phụ thuộc Chrome đang mở** — nếu tắt Chrome, extension không chạy được, server sẽ chỉ giữ data cũ.
- **Không chia sẻ** extension này hoặc cookie cho người khác — nó gắn với phiên đăng nhập cá nhân.
- Đây là personal automation cho tài khoản của chính mình — không phải dùng để truy cập tài khoản người khác.

---

## Việc cần mày confirm trước khi code

1. [ ] Đã bắt được URL + JSON mẫu thật từ Network tab chưa? (Phase 0)
2. [ ] Muốn lưu server data kiểu nào — chỉ in-memory (mất khi restart) hay ghi ra file/SQLite để persist?
3. [ ] Có cần UI xem trực tiếp ở `localhost:3000`, hay chỉ cần API để service khác (vd VS Code extension, status bar) gọi vào?
4. [ ] `periodInMinutes` cho alarm — bao lâu fetch 1 lần là hợp lý (Chrome MV3 alarm tối thiểu là 1 phút)?