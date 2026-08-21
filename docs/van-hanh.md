# Ghi chú vận hành

## Phase 1 - Trạng thái

- Code/logic render + adapter: **HOÀN THÀNH**, đã test **33/33 PASS**.
- Xác nhận khổ giấy 4x2 không xoay trên output thật: **BỊ CHẶN**, chờ có máy in tem thật (Godex/Zebra/TSC) hoặc driver PDF hỗ trợ custom size. Lý do: Microsoft Print to PDF không expose custom paper size qua PrintCapabilities, không thể test đáng tin cậy trên máy hiện tại.
- Việc này **KHÔNG** được coi là Phase 1 đã đóng hoàn toàn. Khi có máy in tem thật, phải chạy lại Test Print và xác nhận MediaBox cùng việc không có `/Rotate` trên chính file output cuối cùng trước khi đánh dấu Phase 1 **THỰC SỰ hoàn tất**.

## In nhãn PDF trên Windows

- Hệ thống truyền khổ giấy của từng template vào `pdf-to-printer` và in với `scale: noscale`. Driver máy in phải có khổ giấy tương ứng với kích thước nhãn.
- Phiên bản `pdf-to-printer` hiện tại đóng gói SumatraPDF 3.4.6. Phiên bản này chưa hỗ trợ `disable-auto-rotation` (tùy chọn chỉ có từ SumatraPDF 3.5).
- Nếu nhãn vẫn bị xoay sau khi đã xác nhận `paperSize` đúng, cần cân nhắc nâng cấp SumatraPDF/`pdf-to-printer`; không thêm `orientation` để bù trừ khi chưa kiểm tra hướng giấy do driver cung cấp.
- Microsoft Print to PDF chỉ phù hợp để kiểm tra khi driver đã nhận custom paper size đúng kích thước. Kết quả cuối cùng vẫn phải được xác nhận bằng test in vật lý trên máy in tem thật trước khi hoàn thành Phase 1.
