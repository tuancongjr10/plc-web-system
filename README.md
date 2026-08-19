# Hướng dẫn Khởi chạy Hệ thống PLC Web

## Yêu cầu hệ thống
- **Node.js**: Phiên bản 18.0.0 trở lên
- Trình duyệt web hiện đại (Chrome, Edge, Firefox)

## Cài đặt (Setup)
1. Cài đặt Node.js từ https://nodejs.org/ (nếu máy chưa có)
2. Chạy file `setup.bat` nằm ở thư mục gốc của project để tự động:
   - Cài đặt thư viện cho Backend
   - Cài đặt thư viện cho Frontend
   - Khởi tạo và tạo dữ liệu mẫu cho Database (SQLite)

## Khởi chạy (Start)
Bạn cần chạy song song 2 cửa sổ terminal (Command Prompt / PowerShell):

**Cửa sổ 1 - Khởi chạy Backend:**
```cmd
cd backend
npm run dev
```
*(Server sẽ chạy tại: `http://localhost:3000`)*

**Cửa sổ 2 - Khởi chạy Frontend:**
```cmd
cd frontend
npm run dev
```
*(Giao diện web sẽ chạy tại: `http://localhost:5173`)*

## Tài khoản Đăng nhập Mặc định
- Username: `admin`
- Password: `Admin@123`

## Kiến trúc đã triển khai
1. **Frontend**: Vue 3 + Vite, State quản lý bằng Pinia, Real-time update bằng WebSocket, giao diện Dark Theme chuyên nghiệp cho môi trường công nghiệp.
2. **Backend**: Node.js + Express.
3. **Database**: SQLite (file lưu tại `backend/database/plc_system.db`).
4. **PLC Service**: Giả lập protocol Modbus/Ethernet-IP, đọc ghi tags tự động, cảnh báo alarm, tự động reconnect.
5. **Printer Service**: Quản lý máy in nhãn Godex qua adapter TCP/IP. Template lưu dữ liệu nhãn logic; driver chỉ mã hóa lệnh khi model và command language đã được cấu hình, xác thực.
6. **Scanner Service**: Xử lý dữ liệu mã vạch (Barcode/QR code) đầu vào, phân tích dữ liệu, lưu lịch sử.
