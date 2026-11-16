# ZbrePrinter 3.9.2 — bàn giao source và bộ cài

- Ứng dụng Windows x64 **3.9.2**, Local Print Connector **0.12.2**.
- Repo chứa Electron ở thư mục gốc và source Next.js/React/ZPL/RFID/Go trong
  `web/`. Xem [README](../README.md) để review kiến trúc và build từ source.
- Bộ cài đính kèm là bản có sẵn, build ngày **08/11/2026**; lần bàn giao repo
  không thay đổi logic in và không tạo lại bộ cài này.
- Chỉ phát hành bộ cài mới nhất. `dist/`, dependency, cache và binary connector
  không được commit; connector được build lại từ Go khi đóng gói.
- Bộ cài chưa ký Authenticode. Kết quả nhận byte TCP/WinSpool không thay thế
  việc nghiệm thu tem/RFID và đối soát VALID/VOID trên máy in thực tế.

## Bộ cài

Tên: `ZbrePrinter-App-Setup-3.9.2-x64.exe`  
Kích thước: **137,658,756 byte**  
SHA-256:

```text
36e372116f36a33ba2e609157db657e4626f0c31877f2a21212beb0c7fc4a439
```

Kiểm tra file tải về bằng PowerShell:

```powershell
Get-FileHash .\ZbrePrinter-App-Setup-3.9.2-x64.exe -Algorithm SHA256
```
