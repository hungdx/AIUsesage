# Cursor Usage Server

Server local nhận update từ extension, lưu ra `data.json`, có dashboard nhỏ tự refresh.

## Cài đặt & chạy

```bash
cd cursor-usage-server
npm install
npm start
```

Mặc định chạy ở **port 3333**: `http://localhost:3333`
Đổi port bằng env var: `PORT=4000 npm start`

## Routes

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/` | Dashboard HTML, tự refresh mỗi 5s |
| `POST` | `/api/updateUsages` | Extension gọi vào đây, body JSON: `{ user, percent, reset, membershipType, autoPercentUsed, apiPercentUsed, breakdown }` |
| `GET` | `/api/usages` | Trả toàn bộ data (object, key = user) |
| `GET` | `/api/usages/:user` | Trả data của 1 user |

## Test nhanh bằng curl (không cần extension)

```bash
curl -X POST http://localhost:3333/api/updateUsages \
  -H "Content-Type: application/json" \
  -d '{"user":"hungfire","percent":75.5,"reset":"2026-07-06T17:01:01.457Z","autoPercentUsed":76,"apiPercentUsed":100}'

curl http://localhost:3333/api/usages
```

Mở `http://localhost:3333` trên trình duyệt để xem dashboard cập nhật.

## Lưu ý

- Data lưu ở `data.json` (đã gitignore) — restart server không mất data.
- Dashboard ghi nhận phần trăm usage tăng giữa các lần cập nhật cùng ngày để hiển thị tổng hôm qua và hôm nay. Lịch sử bắt đầu từ lần cập nhật hiện có; ngày không có dữ liệu sẽ hiển thị `--`.
- Chưa có auth — chỉ nên chạy local, không expose ra ngoài internet.
- Nếu đổi sang port khác port 3333, nhớ cập nhật lại **Server URL** trong Options của extension cho khớp.
