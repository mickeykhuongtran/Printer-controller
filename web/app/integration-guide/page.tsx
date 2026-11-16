"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import {
    ArrowLeft,
    BookOpen,
    CheckCircle2,
    Code2,
    Database,
    Gauge,
    Languages,
    ListChecks,
    Network,
    Printer,
    Radio,
    Settings2,
    Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Lang = "en" | "vi";

type DocStep = {
    title: string;
    body: string;
};

type DocTable = {
    headers: string[];
    rows: string[][];
};

type DocSection = {
    id: string;
    icon: ReactNode;
    kicker: string;
    title: string;
    body?: string[];
    steps?: DocStep[];
    bullets?: string[];
    code?: string;
    table?: DocTable;
};

type GuideCopy = {
    badge: string;
    title: string;
    subtitle: string;
    back: string;
    language: string;
    navTitle: string;
    quickTitle: string;
    quickItems: string[];
    sections: DocSection[];
};

const GUIDE_LANGUAGE_KEY = "zbre.integration-guide.language";

const localSetup = `# Development
yarn install
yarn dev                  # http://localhost:8888

# Production
yarn build
yarn start                # http://localhost:8888

# USB-B / Windows spooler support
yarn print-agent:windows  # http://127.0.0.1:17917`;

const profileEndpoints = `GET    /api/integration/profiles
POST   /api/integration/profiles
GET    /api/integration/profiles/{profileId}
DELETE /api/integration/profiles/{profileId}
POST   /api/integration/profiles/{profileId}/compile
POST   /api/integration/profiles/{profileId}/print

POST   /api/integration/schema
POST   /api/integration/compile
POST   /api/integration/print
POST   /print`;

const printProfileRequest = `await fetch(
  "http://localhost:8888/api/integration/profiles/product-label-rfid/print",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      printerName: "Zebra ZT610R Line 1",
      agentUrl: "http://127.0.0.1:17917",
      copies: 1,
      values: {
        product_name: "Sample product",
        lot: "LOT-2026-001",
        qr_code: "ITEM-0002",
        rfid_id: "000000000000000000000002"
      }
    })
  }
);`;

const docs: Record<Lang, GuideCopy> = {
    en: {
        badge: "Integration Guide",
        title: "Zebra RFID label designer and printer integration",
        subtitle:
            "Configure the real printhead, design in physical millimetres, control Zebra ZPL II printers, encode RFID, and integrate approved templates with customer systems.",
        back: "Back to designer",
        language: "Language",
        navTitle: "Chapters",
        quickTitle: "Recommended workflow",
        quickItems: [
            "Choose the Zebra model, installed DPI, and connection protocol.",
            "Set label media, build the template, and bind Data Feed fields.",
            "Calibrate media, alignment, and RFID on the real printer.",
            "Validate one label before printing a range or production batch.",
            "Publish approved templates as API profiles when system integration is required.",
        ],
        sections: [
            {
                id: "workflow",
                icon: <Workflow className="h-4 w-4" />,
                kicker: "01",
                title: "Application workflow",
                body: [
                    "The application follows Choose → Edit → Print. Choose starts from a saved or blank template. Edit defines the physical label, dynamic data, Zebra target, RFID behaviour, and object layout. Print previews resolved rows and sends Zebra ZPL II through the selected protocol.",
                    "Printer settings belong to the active workstation and target printer. Template content remains portable as .nwl, while published API profiles provide a stable contract for customer applications.",
                ],
                table: {
                    headers: ["Area", "Purpose"],
                    rows: [
                        ["Target printer", "Select Auto / Other, ZT610R, or ZD621R; installed DPI; and COM, TCP/IP, or USB-B."],
                        ["Paper settings", "Define label size, gap, Label Top, and Left Position in Zebra-compatible terms."],
                        ["Data Feed", "Import or edit rows that resolve dynamic fields for preview and batch printing."],
                        ["Printer Config", "Apply media/print settings, Zebra RFID settings, and read identity/configuration where supported."],
                        ["Printer Control", "Monitor status and run operator-safe Feed, Pause, Resume, and Cancel Current commands."],
                    ],
                },
            },
            {
                id: "target",
                icon: <Gauge className="h-4 w-4" />,
                kicker: "02",
                title: "Target printer, DPI, and physical size",
                body: [
                    "Always select the DPI installed in the physical printhead. ZT610R supports 203, 300, or 600 dpi profiles; ZD621R supports 203 or 300 dpi. Use Auto / Other only when the exact model is outside the project list.",
                    "Template geometry is stored in millimetres. Changing DPI preserves physical dimensions and recalculates printer-dot coordinates, bitmap resolution, QR/barcode/Data Matrix sizing, and preflight limits. A 76 × 20 mm label therefore remains 76 × 20 mm at every DPI but contains a different number of dots.",
                ],
                bullets: [
                    "Do not choose DPI from the Windows display scale or monitor resolution.",
                    "A template DPI that differs from the installed printhead can produce incorrect physical size and is blocked when a Windows queue mismatch is detected.",
                    "Changing Width or Height changes the physical label; verify object layout and print preview afterward.",
                    "Gap is the label pitch setting. The printer still needs physical media calibration to learn the real gap or black mark.",
                ],
            },
            {
                id: "connections",
                icon: <Network className="h-4 w-4" />,
                kicker: "03",
                title: "Connection protocols and capabilities",
                body: [
                    "The protocol selected in Target printer is reused by Print, Printer Config, and Printer Control. COM uses one shared Web Serial session, so a selected and connected port remains available when moving between Edit and Print without another permission prompt.",
                    "Browser security clears the live COM session after a reload or a new tab. Select and connect the port again in that case. Changing away from COM disconnects the active serial session safely.",
                ],
                table: {
                    headers: ["Protocol", "Configuration", "Capability"],
                    rows: [
                        ["COM / Serial", "Select Port → Connect; 9600, 38400, 57600, or 115200 baud.", "Direct ZPL read/write, live status, GET + SET. Requires Chrome/Edge on HTTPS or localhost."],
                        ["TCP/IP", "Printer IPv4/host and raw-print port, normally 9100.", "Direct ZPL read/write, live status, GET + SET. Network route and firewall must allow the printer."],
                        ["USB-B", "Zebra/Seagull Windows driver, queue name, and Local Print Agent.", "Print and SET are queued. Windows spooler cannot return Zebra GET/status responses."],
                    ],
                },
            },
            {
                id: "design",
                icon: <Database className="h-4 w-4" />,
                kicker: "04",
                title: "Template design and Data Feed contract",
                steps: [
                    {
                        title: "Create the physical label",
                        body: "Select a preset or enter Width, Height, and Gap. Add Text, QR, Barcode, Data Matrix, Image, Line, Rectangle, Table, and RFID-aware fields on the WYSIWYG canvas.",
                    },
                    {
                        title: "Define dynamic columns",
                        body: "Create Data Feed columns such as product_name, lot, qr_code, expired_date, and rfid_id. These field names become the integration contract.",
                    },
                    {
                        title: "Bind values",
                        body: "Use {field_name} in Text, QR, Barcode, Data Matrix, Table cells, or RFID EPC data. Import CSV/Excel for batch jobs and select a row to preview resolved output.",
                    },
                    {
                        title: "Run preflight",
                        body: "Resolve overflow, DPI, model-width, barcode, QR, and RFID validation warnings before approving the template.",
                    },
                ],
            },
            {
                id: "configuration",
                icon: <Settings2 className="h-4 w-4" />,
                kicker: "05",
                title: "Media, alignment, and printer control",
                body: [
                    "Printer Config is intentionally limited to operator-safe settings. Media and Print cover label width/length, gap, tear-off, thermal method, speed, darkness, sensor mode, and paper calibration. Advanced hardware or service parameters remain technician tasks on the printer.",
                    "Printer alignment uses Zebra Label Top (^LT) and Left Position (^LS). Apply writes the values, Print ruler produces a calibration label, and Reset returns alignment to zero.",
                ],
                bullets: [
                    "Transmissive (gap/web) is for die-cut labels with a gap.",
                    "Reflective (black mark) is for media with a registration mark on the liner or back.",
                    "Continuous disables gap/mark registration and uses the configured label length.",
                    "Printer Control exposes Refresh Status, Feed, Pause, Resume, and Cancel Current. Cancel Current also leaves Zebra paused; use Resume afterward.",
                    "GET controls are disabled for USB-B because a Windows spooler queue is unidirectional at this application layer.",
                ],
            },
            {
                id: "rfid",
                icon: <Radio className="h-4 w-4" />,
                kicker: "06",
                title: "Zebra RFID setup and validation",
                body: [
                    "Calibrate the inlay on the real ZT610R or ZD621R before production. Printer calibrated keeps the stored program position. Forward/Backward modes add an explicit Zebra RFID program position only when the media requires it.",
                    "Read power and Write power use -1 to preserve the calibrated printer value. Attempts and error handling apply to explicit Forward/Backward positioning. Validate one real tag after any media, ribbon, inlay, or antenna-path change.",
                ],
                bullets: [
                    "EPC data must be hexadecimal using 0-9 and A-F.",
                    "EPC-96 normally contains 24 hex characters; EPC-128 normally contains 32.",
                    "SET RFID stores supported position and power settings in the printer.",
                    "Also embed in print jobs adds applicable ^RS/^RW overrides to every ZPL job; leave it off when the printer calibration should remain authoritative.",
                    "RFID read can use EPC or TID. Confirm bank, byte count, and the destination Data Feed field before read-and-print jobs.",
                ],
            },
            {
                id: "print",
                icon: <Printer className="h-4 w-4" />,
                kicker: "07",
                title: "Print, verify, and export",
                body: [
                    "The Print page uses the model, DPI, media, and protocol already selected in Edit. COM requires a selected and connected port; the Print button remains visible but disabled until the connection is ready. TCP/IP and USB-B validate their configured destination before enabling print.",
                    "Use All, First N, or From–To to control the Data Feed range. Test one representative label before a long batch, especially when RFID is enabled.",
                ],
                table: {
                    headers: ["Action", "Use"],
                    rows: [
                        ["Direct ZPL print", "Preferred for Zebra printing and required for RFID encoding."],
                        ["Print via browser", "Non-RFID fallback through the browser print dialog."],
                        ["Download .zpl", "Inspect, archive, or send the compiled Zebra job through another controlled channel."],
                        ["Export template (.nwl)", "Move the reusable design and field contract between installations."],
                        ["Publish API profile", "Expose an approved template through a stable profileId for customer systems."],
                    ],
                },
            },
            {
                id: "api",
                icon: <Code2 className="h-4 w-4" />,
                kicker: "08",
                title: "Local deployment and Integration API",
                body: [
                    "Run the Next.js application locally or on an on-prem server. For USB-B automation, run the Local Print Agent on the Windows PC that owns the Zebra printer queue. Direct browser COM printing remains interactive and cannot be initiated silently by a remote server.",
                    "The recommended customer integration publishes an approved .nwl template as a profile, then POSTs runtime values to that profile. The browser-listener render mode provides the closest match to the designer; native ZPL mode is useful for controlled debugging and supported native elements.",
                ],
                code: `${localSetup}\n\n${profileEndpoints}\n\n${printProfileRequest}`,
            },
            {
                id: "deployment",
                icon: <ListChecks className="h-4 w-4" />,
                kicker: "09",
                title: "Deployment checklist and troubleshooting",
                bullets: [
                    "Record the physical printer model, installed printhead DPI, firmware, connection method, IP/queue/baud, media, ribbon, and RFID inlay SKU.",
                    "COM: use Chrome/Edge on localhost or HTTPS; reselect the port after reload; verify the printer serial settings match the selected baud.",
                    "TCP/IP: verify the printer responds on the network and raw port 9100 is not blocked by routing or firewall policy.",
                    "USB-B: verify the Windows queue appears in the Local Print Agent; GET/status is unavailable by design.",
                    "Print a calibration ruler, verify Label Top/Left Position, then calibrate media and RFID before the acceptance batch.",
                    "Protect the local API and agent with host firewall/network policy. Do not expose printer-control endpoints directly to an untrusted network.",
                    "Archive the approved .nwl profile and test a single job plus a representative batch after every template or printer configuration change.",
                ],
            },
        ],
    },
    vi: {
        badge: "Hướng dẫn tích hợp",
        title: "Thiết kế nhãn Zebra RFID và tích hợp máy in",
        subtitle:
            "Thiết lập đúng đầu in thực tế, thiết kế theo kích thước vật lý, điều khiển máy in Zebra ZPL II, mã hóa RFID và tích hợp template đã duyệt với hệ thống khách hàng.",
        back: "Quay lại trình thiết kế",
        language: "Ngôn ngữ",
        navTitle: "Nội dung",
        quickTitle: "Quy trình khuyến nghị",
        quickItems: [
            "Chọn model Zebra, DPI đầu in thực tế và giao thức kết nối.",
            "Thiết lập media, thiết kế template và liên kết các trường Data Feed.",
            "Hiệu chuẩn media, vị trí nhãn và RFID trên máy in thật.",
            "Kiểm tra một tem trước khi in theo khoảng hoặc chạy batch sản xuất.",
            "Publish template đã duyệt thành API profile khi cần tích hợp hệ thống.",
        ],
        sections: [
            {
                id: "workflow",
                icon: <Workflow className="h-4 w-4" />,
                kicker: "01",
                title: "Luồng hoạt động của ứng dụng",
                body: [
                    "Ứng dụng đi theo luồng Choose → Edit → Print. Choose chọn template đã lưu hoặc template trống. Edit định nghĩa kích thước vật lý, dữ liệu động, máy in Zebra đích, RFID và bố cục đối tượng. Print preview các dòng dữ liệu đã resolve và gửi Zebra ZPL II qua giao thức đã chọn.",
                    "Printer settings thuộc máy trạm và máy in đang sử dụng. Nội dung template có thể di chuyển bằng file .nwl; API profile cung cấp field contract ổn định cho hệ thống khách hàng.",
                ],
                table: {
                    headers: ["Khu vực", "Chức năng"],
                    rows: [
                        ["Target printer", "Chọn Auto / Other, ZT610R hoặc ZD621R; DPI đầu in; COM, TCP/IP hoặc USB-B."],
                        ["Paper settings", "Thiết lập kích thước nhãn, gap, Label Top và Left Position theo Zebra."],
                        ["Data Feed", "Import hoặc chỉnh sửa các dòng dữ liệu động để preview và in batch."],
                        ["Printer Config", "Thiết lập media/print, Zebra RFID và đọc thông tin cấu hình khi giao thức hỗ trợ."],
                        ["Printer Control", "Theo dõi trạng thái và thực hiện Feed, Pause, Resume, Cancel Current an toàn cho operator."],
                    ],
                },
            },
            {
                id: "target",
                icon: <Gauge className="h-4 w-4" />,
                kicker: "02",
                title: "Máy in đích, DPI và kích thước vật lý",
                body: [
                    "Luôn chọn đúng DPI đang lắp trên đầu in thực tế. Profile ZT610R hỗ trợ 203, 300 hoặc 600 dpi; ZD621R hỗ trợ 203 hoặc 300 dpi. Chỉ dùng Auto / Other khi model không nằm trong danh sách của project.",
                    "Hình học template được lưu theo milimét. Khi đổi DPI, kích thước vật lý được giữ nguyên còn tọa độ printer dots, độ phân giải bitmap, kích thước QR/barcode/Data Matrix và giới hạn preflight được tính lại. Vì vậy nhãn 76 × 20 mm vẫn là 76 × 20 mm ở mọi DPI nhưng số dots sẽ khác nhau.",
                ],
                bullets: [
                    "Không chọn DPI dựa trên Windows display scale hoặc độ phân giải màn hình.",
                    "DPI template khác DPI đầu in có thể làm sai kích thước vật lý; hệ thống sẽ chặn in khi phát hiện Windows queue không khớp.",
                    "Đổi Width hoặc Height là đổi kích thước vật lý của nhãn; cần kiểm tra lại layout và print preview.",
                    "Gap là bước nhãn trong template. Máy in vẫn phải media calibration để học gap hoặc black mark thực tế.",
                ],
            },
            {
                id: "connections",
                icon: <Network className="h-4 w-4" />,
                kicker: "03",
                title: "Giao thức kết nối và khả năng hỗ trợ",
                body: [
                    "Giao thức chọn tại Target printer được dùng chung cho Print, Printer Config và Printer Control. COM sử dụng một Web Serial session dùng chung nên cổng đã chọn và kết nối vẫn được giữ khi chuyển giữa Edit và Print mà không hỏi quyền lại.",
                    "Do chính sách bảo mật trình duyệt, COM session trực tiếp sẽ mất sau khi reload hoặc mở tab mới. Khi đó cần Select Port và Connect lại. Chuyển khỏi COM sẽ ngắt serial session an toàn.",
                ],
                table: {
                    headers: ["Giao thức", "Thiết lập", "Khả năng"],
                    rows: [
                        ["COM / Serial", "Select Port → Connect; baud 9600, 38400, 57600 hoặc 115200.", "Đọc/ghi ZPL trực tiếp, live status, GET + SET. Cần Chrome/Edge trên HTTPS hoặc localhost."],
                        ["TCP/IP", "IPv4/host của máy in và cổng raw print, thông thường là 9100.", "Đọc/ghi ZPL trực tiếp, live status, GET + SET. Network route và firewall phải cho phép truy cập máy in."],
                        ["USB-B", "Zebra/Seagull Windows driver, queue name và Local Print Agent.", "Print và SET được đưa vào queue. Windows spooler không trả về phản hồi Zebra GET/status."],
                    ],
                },
            },
            {
                id: "design",
                icon: <Database className="h-4 w-4" />,
                kicker: "04",
                title: "Thiết kế template và Data Feed contract",
                steps: [
                    {
                        title: "Tạo nhãn theo kích thước vật lý",
                        body: "Chọn preset hoặc nhập Width, Height, Gap. Thêm Text, QR, Barcode, Data Matrix, Image, Line, Rectangle, Table và các trường liên quan RFID trên canvas WYSIWYG.",
                    },
                    {
                        title: "Khai báo cột dữ liệu động",
                        body: "Tạo các cột Data Feed như product_name, lot, qr_code, expired_date và rfid_id. Tên field này chính là contract tích hợp với khách hàng.",
                    },
                    {
                        title: "Liên kết giá trị",
                        body: "Dùng {field_name} trong Text, QR, Barcode, Data Matrix, Table cell hoặc RFID EPC data. Có thể import CSV/Excel để in batch và chọn từng row để preview dữ liệu đã resolve.",
                    },
                    {
                        title: "Kiểm tra preflight",
                        body: "Xử lý các cảnh báo overflow, DPI, giới hạn bề rộng model, barcode, QR và RFID trước khi duyệt template.",
                    },
                ],
            },
            {
                id: "configuration",
                icon: <Settings2 className="h-4 w-4" />,
                kicker: "05",
                title: "Media, vị trí nhãn và điều khiển máy in",
                body: [
                    "Printer Config được giới hạn ở các thông số an toàn cho operator. Media và Print gồm width/length, gap, tear-off, phương pháp in nhiệt, speed, darkness, sensor mode và paper calibration. Các thiết lập phần cứng hoặc service nâng cao vẫn do kỹ thuật viên thao tác trên máy.",
                    "Printer alignment dùng Label Top (^LT) và Left Position (^LS) của Zebra. Apply ghi giá trị xuống máy, Print ruler in tem thước hiệu chỉnh, Reset đưa hai giá trị về 0.",
                ],
                bullets: [
                    "Transmissive (gap/web) dùng cho tem bế có khoảng hở giữa hai nhãn.",
                    "Reflective (black mark) dùng cho media có vạch đánh dấu ở liner hoặc mặt sau.",
                    "Continuous không dùng gap/mark sensor và chạy theo label length đã cấu hình.",
                    "Printer Control gồm Refresh Status, Feed, Pause, Resume và Cancel Current. Cancel Current đồng thời để Zebra ở trạng thái pause; cần Resume để chạy tiếp.",
                    "Các chức năng GET bị khóa với USB-B vì Windows spooler là đường giao tiếp một chiều ở tầng ứng dụng này.",
                ],
            },
            {
                id: "rfid",
                icon: <Radio className="h-4 w-4" />,
                kicker: "06",
                title: "Thiết lập và kiểm tra Zebra RFID",
                body: [
                    "Cần hiệu chuẩn inlay trên ZT610R hoặc ZD621R thật trước khi sản xuất. Printer calibrated giữ program position đã lưu trong máy. Forward/Backward chỉ thêm program position Zebra RFID rõ ràng khi media yêu cầu.",
                    "Read power và Write power bằng -1 nghĩa là giữ giá trị đã hiệu chuẩn trong máy. Attempts và error handling áp dụng khi dùng vị trí Forward/Backward. Hãy kiểm tra một tag thật sau mỗi lần thay media, ribbon, inlay hoặc đường truyền antenna.",
                ],
                bullets: [
                    "EPC phải là dữ liệu hexadecimal gồm 0-9 và A-F.",
                    "EPC-96 thường có 24 ký tự hex; EPC-128 thường có 32 ký tự hex.",
                    "SET RFID lưu các thông số position và power được hỗ trợ vào máy in.",
                    "Also embed in print jobs thêm các override ^RS/^RW phù hợp vào mỗi ZPL job; nên tắt khi muốn calibration trong máy là nguồn cấu hình chính.",
                    "RFID read có thể dùng EPC hoặc TID. Cần xác nhận bank, byte count và Data Feed field đích trước job read-and-print.",
                ],
            },
            {
                id: "print",
                icon: <Printer className="h-4 w-4" />,
                kicker: "07",
                title: "In, xác minh và export",
                body: [
                    "Trang Print sử dụng model, DPI, media và protocol đã chọn trong Edit. COM cần Select Port và Connect; nút Print luôn hiển thị nhưng chỉ được bật khi kết nối sẵn sàng. TCP/IP và USB-B kiểm tra destination đã cấu hình trước khi cho phép in.",
                    "Dùng All, First N hoặc From–To để chọn phạm vi Data Feed. Nên test một tem đại diện trước batch dài, đặc biệt khi bật RFID.",
                ],
                table: {
                    headers: ["Thao tác", "Mục đích"],
                    rows: [
                        ["Direct ZPL print", "Luồng khuyến nghị cho Zebra và bắt buộc khi cần encode RFID."],
                        ["Print via browser", "Phương án dự phòng không RFID thông qua browser print dialog."],
                        ["Download .zpl", "Kiểm tra, lưu trữ hoặc gửi job Zebra qua một kênh được kiểm soát khác."],
                        ["Export template (.nwl)", "Di chuyển thiết kế tái sử dụng và field contract giữa các máy cài đặt."],
                        ["Publish API profile", "Cung cấp template đã duyệt qua profileId ổn định cho hệ thống khách hàng."],
                    ],
                },
            },
            {
                id: "api",
                icon: <Code2 className="h-4 w-4" />,
                kicker: "08",
                title: "Triển khai local và Integration API",
                body: [
                    "Chạy ứng dụng Next.js tại máy local hoặc server on-prem. Với USB-B automation, Local Print Agent phải chạy trên PC Windows đang sở hữu Zebra printer queue. Luồng COM trực tiếp trong browser cần user tương tác và không thể được server từ xa âm thầm kích hoạt.",
                    "Luồng tích hợp khuyến nghị là publish file .nwl đã duyệt thành profile, sau đó POST runtime values vào profile đó. Render mode browser-listener cho kết quả gần giao diện thiết kế nhất; native ZPL phù hợp debug có kiểm soát và các element native được hỗ trợ.",
                ],
                code: `${localSetup}\n\n${profileEndpoints}\n\n${printProfileRequest}`,
            },
            {
                id: "deployment",
                icon: <ListChecks className="h-4 w-4" />,
                kicker: "09",
                title: "Checklist triển khai và xử lý sự cố",
                bullets: [
                    "Ghi nhận model máy in, DPI đầu in, firmware, giao thức, IP/queue/baud, loại media, ribbon và mã inlay RFID thực tế.",
                    "COM: dùng Chrome/Edge trên localhost hoặc HTTPS; chọn lại port sau reload; baud trên máy in phải khớp baud đã chọn.",
                    "TCP/IP: kiểm tra máy in truy cập được qua mạng và raw port 9100 không bị route hoặc firewall chặn.",
                    "USB-B: kiểm tra Windows queue xuất hiện trong Local Print Agent; GET/status không được hỗ trợ theo thiết kế.",
                    "In calibration ruler, kiểm tra Label Top/Left Position, sau đó calibration media và RFID trước batch nghiệm thu.",
                    "Bảo vệ local API và agent bằng host firewall/network policy. Không expose printer-control endpoints trực tiếp ra mạng không tin cậy.",
                    "Lưu trữ profile .nwl đã duyệt và test một job đơn cùng một batch đại diện sau mỗi lần đổi template hoặc printer configuration.",
                ],
            },
        ],
    },
};

export default function IntegrationGuidePage() {
    const [lang, setLang] = useState<Lang>("en");
    const t = docs[lang];

    useEffect(() => {
        const previousDocumentLanguage = document.documentElement.lang;
        let stored: string | null = null;
        try {
            stored = window.localStorage.getItem(GUIDE_LANGUAGE_KEY);
        } catch {
            // Continue with the browser preference when storage is unavailable.
        }
        const preferred: Lang =
            stored === "en" || stored === "vi"
                ? stored
                : navigator.language.toLowerCase().startsWith("vi")
                  ? "vi"
                  : "en";
        // Restore the explicit choice, otherwise follow the browser language.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLang(preferred);
        document.documentElement.lang = preferred;
        return () => {
            document.documentElement.lang = previousDocumentLanguage;
        };
    }, []);

    const selectLanguage = (next: Lang) => {
        setLang(next);
        try {
            window.localStorage.setItem(GUIDE_LANGUAGE_KEY, next);
        } catch {
            // The current page still switches language when storage is unavailable.
        }
        document.documentElement.lang = next;
    };

    return (
        <main lang={lang} className="min-h-screen bg-background text-foreground">
            <header className="sticky top-0 z-30 border-b border-black/[0.08] bg-background/92 backdrop-blur dark:border-white/[0.08]">
                <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-5 py-3">
                    <Button asChild variant="outline" size="sm">
                        <Link href="/">
                            <ArrowLeft className="h-4 w-4" />
                            {t.back}
                        </Link>
                    </Button>
                    <div className="flex items-center gap-2">
                        <span className="hidden items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:inline-flex">
                            <Languages className="h-3.5 w-3.5" />
                            {t.language}
                        </span>
                        <div
                            className="inline-flex rounded-[8px] bg-black/[0.04] p-1 dark:bg-white/[0.06]"
                            aria-label={t.language}
                        >
                            <LangButton
                                active={lang === "en"}
                                onClick={() => selectLanguage("en")}
                            >
                                English
                            </LangButton>
                            <LangButton
                                active={lang === "vi"}
                                onClick={() => selectLanguage("vi")}
                            >
                                Tiếng Việt
                            </LangButton>
                        </div>
                    </div>
                </div>
            </header>

            <section className="border-b border-black/[0.06] bg-muted/30 dark:border-white/[0.06]">
                <div className="mx-auto max-w-7xl px-5 py-8">
                    <div className="max-w-4xl space-y-4">
                        <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/25 bg-blue-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
                            <BookOpen className="h-3.5 w-3.5" />
                            {t.badge}
                        </div>
                        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                            {t.title}
                        </h1>
                        <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
                            {t.subtitle}
                        </p>
                    </div>
                </div>
            </section>

            <div className="mx-auto grid max-w-7xl grid-cols-1 gap-8 px-5 py-6 lg:grid-cols-[260px_minmax(0,1fr)]">
                <aside className="lg:sticky lg:top-20 lg:self-start">
                    <nav className="rounded-[10px] border border-black/[0.08] bg-background p-3 dark:border-white/[0.08]">
                        <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {t.navTitle}
                        </div>
                        <div className="space-y-1">
                            {t.sections.map((section) => (
                                <a
                                    key={section.id}
                                    href={`#${section.id}`}
                                    className="flex items-center gap-2 rounded-[7px] px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                >
                                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-blue-500/10 text-blue-700 dark:text-blue-300">
                                        {section.icon}
                                    </span>
                                    <span className="truncate">{section.title}</span>
                                </a>
                            ))}
                        </div>
                    </nav>

                    <div className="mt-4 rounded-[10px] border border-black/[0.08] bg-background p-4 dark:border-white/[0.08]">
                        <div className="mb-3 text-sm font-semibold">{t.quickTitle}</div>
                        <ol className="space-y-2 text-xs leading-5 text-muted-foreground">
                            {t.quickItems.map((item, index) => (
                                <li key={item} className="flex gap-2">
                                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10px] text-foreground">
                                        {index + 1}
                                    </span>
                                    <span>{item}</span>
                                </li>
                            ))}
                        </ol>
                    </div>
                </aside>

                <article className="min-w-0 space-y-5">
                    {t.sections.map((section) => (
                        <DocArticleSection key={section.id} section={section} />
                    ))}
                </article>
            </div>
        </main>
    );
}

function DocArticleSection({ section }: { section: DocSection }) {
    return (
        <section
            id={section.id}
            className="scroll-mt-24 rounded-[12px] border border-black/[0.08] bg-background p-5 dark:border-white/[0.08]"
        >
            <div className="mb-4 flex items-start gap-3">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-blue-500/10 text-blue-700 dark:text-blue-300">
                    {section.icon}
                </span>
                <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {section.kicker}
                    </div>
                    <h2 className="text-xl font-semibold tracking-tight">{section.title}</h2>
                </div>
            </div>

            {section.body && (
                <div className="space-y-3 text-sm leading-6 text-muted-foreground">
                    {section.body.map((paragraph) => (
                        <p key={paragraph}>{paragraph}</p>
                    ))}
                </div>
            )}

            {section.steps && (
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                    {section.steps.map((step, index) => (
                        <div
                            key={step.title}
                            className="rounded-[9px] border border-black/[0.06] bg-muted/30 p-3 dark:border-white/[0.06]"
                        >
                            <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background font-mono text-[11px]">
                                    {index + 1}
                                </span>
                                {step.title}
                            </div>
                            <p className="text-xs leading-5 text-muted-foreground">{step.body}</p>
                        </div>
                    ))}
                </div>
            )}

            {section.bullets && (
                <ul className="mt-4 space-y-2 text-sm leading-6 text-muted-foreground">
                    {section.bullets.map((item) => (
                        <li key={item} className="flex gap-2">
                            <CheckCircle2 className="mt-1 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                            <span>{item}</span>
                        </li>
                    ))}
                </ul>
            )}

            {section.table && <DocTable table={section.table} />}
            {section.code && <CodeBlock code={section.code} />}
        </section>
    );
}

function DocTable({ table }: { table: DocTable }) {
    return (
        <div className="mt-4 overflow-x-auto rounded-[9px] border border-black/[0.08] dark:border-white/[0.08]">
            <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                <thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                        {table.headers.map((header) => (
                            <th
                                key={header}
                                className="border-b border-black/[0.08] px-3 py-2 font-semibold dark:border-white/[0.08]"
                            >
                                {header}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {table.rows.map((row) => (
                        <tr
                            key={row.join("|")}
                            className="border-b border-black/[0.06] last:border-b-0 dark:border-white/[0.06]"
                        >
                            {row.map((cell, index) => (
                                <td
                                    key={`${cell}-${index}`}
                                    className={cn(
                                        "px-3 py-2 align-top text-muted-foreground",
                                        index === 0 &&
                                            "whitespace-nowrap font-mono text-xs font-semibold text-foreground",
                                    )}
                                >
                                    {cell}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function LangButton({
    active,
    children,
    onClick,
}: {
    active: boolean;
    children: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                "h-8 rounded-[6px] px-3 text-xs font-semibold transition-colors",
                active
                    ? "bg-white text-foreground shadow-sm ring-1 ring-black/[0.04] dark:bg-neutral-800 dark:ring-white/10"
                    : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]",
            )}
        >
            {children}
        </button>
    );
}

function CodeBlock({ code }: { code: string }) {
    return (
        <pre className="mt-4 overflow-x-auto rounded-[9px] bg-neutral-950 p-4 text-xs leading-5 text-neutral-100">
            <code>{code}</code>
        </pre>
    );
}
