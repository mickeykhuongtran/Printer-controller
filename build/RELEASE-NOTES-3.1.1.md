# ZbrePrinter App 3.1.1

Sửa hiện tượng Edit bị treo nhiều giây khi kéo object hoặc sửa QR/text sau khi chọn in toàn bộ DataFeed lớn rồi quay lại thiết kế.

- Loại bỏ việc tạo toàn batch ZPL trong mỗi lần render trang. Chỉ biên dịch batch khi người dùng yêu cầu in hoặc xuất dữ liệu.
- Xóa đường dữ liệu và phần ZPL Source đã bị ẩn trong BottomDock; giữ các chức năng xem/xuất ZPL ở bước Print.
- Memoize BottomDock để việc sửa object không render lại bảng DataFeed khi dữ liệu/cấu hình của bảng không thay đổi.
- Giữ preview một dòng, số lượng bản in, thứ tự dữ liệu HEX và cơ chế Windows RAW của Connector 0.5.0.
- Thêm `npm run test:editor-ui` để tái hiện chuỗi 2.500 dòng → Print → Edit, kéo barcode, sửa QR/text, preview dòng cuối và undo/redo.

## Kết quả kiểm chứng

Đo bằng renderer production trong Electron 43.2.0, cùng fixture 2.500 dòng HEX, một CODE128, một QR, một text, 300 dpi. Đây là các mẫu đo trên máy build, không phải cam kết latency cho mọi máy/template.

| Thao tác với copies = 2.500 | Bản 3.1.0 trong review | Bản 3.1.1 |
| --- | ---: | ---: |
| Kéo phải 2 mm sau Print → Edit, bảng DataFeed đóng | 7.379,8 ms | 9,2 ms |
| Kéo 2 mm sau Print → Edit, bảng DataFeed mở | Chưa đo | 18,9 ms |
| Sửa nội dung QR | 7.711,3 ms | 12,4 ms |
| Sửa text ở preview dòng cuối | Chưa đo | 14,6 ms |
| Dời text phải 2 mm bằng giá trị tọa độ | Chưa đo | 10,9 ms |

- Test hồi quy mới thất bại đúng trên bundle 3.1.0: kéo mất 7.248,7 ms, vượt ngưỡng 1.000 ms; qua trên bundle 3.1.1. Ngưỡng này bắt lỗi chặn UI nhiều giây, không thay thế phép đo frame rate.
- Qua kiểm thử preview, undo/redo, giữ nguyên tham chiếu DataFeed, toàn bộ 2.500 dòng đúng thứ tự, mã HEX và số 0 đầu, số lượng in vẫn là 2.500.
- Qua test UI Windows spool giả lập: 2.500 nhãn đúng thứ tự, 250 chunk chuẩn bị, tổng 1.440.300 byte, một Windows job; có kiểm tra bảng trạng thái và khôi phục batch lưu trữ. Không gửi lệnh in tới máy thật.
- Qua TypeScript, production build, lint (0 lỗi; 6 cảnh báo có sẵn), 10 desktop unit tests, các test print-batch-data, raw-spool-batch và print-calibration.
- Qua kiểm tra bundle, packed runtime và health check binary Connector 0.5.0.
- Kiểm tra archive trong installer bằng 7-Zip hoàn tất `Everything is Ok`; công cụ báo phần dữ liệu nằm sau archive nhúng trong EXE tự giải nén.

## Source và bộ cài

- Source web: `../ZbrePrinter`, commit `87440043bbb984d28a5e59fd14bf55181e361da1`.
- Manifest bundle ghi web `3.1.1`, `sourceDirty: false`, Connector `0.5.0`.
- Tái sử dụng binary connector đã kiểm tra SHA-256; không có thay đổi connector trong bản sửa UI này.
- Bộ cài: `dist/ZbrePrinter-App-Setup-3.1.1-x64.exe`.
- Dung lượng: 136.879.118 byte.
- SHA-256: `ee82cb34538fe9c86c34a1029af6697300478a295a2723aa5e2749081ab94feb`.

Để cập nhật, đóng ZbrePrinter rồi chạy bộ cài 3.1.1 vào cùng vị trí cài đặt. Cấu hình và dữ liệu người dùng tiếp tục dùng thư mục hiện có. Đợt kiểm chứng này không thực hiện nâng cấp trực tiếp lên bản app người dùng đang cài.

QZ chưa được tích hợp. [Review trước sửa](../docs/EDITOR-PERFORMANCE-REVIEW-2026-09-13.md) và [nghiên cứu QZ](../docs/QZ-TRAY-FEASIBILITY-2026-09-13.md) được lưu cùng tài liệu project.
