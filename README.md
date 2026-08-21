# Hệ thống PLC Web chạy trong LAN TP-Link

Hệ thống chạy hoàn toàn trong mạng LAN riêng, không cần Internet khi vận hành:

- ThinkPad / Web Server: `192.168.0.100`
- PLC Siemens: `192.168.0.1:2000`
- TP-Link gateway: `192.168.0.254`
- Frontend gọi API bằng `/api` và WebSocket bằng `/ws` trên chính host đang mở trang.

## Yêu cầu hệ thống
- **Node.js**: Phiên bản 18.0.0 trở lên
- Trình duyệt web hiện đại (Chrome, Edge, Firefox)

## Cài đặt ban đầu

Internet chỉ cần thiết cho lần cài Node.js và tải package. Sau khi đã có `node_modules` (hoặc dùng bản đóng gói sẵn), hệ thống vận hành không phụ thuộc Internet.

1. Cài đặt Node.js 18 trở lên khi máy chưa có.
2. Chạy file `setup.bat` nằm ở thư mục gốc của project để tự động:
   - Cài đặt thư viện cho Backend
   - Cài đặt thư viện cho Frontend
   - Khởi tạo và tạo dữ liệu mẫu cho Database (SQLite)

3. Sao chép `backend/.env.example` thành `backend/.env`, tạo `JWT_SECRET` riêng và giữ file này trên máy server. `.env` thật đã được git bỏ qua.

## Cấu hình mạng LAN

1. Đặt IPv4 tĩnh cho ThinkPad là `192.168.0.100` (subnet mask thường là `255.255.255.0`), gateway `192.168.0.254`.
2. Kết nối ThinkPad, PLC và các thiết bị truy cập vào cùng LAN/Wi-Fi TP-Link. Không bật client/AP isolation.
3. Cho phép inbound TCP `3000` và `5173` trên Windows Firewall của ThinkPad. PLC phải cho phép kết nối TCP từ ThinkPad tới `192.168.0.1:2000`.
4. Không cần DNS hoặc kết nối WAN để sử dụng hệ thống.

## Khởi chạy chế độ phát triển trong LAN

Chạy song song hai cửa sổ terminal:

**Cửa sổ 1 - Khởi chạy Backend:**
```cmd
cd backend
npm run dev
```
Backend bind trên `0.0.0.0:3000`.

**Cửa sổ 2 - Khởi chạy Frontend:**
```cmd
cd frontend
npm run dev
```
Vite bind trên `0.0.0.0:5173`. Từ điện thoại, tablet hoặc máy tính cùng Wi-Fi TP-Link, mở:

```text
http://192.168.0.100:5173
```

Không dùng `localhost` trên thiết bị khác vì địa chỉ đó trỏ về chính thiết bị đang mở trình duyệt.

## Chạy production trong LAN

Build frontend khi package đã được cài sẵn, sau đó chạy backend:

```cmd
cd frontend
npm run build
cd ..\backend
npm start
```

Với `NODE_ENV=production`, backend phục vụ cả giao diện, API và WebSocket. Thiết bị cùng Wi-Fi truy cập `http://192.168.0.100:3000`.

## Tài khoản Đăng nhập Mặc định
- Username: `admin`
- Password: `Admin@123`

## Kiến trúc đã triển khai
1. **Frontend**: Vue 3 + Vite, State quản lý bằng Pinia, Real-time update bằng WebSocket, giao diện Dark Theme chuyên nghiệp cho môi trường công nghiệp.
2. **Backend**: Node.js + Express.
3. **Database**: SQLite (file lưu tại `backend/database/plc_system.db`).
4. **PLC Service**: Siemens S7-1200 ASCII TCP tại `192.168.0.1:2000`, dùng `JOB=PPPP,RRRR,QQQQ`, `START=0000`, `STOP=0000`, `HOME=0000`, `RESET=0000`; REAL mode không giả ACK/ONLINE.
5. **Printer Service**: Quản lý máy in nhãn Godex qua adapter TCP/IP. Template lưu dữ liệu nhãn logic; driver chỉ mã hóa lệnh khi model và command language đã được cấu hình, xác thực.
6. **Scanner Service**: Xử lý dữ liệu mã vạch (Barcode/QR code) đầu vào, phân tích dữ liệu, lưu lịch sử.

## Ánh xạ dữ liệu Job PLC

SQLite hiện chưa có các cột PLC ProductID, RecipeID và TargetQty. Cấu hình ánh xạ theo barcode bằng biến môi trường `PLC_JOB_MAP`, ví dụ:

```env
PLC_JOB_MAP={"PROD-001":{"productId":1,"recipeId":1,"targetQty":1}}
```

Nếu thiếu ánh xạ, workflow trả `plc_job_configuration_missing` và không gửi command. `target_revs` vẫn được giữ trong SQLite nhưng không được dùng trong protocol PLC hiện tại.

## Lưu ý an toàn khi kiểm thử

- Dùng `DEMO_MODE=true` cho kiểm thử giao diện hoặc workflow không có phần cứng.
- `DEMO_MODE=false` là REAL mode và có thể mở kết nối tới PLC thật; chỉ bật khi dây chuyền đã sẵn sàng.
- Không chạy smoke test hoặc endpoint điều khiển `JOB/START/STOP/HOME/RESET` trên PLC đang vận hành nếu chưa có quy trình an toàn tại hiện trường.

## Protocol điều khiển máy

```text
JOB=PPPP,RRRR,QQQQ
START=0000
STOP=0000
HOME=0000
RESET=0000
```

`HOME=0000` yêu cầu PLC thực hiện homing/reference axis. `RESET=0000` reset fault hoặc machine state. Đây là hai lệnh độc lập; HOME không đồng nghĩa với RESET. Trong REAL mode, callback của `socket.write` chỉ được ghi là command đã gửi vào TCP stack, không phải homing đã hoàn tất và không phải PLC ACK.

Backend poll telemetry bằng raw ASCII `STATUS=0000` (không CR/LF), với chu kỳ `PLC_STATUS_POLL_MS`. PLC trả frame `STAT=S,J,PPPP,RRRR,QQQQ,R,U,F,EEEE,A,M,H,P,O,TT`; chỉ frame đủ 15 field và hợp lệ mới cập nhật WebSocket với quality `GOOD`. Trước frame hợp lệ đầu tiên, các tag giữ `null / UNKNOWN`.

Mỗi PLC dùng một transaction scheduler. Machine command giữ transaction cho tới ACK tương ứng (`JOB→ACK=0001`, `START→ACK=0002`, `STOP→ACK=0003`, `RESET→ACK=0004`, `HOME→ACK=0005`) hoặc `PLC_RESPONSE_TIMEOUT_MS`; STATUS giữ transaction tới STAT hợp lệ hoặc timeout. Machine queue được ưu tiên và poll tick bị bỏ qua khi PLC đang có transaction hoặc command đang chờ.
