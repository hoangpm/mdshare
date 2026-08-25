# mdshare

Dịch vụ chia sẻ file Markdown tối giản, không cần auth. Tương tự mdbin.

Dùng **Turso (libSQL)** làm nơi lưu trữ thay vì SQLite file cục bộ, vì Render free tier
không có persistent disk — filesystem bị xoá mỗi khi service sleep/restart.

Tích hợp sẵn **MCP server** ngay trong cùng 1 process — cho phép AI chat (Claude, ChatGPT,
Grok...) gọi tool `publish_markdown` / `fetch_markdown` để đăng/đọc nội dung trực tiếp,
không cần người dùng tải file về máy rồi tự `curl` lên.

## Kiến trúc dữ liệu

- `POST /` → sinh khóa ngẫu nhiên 8 ký tự (`a-z0-9`), lưu nội dung vào bảng `pastes` trên Turso.
- `GET /p/:key/raw` → trả nguyên văn nội dung, `Content-Type: text/plain`.
- `GET /p/:key` → trang xem tối giản, escape HTML, không render markdown → HTML (tránh XSS).
- `POST /mcp` → endpoint MCP (Streamable HTTP), expose 2 tool cho AI chat gọi trực tiếp.

**Vì sao gộp MCP vào cùng 1 service thay vì tách riêng:** thiết kế ban đầu tách MCP thành
service riêng, gọi `fetch()` HTTP sang service `mdshare` chính. Trên Render free tier, khi
cả 2 service đều "ngủ" (sau 15 phút không traffic), request nội bộ giữa chúng dễ bị timeout
ở tầng proxy của Render và trả về lỗi 502, dù mỗi service gọi trực tiếp từ ngoài vẫn hoạt
động bình thường (đây là cold-start-kép: chờ 2 lần đánh thức container tuần tự). Gộp lại
thành 1 process loại bỏ hoàn toàn request nội bộ đó — tool MCP gọi thẳng hàm JavaScript nội
bộ, không qua mạng.

## 2 tool MCP được cung cấp

- **`publish_markdown(content)`** — đăng nội dung markdown, trả về URL xem và URL raw.
- **`fetch_markdown(key_or_url)`** — tải lại nội dung 1 paste đã đăng, dựa vào key hoặc URL
  (chấp nhận cả `domain/p/key` và `domain/p/key/raw`). Đây là fallback quan trọng: một số
  AI chat (ghi nhận với ChatGPT) không tự fetch được URL trả về `Content-Type: text/plain`
  thuần — trình duyệt-tool tích hợp của client có thể coi 1 file text thuần là "file tải
  xuống" thay vì trang đọc được. Khi gặp tình huống đó, yêu cầu AI chat gọi tool
  `fetch_markdown` thay vì tự mở URL.

## Nền tảng nào hỗ trợ custom MCP server? (thông tin tại thời điểm viết, có thể thay đổi)

| Nền tảng | Hỗ trợ custom remote MCP? | Ghi chú |
|---|---|---|
| Claude | Có | Tất cả các gói, kể cả free |
| ChatGPT | Có | Cần bật Developer Mode, gói trả phí (Plus/Pro/Business/Enterprise/Edu) |
| Grok | Có | Gói trả phí, mục "Bring Your Own MCP" tại grok.com/connectors |
| Qwen, DeepSeek, Kimi, z.ai (GLM), Manus, Meta AI | Chưa rõ / có thể chưa hỗ trợ ở chat UI tiêu dùng | Kiểm tra trực tiếp Settings/Connectors của nền tảng đó |

## Bước 1 — Tạo database Turso miễn phí

**Cài Turso CLI:**

macOS/Linux:
```bash
curl -sSfL https://get.tur.so/install.sh | bash
```

Windows (PowerShell):
```powershell
irm https://get.tur.so/install.ps1 | iex
```

**Đăng nhập và tạo database:**
```bash
turso auth signup       # hoặc: turso auth login nếu đã có tài khoản
turso db create mdshare
```

**Lấy URL và token kết nối:**
```bash
turso db show mdshare --url
turso db tokens create mdshare
```

Ghi lại 2 giá trị này — sẽ dùng làm biến môi trường `TURSO_DATABASE_URL` và `TURSO_AUTH_TOKEN`.

## Bước 2 — Deploy lên Render

### Cách A: Dùng Blueprint (`render.yaml`) — khuyến nghị, ít thao tác tay nhất

1. Đẩy code (gồm `server.js`, `package.json`, `render.yaml`) lên 1 GitHub repo.
2. Vào [render.com](https://render.com) → **New** → **Blueprint** → chọn repo vừa tạo.
3. Render tự đọc `render.yaml`, tạo web service tên `mdshare`, plan free, region Singapore.
4. Khi được hỏi, nhập giá trị cho 2 biến môi trường `TURSO_DATABASE_URL` và `TURSO_AUTH_TOKEN` (giá trị lấy ở Bước 1).
5. Bấm **Apply** — Render build và deploy tự động.

### Cách B: Tạo thủ công qua Dashboard (không cần `render.yaml`)

1. Vào [render.com](https://render.com) → **New** → **Web Service**.
2. Kết nối GitHub repo chứa code.
3. Cấu hình:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free
4. Vào tab **Environment** → thêm 2 biến:
   - `TURSO_DATABASE_URL` = (giá trị từ `turso db show mdshare --url`)
   - `TURSO_AUTH_TOKEN` = (giá trị từ `turso db tokens create mdshare`)
5. Bấm **Create Web Service**.

## Bước 3 — Kiểm tra sau khi deploy

```bash
curl -X POST --data-binary @test.md https://ten-app.onrender.com/
curl https://ten-app.onrender.com/p/KEY_TRA_VE/raw
```

## Bước 4 — Kết nối MCP vào AI chat

1. Vào **claude.ai → Settings → Connectors → Add custom connector** (hoặc mục tương đương
   ở ChatGPT/Grok — xem bảng hỗ trợ ở trên).
2. Nhập URL: `https://ten-app.onrender.com/mcp`
3. Đặt tên gợi nhớ, ví dụ "mdshare".

Sau đó trong chat bật connector lên, yêu cầu ví dụ:
> "Tóm tắt nội dung trên thành markdown rồi đăng lên mdshare cho tôi"

Test thủ công (không qua AI chat) trên `cmd`:
```cmd
curl -X POST https://ten-app.onrender.com/mcp ^
  -H "Content-Type: application/json" ^
  -H "Accept: application/json, text/event-stream" ^
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}"
```
Kết quả phải chứa 2 tool `publish_markdown` và `fetch_markdown`.

## Chạy thử ở máy local (trước khi deploy)

```bash
npm install
TURSO_DATABASE_URL="giá trị turso db show --url" TURSO_AUTH_TOKEN="giá trị token" node server.js
```

Trên Windows cmd:
```cmd
set TURSO_DATABASE_URL=giá trị turso db show --url
set TURSO_AUTH_TOKEN=giá trị token
node server.js
```

## Lưu ý quan trọng: cold start trên Render free tier

Render free web service **tự sleep sau 15 phút không có traffic**, và mất khoảng
30-60 giây để khởi động lại khi có request đầu tiên sau đó. Vì dữ liệu giờ nằm trên
Turso (không phải đĩa cục bộ của Render), **paste không bị mất** khi service sleep/wake —
chỉ có độ trễ ở request đầu tiên. Với dùng cá nhân, điều này chấp nhận được.

## Giới hạn tần suất (rate limit)

- Ghi (POST): tối đa 20 lần/phút/IP.
- Đọc (GET): tối đa 300 lần/phút/IP.

Chỉnh trong `server.js` (biến `writeLimiter`, `readLimiter`).

## Bảo mật cần lưu ý

- Endpoint `/mcp` **không có xác thực** — bất kỳ ai biết URL đều gọi được 2 tool để đăng/đọc
  nội dung trên `mdshare` của bạn. Với dùng cá nhân, rủi ro thấp (URL không công khai, khó
  đoán qua subdomain ngẫu nhiên của Render). Nếu muốn chặt hơn, có thể thêm kiểm tra 1 header
  bí mật trước khi xử lý request tại route `/mcp` trong `server.js`.
- `mdshare` vốn đã không có auth theo thiết kế ban đầu, nên MCP tool chỉ tự động hoá lại đúng
  hành vi thủ công qua `curl` — không mở thêm rủi ro mới ở phía dữ liệu.

## Cơ sở lý luận cho các lựa chọn thiết kế

- **Turso thay SQLite file cục bộ**: Render free tier không cấp persistent volume,
  nên bất kỳ dữ liệu ghi vào đĩa container sẽ mất khi service restart. Turso cung cấp
  giao thức tương thích SQLite qua HTTP (dựa trên libSQL, một fork mã nguồn mở của SQLite),
  cho phép giữ nguyên mô hình dữ liệu quan hệ đơn giản mà không cần quản lý hạ tầng riêng.
- **Độ dài khóa 8 ký tự, bảng chữ cái 36 ký tự (a-z0-9)**: không gian khóa 36⁸ ≈ 2,8×10¹².
  Theo bài toán ngày sinh nhật (birthday problem), xác suất va chạm chỉ vượt 50% khi số
  bản ghi xấp xỉ căn bậc hai của không gian khóa (~1,7 triệu) — an toàn cho quy mô cá nhân.
  Server vẫn kiểm tra tồn tại trước khi ghi để loại trừ hoàn toàn rủi ro va chạm.
- **Không render markdown → HTML mặc định**: giảm bề mặt tấn công XSS. Trang xem chỉ
  escape và hiển thị trong thẻ `<pre>`.
