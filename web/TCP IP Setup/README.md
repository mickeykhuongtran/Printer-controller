# Thiết lập TCP/IP cho ZbrePrinter trên Windows

## Kết luận về project hiện tại

Project **đã hỗ trợ TCP/IP** theo hai cách:

1. **TCP/IP trực tiếp (khuyến nghị khi máy in có Ethernet/Wi-Fi):** giao diện
   gọi `POST /api/printer/tcp`; Next.js server mở TCP socket tới
   `IP_MAY_IN:9100` và gửi byte Zebra ZPL dạng RAW. Các file liên quan là
   `app/api/printer/tcp/route.ts`, `app/tcp-print.ts` và
   `app/components/PrintStep.tsx`.
2. **Qua Windows printer queue:** local print agent gọi WinSpool
   `StartDocPrinter(..., "RAW")` và `WritePrinter`. Queue Windows có thể gắn với
   USB hoặc **Standard TCP/IP Port**. File liên quan là
   `native/windows_print_agent.py`.

Phạm vi hiện tại cần lưu ý:

- TCP trực tiếp đã được nối vào màn hình **Print**.
- Các integration endpoint nhận `printerName` hiện vẫn gửi qua browser listener
  và local Windows print agent. Vì vậy, nếu in từ customer API mà không sửa thêm
  transport trong code, hãy tạo Windows Standard TCP/IP Port/queue theo mục B.

> Standard TCP/IP Port của Windows không phải là TCP server/listener được mở
> trên PC. Nó là cấu hình outbound của Windows Spooler, trỏ tới port RAW của máy
> in (thường là TCP 9100).

## Chọn kiến trúc nào?

### A. TCP/IP trực tiếp

```text
Browser -> /api/printer/tcp trên PC chạy Next.js -> Máy in:9100
```

- Không cần cài driver và không cần local Python print agent.
- Ít lớp trung gian, phù hợp gửi ZPL và đọc phản hồi RFID qua socket.
- PC/server đang chạy ZbrePrinter phải route được tới IP máy in. Nếu web app chạy
  trên server khác, kết nối TCP xuất phát từ server đó, không phải từ browser PC.

### B. Windows Standard TCP/IP Port

```text
Browser -> Local Print Agent:17917 -> WinSpool RAW
        -> Windows Standard TCP/IP Port -> Máy in:9100
```

- Cần driver Zebra/ZDesigner/Seagull và local print agent.
- Queue hiện trong Windows, có job history/status của Spooler.
- Phù hợp với flow `PRINTER` và API integration hiện tại đang nhận
  `printerName`.

## Điều kiện trước khi setup

- Đặt IP tĩnh cho máy in hoặc DHCP reservation. Không nên để IP thay đổi.
- Bật RAW TCP printing/JetDirect trên máy in; Zebra thường dùng port `9100`.
- PC chạy ZbrePrinter và máy in phải có route/VLAN/firewall cho phép outbound TCP
  tới port 9100.
- Không NAT/forward port 9100 ra Internet. RAW printing không có xác thực hay mã
  hóa; nên giới hạn bằng VLAN/ACL/firewall.
- Không public endpoint `/api/printer/tcp` cho client không tin cậy. Route hiện
  nhận `host`/`port` từ request; production nên có authentication và allowlist
  IP/subnet máy in để tránh bị dùng như một SSRF/TCP relay vào mạng nội bộ.
- Nếu dùng Windows queue, cài đúng driver và đúng độ phân giải (203/300/600 dpi)
  trước khi chạy script setup.

## Quick start: TCP/IP trực tiếp

1. Kiểm tra socket từ đúng PC chạy ZbrePrinter:

   ```bat
   Test-Printer-TCP.bat 192.168.1.50 9100
   ```

2. Gửi một tem ZPL test không ghi RFID:

   ```bat
   Send-Test-ZPL.bat 192.168.1.50 9100
   ```

3. Trong ZbrePrinter, vào bước **Print**:

   - chọn `TCP/IP`;
   - `Printer IP`: ví dụ `192.168.1.50`;
   - `Port`: `9100`;
   - bấm `Test`, sau đó mới in label thật.

Script `Send-ZPL-TCP.ps1` có thể gửi một file ZPL bất kỳ mà không biến đổi byte:

```powershell
.\Send-ZPL-TCP.ps1 -PrinterHost 192.168.1.50 -Port 9100 -FilePath C:\temp\job.zpl
```

## Quick start: tạo Windows Standard TCP/IP Port và queue

1. Cài driver Zebra/ZDesigner/Seagull. Kiểm tra tên driver chính xác:

   ```powershell
   Get-PrinterDriver | Select-Object Name, Manufacturer
   ```

2. Right-click `Setup-TCP-IP-Printer.bat` -> **Run as administrator**. Script sẽ
   hỏi IP, queue name và driver. Hoặc chạy có tham số trong PowerShell Admin:

   ```powershell
   .\Setup-TCP-IP-Printer.ps1 `
     -PrinterHost 192.168.1.50 `
     -Port 9100 `
     -PrinterName "Zebra ZT610R TCP" `
     -DriverName "ZDesigner ZT610R-300dpi ZPL"
   ```

   Script tạo port `IP_192.168.1.50`, tắt SNMP cho port để tránh trạng thái
   Offline giả khi SNMP bị chặn, và tạo queue với datatype `RAW`.

3. Chạy local print agent tại root project:

   ```powershell
   python -m pip install -r native/requirements-windows.txt
   npm run print-agent:windows
   ```

4. Mở `http://127.0.0.1:17917/printers`. Queue mới phải có `portName` là
   `IP_192.168.1.50`.

5. Trong ZbrePrinter, vào **Print** -> `PRINTER` -> refresh danh sách -> chọn
   queue vừa tạo -> `Test`.

6. Nếu customer API dùng printer alias, mở `/printer-config`, refresh danh sách
   printer, chọn queue mới và lưu lại. Không giữ `portName: USB001` của alias cũ;
   port mới sẽ có dạng `IP_192.168.1.50`.

Nếu cần đổi một queue đã tồn tại sang port/driver mới, script mặc định sẽ dừng để
bảo vệ queue đang vận hành. Chỉ dùng `-UpdateExistingQueue` khi đã xác nhận đúng
queue:

```powershell
.\Setup-TCP-IP-Printer.ps1 `
  -PrinterHost 192.168.1.50 `
  -PrinterName "Zebra ZT610R TCP" `
  -DriverName "ZDesigner ZT610R-300dpi ZPL" `
  -UpdateExistingQueue
```

## Chẩn đoán lỗi

### `Test-Printer-TCP` fail

- Ping có thể bị chặn, nên ping fail chưa đủ kết luận. Kiểm tra TCP 9100 mới là
  phép thử quan trọng.
- Xác minh IP, subnet mask, gateway, VLAN/ACL và port RAW đang bật trên máy in.
- Kiểm tra từ **PC chạy Next.js/local agent**, không chỉ từ laptop quản trị.
- Xem có IP trùng lặp bằng `arp -a`; đặt DHCP reservation hoặc IP tĩnh.

### TCP connect OK, script gửi byte OK nhưng không in

- `bytes sent` chỉ xác nhận OS đã ghi byte vào socket, không phải printer đã in.
- Xác minh language là ZPL, media/ribbon, pause state, printhead-open state và
  calibration.
- Kiểm tra label test với Zebra Setup Utilities/Printer Web UI.
- Đảm bảo đúng dpi và `^PW`/`^LL`; sai kích thước có thể làm nội dung nằm ngoài
  label.

### Direct TCP in được nhưng Windows queue không in

- Port Windows phải là `Standard TCP/IP Port`, protocol `RAW`, port `9100`, không
  phải WSD hay LPR.
- Xóa job bị kẹt, restart Spooler nếu cần, và kiểm tra queue không ở Offline/Paused.
- Driver phải là đúng model/dpi. Local agent gửi datatype `RAW`, không dùng dialog
  GDI thông thường.

### Windows queue in được nhưng app TCP/IP không in

- `/api/printer/tcp` chạy trong Node.js server. Kiểm tra firewall/routing từ PC
  chạy `npm run dev`/`npm run start` tới máy in.
- Nếu app chạy trong Docker/VM, container/VM phải truy cập được VLAN máy in.

## File trong folder

- `Setup-TCP-IP-Printer.ps1/.bat`: tạo Standard TCP/IP Port và Windows queue.
- `Test-Printer-TCP.ps1/.bat`: chỉ test kết nối TCP, không gửi lệnh in.
- `Send-ZPL-TCP.ps1`: gửi byte của file ZPL trực tiếp tới socket.
- `Send-Test-ZPL.bat`: gửi `test-label.zpl` để xác nhận đường truyền RAW.
- `test-label.zpl`: label test ZPL, không có lệnh RFID write.
