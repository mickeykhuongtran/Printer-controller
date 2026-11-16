import type { LabelDoc } from "./types";

// Sample values used to render template thumbnails with realistic-looking
// data instead of raw {variable} placeholders. Resolution is thumbnail-only:
// the source LabelDoc is not mutated, so when the user clicks "Use this" the
// cloned template still carries its variable bindings for the data feed.
//
// Keys are lowercased to match the case-insensitive built-in placeholder
// behavior. Add a key here whenever a new template introduces a new
// placeholder name.
export const SAMPLE_VARS: Record<string, string> = {
    // Built-in / serial-ish
    serial: "AST-000123",
    step: "3",
    n: "3",
    counter: "3",
    index: "3",
    row: "3",
    rfid_epc_encode: "30140F21880C0000000001",

    // Generic product
    name: "Sample Product",
    sku: "SKU-1024",
    price: "$24.99",
    discount: "30% OFF",
    material: "925 Silver",
    weight: "12.5",
    expires: "12/2026",
    lot: "L24-082",
    kcal: "210",

    // Wine
    vintage: "2019",
    winery: "Maison Lumière",
    variety: "Pinot Noir",
    region: "Burgundy, FR",
    abv: "13.5",

    // Apparel / footwear / eyewear / jewelry
    brand: "Northwave",
    model: "X1 Pro",
    size: "M",
    color: "Charcoal",
    shade: "Rose Petal",

    // IT / network / infra
    mac: "00:1A:2B:3C:4D:5E",
    ip: "10.0.12.45",
    hostname: "srv-prod-02",
    rack: "B12",
    u: "14",
    mfg_date: "2024-08-12",

    // Vehicle / fleet
    vin: "1HGCM82633A004352",
    make: "Ford",
    plate: "AB-12-CD",

    // Furniture / room
    room: "Office 4B",
    type: "Desk",

    // Lab / cal
    cal_date: "2025-09-01",
    cal_due: "2026-09-01",
    owner: "Dr. Chen",

    // Inventory / warehouse
    description: "16mm Hex Wrench",
    bin_id: "A-12-03",
    shelf: "S03",
    location: "AISLE 04",
    zone: "Z2",
    aisle: "A04",
    bay: "B12",
    order_id: "PO-208714",
    qty: "12",
    contents: "Mixed Bolts",
    capacity: "20 kg",
    station: "ST-04",
    total: "8",
    part: "PN-A4012",
    length: "500",

    // Office / files / cables
    file_id: "F-2026-1182",
    date: "2026-05-09",
    box: "BX-04",
    label: "PORT",
    port: "GE 1/0/24",
    company: "Nextwaves",
    title: "Operations Lead",
    department: "Logistics",
    contact: "vcard:bd@nextwaves.com",
    category: "Records",

    // Logistics / shipping
    container_id: "MSCU 4928174",
    seal: "SEAL 88241",
    carrier: "DHL",
    crate_id: "C-001234",
    return_to: "Returns Hub",
    return_addr: "1 Logistics Way",
    po: "PO-208714",
    pieces: "48",
    carton_id: "CTN-018241",
    country: "USA",
    street: "123 Example St",
    city: "New York, NY",
    zip: "10001",
    from_name: "Nextwaves",
    from_addr: "1 Industrial Pkwy",
    to_name: "ACME Corp",
    to_addr: "456 Market St",
    to_city: "Austin TX 78701",
    tracking: "1Z999AA10123456784",
    class: "First-Class",
    rma: "RMA-44721",

    // Healthcare
    patient_id: "MRN-882104",
    patient_name: "J. Doe",
    hospital: "St. Mary's",
    dob: "1985-03-12",
    allergy: "Penicillin",
    collect_date: "2026-05-08",
    rx_id: "RX-12048",
    drug_name: "Amoxicillin 500 mg",
    dose: "1 cap, 3× daily",
    doctor: "Dr. Patel",
    donor_id: "D-009842",
    blood_type: "O+",
    volume: "450",

    // Gift / event / electronics / grocery / archive
    to: "Sarah",
    from: "Alex",
    message: "Happy Birthday!",
    event_name: "TechConf 2026",
    event_role: "Speaker",
    event_date: "2026-06-15",
    power: "65 W",
    voltage: "100-240 V",
    dimensions: "120×80×20 mm",
    cert: "FCC, CE",
    unit_price: "$3.45 / kg",
    box_id: "ARC-2026-018",
    contents_list: "Q1 invoices, contracts",
    date_range: "Jan – Mar 2026",

    // Library / uniform / artwork / keg / medical device
    call_number: "QA76.73 .P98",
    author: "G. Roberts",
    isbn: "9781449357351",
    dept: "Housekeeping",
    cycle: "42",
    artist: "Maya Lin",
    year: "1982",
    accession: "ACC-1985-0142",
    keg_id: "KEG-001284",
    beverage: "Pilsner Lager",
    device: "Infusion Pump",
    service_date: "2026-02-14",
    service_due: "2026-08-14",
};

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const BUILTIN_SERIAL_NAMES = new Set(["serial", "step", "n", "counter", "index", "row"]);

function formatSerialPreview(doc: LabelDoc): string | null {
    const s = doc.settings.serial;
    if (!s.enabled) return null;
    const num = String(s.start).padStart(Math.max(1, s.pad), "0");
    return s.prefix ? `${s.prefix}-${num}` : num;
}

// Resolve {placeholder} tokens to realistic sample text for thumbnail
// rendering only. Leaves unknown tokens intact so they're still visible (which
// is more honest than blanking them out). The source doc is not mutated.
export function resolveDocForThumbnail(doc: LabelDoc): LabelDoc {
    const liveSerial = formatSerialPreview(doc);
    const rewrite = (value: string): string =>
        value.replace(PLACEHOLDER_RE, (full, rawName: string) => {
            const key = rawName.toLowerCase();
            if (BUILTIN_SERIAL_NAMES.has(key)) {
                return liveSerial ?? SAMPLE_VARS[key] ?? SAMPLE_VARS.serial ?? full;
            }
            const v = SAMPLE_VARS[key];
            return v !== undefined ? v : full;
        });
    return {
        ...doc,
        elements: doc.elements.map((el) => {
            if (el.kind === "text") return { ...el, text: rewrite(el.text) };
            if (el.kind === "qr") return { ...el, data: rewrite(el.data) };
            if (el.kind === "barcode") return { ...el, data: rewrite(el.data) };
            if (el.kind === "datamatrix") return { ...el, data: rewrite(el.data) };
            return el;
        }),
    };
}
