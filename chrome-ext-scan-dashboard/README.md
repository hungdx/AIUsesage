# Cursor Usage Tracker — Chrome Extension

## Cài đặt extension

1. Mở `chrome://extensions`
2. Bật **Developer mode** (góc trên phải)
3. Click **Load unpacked** → chọn thư mục `cursor-usage-extension` này
4. Click icon extension trên thanh toolbar → click **Cài đặt**
5. Điền:
   - **Endpoint URL**: URL bắt được từ Network tab ở Phase 0 (trang `cursor.com/dashboard`, request JSON trả về usage)
   - **Local server URL**: mặc định `http://localhost:3333` (server từ Phase 1)
   - **User label**: tên định danh, vd `hungfire`
   - **Interval**: bao nhiêu phút fetch 1 lần
6. Click **Lưu**
7. Mở lại popup, bấm **Fetch now** để test ngay (không cần chờ alarm)

## Quan trọng trước khi chạy

- Phải **đăng nhập sẵn `cursor.com`** trong cùng Chrome đang chạy extension này — extension dựa vào cookie session có sẵn của browser (`credentials: "include"`), không tự lưu/copy cookie.
- Server local (Phase 1) phải đang chạy ở `serverUrl` đã cấu hình, và có route `POST /api/updateUsages` nhận JSON.
- `extractUsageData()` trong `background.js` đã được cập nhật theo response JSON **thật** đã xác nhận:
  - `% used` lấy từ `individualUsage.plan.totalPercentUsed`
  - `reset date` lấy từ `billingCycleEnd`
  - Kèm thêm `autoPercentUsed`, `apiPercentUsed`, `breakdown` (included/bonus/total) để theo dõi chi tiết hơn
  - Nếu Cursor đổi response shape sau này, sửa lại các dòng `percent`/`reset` trong hàm này.
- **User label tự động lấy từ email**: mỗi lần fetch, extension gọi thêm `https://cursor.com/api/auth/me` để lấy `email` thật, dùng làm key lưu trên server. Field "User label" trong Options giờ chỉ là **fallback** — chỉ dùng khi fetch email thất bại (vd cookie hết hạn).

## Debug

- `chrome://extensions` → card extension → **"Inspect views: service worker"** → mở console xem log fetch/push, lỗi parse JSON.
- Nếu thấy lỗi "status 401/403" → cookie hết hạn, cần đăng nhập lại `cursor.com`.
- Nếu `percent`/`reset` ra `null` → console sẽ in raw JSON response, copy lại để chỉnh `extractUsageData()`.

## Cấu trúc file

```
cursor-usage-extension/
├── manifest.json     # khai báo permissions, service worker, popup, options
├── background.js     # fetch usage + push lên local server (chạy nền theo alarm)
├── popup.html/js      # UI nhỏ: hiện % hiện tại, nút "Fetch now"
└── options.html/js    # form cấu hình endpoint/server/interval
```
