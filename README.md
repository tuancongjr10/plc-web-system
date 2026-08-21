# PLC Web System – Print, Scan & TraceCode

Hệ thống Web Server cục bộ dành cho PLC Siemens S7-1200, Print Queue, Scan/TraceCode và Traceability. Hệ thống được triển khai trong LAN TP-Link và có thể vận hành không cần Internet sau khi đã cài đặt đầy đủ dependency.

## Trạng thái production hiện tại

- **Friendly URL:** `http://robolinks-tcjr`
- **Server LAN:** `192.168.0.100`
- **PLC Siemens S7-1200:** `192.168.0.1:2000`
- **TP-Link gateway:** `192.168.0.254`
- **Production HTTP:** TCP `80`
- **Frontend/API/WebSocket:** cùng một host, frontend dùng `/api` và `/ws`
- **Windows Service:** `PLC Web System`, WinSW x64 2.12.0, Automatic Delayed Start
- **Production không dùng:** Vite `:5173`, nodemon hoặc terminal chạy thủ công

Luồng production:

```text
Windows boot
→ PLC Web System Windows Service
→ Node.js production server
→ Vue SPA + API + WebSocket
→ PLC TCP reconnect/telemetry
→ operator mở http://robolinks-tcjr
```

## Chức năng chính

- **Dashboard:** tổng quan PLC/line status, cảnh báo, print jobs và realtime tags.
- **Machine Control:** JOB, START, STOP, HOME, RESET và giám sát trạng thái máy/motion.
- **Print Queue:** quản lý Windows Print Queue; kiến trúc `WINDOWS_QUEUE` là mode chính, `RAW_TCP_LEGACY` chỉ giữ cho tương thích cũ.
- **PDF → Trace QR:** chọn PDF, tính SHA-256, tạo TraceCode `DOC-XXXXXXXXXXXXXXXX`, sinh file QR riêng và tải xuống qua browser; PDF nguồn không bị sửa hoặc ghi đè.
- **Scan & TraceCode:** nhận barcode/QR qua USB HID hoặc nhập thủ công và xử lý workflow sản phẩm/job.
- **Traceability:** lưu lịch sử PLC, job, print/trace và dữ liệu truy vết.
- **Device Registry:** quản lý PLC, printer và cấu hình thiết bị.
- **Persistence/Reconciliation:** lưu trạng thái job PLC trong SQLite và đối chiếu lại với telemetry sau backend restart.

## Kiến trúc

- **Frontend:** Vue 3 + Vite (Vite chỉ dùng cho development), Pinia, WebSocket realtime.
- **Backend:** Node.js + Express.
- **Database:** SQLite.
- **PLC transport:** Siemens S7-1200 ASCII TCP Socket tại `192.168.0.1:2000`.
- **Production host:** backend serve trực tiếp `frontend/dist` trên port 80.
- **Windows Service:** WinSW chạy một Node production process dưới Windows SCM.

## Giao thức PLC

Machine commands:

```text
JOB=PPPP,RRRR,QQQQ
START=0000
STOP=0000
HOME=0000
RESET=0000
STATUS=0000
```

ACK:

```text
JOB   → ACK=0001
START → ACK=0002
STOP  → ACK=0003
RESET → ACK=0004
HOME  → ACK=0005
```

Telemetry:

```text
STAT=S,J,PPPP,RRRR,QQQQ,R,U,F,EEEE,A,M,H,P,O,TT
```

Backend chỉ cập nhật telemetry khi nhận frame STAT hợp lệ đủ 15 field. Hệ thống phân biệt TCP connected với telemetry healthy/fresh; khi dữ liệu stale không giả `0/false` thành dữ liệu thật.

## PLC job persistence và reconciliation

`production_jobs` lưu các trường PLC như:

- `plc_device_id`
- `plc_product_id`
- `plc_recipe_id`
- `plc_target_qty`
- `plc_job_loaded`
- `plc_loaded_at`
- `last_plc_ack`
- `plc_reconcile_status`

Job chỉ được đánh dấu loaded sau ACK hợp lệ. Sau backend restart, SQLite được đối chiếu lại với STAT của PLC để tránh mất trạng thái hoặc chạy nhầm job.

## PDF → Trace QR

Workflow độc lập với printer/spooler:

```text
PDF nguồn
→ upload qua browser
→ SHA-256
→ TraceCode DOC-XXXXXXXXXXXXXXXX
→ QR PDF riêng
→ browser download
→ scanner đọc TraceCode
→ lookup metadata/product/job
```

Bảng `document_traces` lưu metadata/fingerprint và liên kết tùy chọn tới product/job; không lưu Windows local path và không lưu bytes PDF nguồn.

## Printer architecture

Production sử dụng **Windows Print Queue** làm cơ chế chính để hỗ trợ nhiều driver/máy in.

- `WINDOWS_QUEUE`: mode chính.
- `RAW_TCP_LEGACY`: chỉ giữ tương thích legacy.
- Printer vật lý Godex/Zebra/TSC cần được cài driver/queue machine-wide để Windows Service account có thể nhìn thấy queue.
- `Microsoft Print to PDF` chỉ phù hợp cho kiểm thử tương tác, không phải production printer queue trong Session 0.

## Yêu cầu hệ thống

- Windows 10/11 hoặc Windows Server tương thích WinSW.
- Node.js `>=18`.
- Trình duyệt hiện đại: Chrome, Edge hoặc Firefox.
- PLC và ThinkPad cùng LAN TP-Link khi chạy REAL mode.

## Cài đặt ban đầu

```cmd
cd backend
npm install
cd ..\frontend
npm install
```

Tạo environment local:

```text
backend/.env.example → backend/.env
```

Tạo `JWT_SECRET` mạnh và giữ `.env` chỉ trên máy server. Repository không chứa `.env`, runtime database, logs, uploads, tmp, `node_modules` hoặc ZIP export.

> Không lưu hoặc công khai mật khẩu quản trị production trong repository. Initial administrator credentials phải được cấu hình/đổi cục bộ trên máy triển khai.

## Development mode

Development vẫn có thể chạy riêng backend và Vite:

**Backend:**

```cmd
cd backend
npm run dev
```

Mặc định backend development dùng port 3000 nếu `.env` không override.

**Frontend:**

```cmd
cd frontend
npm run dev
```

Vite development dùng port 5173. Khi dùng Vite, cấu hình `CORS_ORIGIN` trong `.env` phải trùng origin của frontend development.

## Production build và chạy trực tiếp

Từ `backend`:

```cmd
npm.cmd run build:frontend
npm.cmd test
npm.cmd start
```

`npm start` chạy `scripts/start-production.js`, ép production mode và mặc định bind `0.0.0.0:80` nếu `PORT` chưa được cấu hình.

Production URL:

```text
http://robolinks-tcjr
```

Địa chỉ kỹ thuật dự phòng trong LAN:

```text
http://192.168.0.100
```

## Windows Service

Các lệnh service chạy từ `backend` trong Administrator terminal:

```cmd
npm.cmd run service:install
npm.cmd run service:start
npm.cmd run service:status
npm.cmd run service:stop
npm.cmd run service:uninstall
```

Service hiện dùng:

- ID: `PLCWebSystem`
- Display name: `PLC Web System`
- Startup: Automatic Delayed Start
- Account: `NT AUTHORITY\LocalService`
- Listener: `0.0.0.0:80`
- Working directory: `backend`

Chi tiết deployment xem tại [`docs/windows-service.md`](docs/windows-service.md).

## Firewall / LAN

Production cần inbound TCP 80 trên trusted Private network:

```powershell
New-NetFirewallRule -DisplayName "PLC Web System TCP 80 (Private)" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80 -Profile Private
```

TP-Link production network phải được Windows phân loại là `Private`.

## Health check

```text
GET http://robolinks-tcjr/api/health
```

Health endpoint kiểm tra server/database mà không gửi PLC machine command.

## Lưu ý an toàn

- `DEMO_MODE=true`: dùng cho UI/workflow khi không có hardware.
- `DEMO_MODE=false`: REAL mode, backend có thể kết nối PLC thật.
- Không gọi JOB/START/STOP/HOME/RESET trên thiết bị đang vận hành nếu chưa có quy trình an toàn tại hiện trường.
- `HOME` và `RESET` là hai lệnh độc lập; HOME không đồng nghĩa với RESET.

## Giới hạn hiện tại

Core software, PLC realtime, TraceCode và production Windows Service đã được kiểm thử. Việc hiệu chỉnh khổ giấy/driver và xác nhận đầu ra cuối trên máy in tem vật lý thực tế cần thực hiện khi có hardware production tương ứng.
