import type {
    BarcodeEl,
    ZplFont,
    ImageEl,
    LabelDoc,
    LabelSettings,
    NwsLabelProfile,
    LineEl,
    QrEl,
    RectEl,
    RfidSettings,
    TemplateCategory,
    TextEl,
} from "./types";
import { DEFAULT_ICON_WEIGHT, findIconById, svgToDataUrl } from "./icons";
import { DEFAULT_TEXT_MARGIN_MM } from "./text-margin";

// Zebra ZPL bitmap-font printed cell heights, in mm at 203 DPI.
// We map these onto the System font's `fontSizeMm` so the on-screen render
// preserves the historical sizing the templates were laid out for.
const ZPL_FONT_HEIGHT_MM: Record<ZplFont, number> = {
    A: (9 / 203) * 25.4,
    B: (12 / 203) * 25.4,
    D: (18 / 203) * 25.4,
    E: (28 / 203) * 25.4,
};

function defaultSettings(overrides: Partial<LabelSettings> = {}): LabelSettings {
    return {
        widthMm: 60,
        heightMm: 40,
        gapMm: 3,
        dpi: 300,
        copies: 1,
        speed: 4,
        darkness: 10,
        printMode: "thermal_transfer",
        sensorMode: 1,
        startOffsetDots: 0,
        rowOffsetDots: 0,
        codePage: 850,
        serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
        rfid: {
            enabled: false,
            chip: "epc_96",
            epcBits: 96,
            autoEpcBitsFromData: false,
            format: "H",
            retries: 3,
            block: 2,
            words: 6,
            data: "",
            zebraModel: "auto",
            zebraUsePrinterSettings: true,
            zebraPositionMode: "calibrated",
            zebraEpcReadMode: "pc",
        },
        ...overrides,
    };
}

function rfidOn(overrides: Partial<RfidSettings> = {}): RfidSettings {
    return {
        enabled: true,
        chip: "epc_96",
        epcBits: 96,
        autoEpcBitsFromData: false,
        format: "H",
        retries: 3,
        block: 2,
        words: 6,
        data: "{serial}",
        fieldName: "serial",
        zebraModel: "auto",
        zebraUsePrinterSettings: true,
        zebraPositionMode: "calibrated",
        zebraEpcReadMode: "pc",
        ...overrides,
    };
}

type NwsLabelSpec = NwsLabelProfile["media"] & NwsLabelProfile["rfid"] & {
    sizeLabel: string;
    profileId: string;
};

const NWS_LABEL_SPECS = {
    "45x20": {
        sizeLabel: "45x20mm",
        profileId: "nws-45x20-v1",
        widthMm: 45,
        heightMm: 20,
        gapMm: 3,
        dpi: 203,
        speed: 3,
        darkness: 11,
        printMode: "thermal_transfer",
        sensorMode: 1,
        startOffsetDots: 0,
        rowOffsetDots: 0,
        codePage: 850,
        power: 20,
        writePositionMm: 10,
    },
    "60x40": {
        sizeLabel: "60x40mm",
        profileId: "nws-60x40-v1",
        widthMm: 60,
        heightMm: 40,
        gapMm: 3,
        dpi: 203,
        speed: 4,
        darkness: 10,
        printMode: "thermal_transfer",
        sensorMode: 1,
        startOffsetDots: 0,
        rowOffsetDots: 0,
        codePage: 850,
        power: 22,
        writePositionMm: 20,
    },
    "80x30": {
        sizeLabel: "80x30mm",
        profileId: "nws-80x30-v1",
        widthMm: 80,
        heightMm: 30,
        gapMm: 3,
        dpi: 203,
        speed: 4,
        darkness: 10,
        printMode: "thermal_transfer",
        sensorMode: 1,
        startOffsetDots: 0,
        rowOffsetDots: 0,
        codePage: 850,
        power: 24,
        writePositionMm: 15,
    },
    "100x30": {
        sizeLabel: "100x30mm",
        profileId: "nws-100x30-v1",
        widthMm: 100,
        heightMm: 30,
        gapMm: 3,
        dpi: 203,
        speed: 4,
        darkness: 11,
        printMode: "thermal_transfer",
        sensorMode: 1,
        startOffsetDots: 0,
        rowOffsetDots: 0,
        codePage: 850,
        power: 24,
        writePositionMm: 15,
    },
} satisfies Record<string, NwsLabelSpec>;

function nwsProfile(spec: NwsLabelSpec): NwsLabelProfile {
    return {
        sizeLabel: spec.sizeLabel,
        profileId: spec.profileId,
        media: {
            widthMm: spec.widthMm,
            heightMm: spec.heightMm,
            gapMm: spec.gapMm,
            speed: spec.speed,
            darkness: spec.darkness,
            dpi: spec.dpi,
            printMode: spec.printMode,
            sensorMode: spec.sensorMode,
            startOffsetDots: spec.startOffsetDots,
            rowOffsetDots: spec.rowOffsetDots,
            codePage: spec.codePage,
        },
        rfid: {
            power: spec.power,
            writePositionMm: spec.writePositionMm,
        },
    };
}

function nwsSettings(spec: NwsLabelSpec, serialPrefix: string): LabelSettings {
    return defaultSettings({
        widthMm: spec.widthMm,
        heightMm: spec.heightMm,
        gapMm: spec.gapMm,
        dpi: spec.dpi,
        speed: spec.speed,
        darkness: spec.darkness,
        printMode: spec.printMode,
        sensorMode: spec.sensorMode,
        startOffsetDots: spec.startOffsetDots,
        rowOffsetDots: spec.rowOffsetDots,
        codePage: spec.codePage,
        serial: { enabled: true, start: 1, step: 1, pad: 6, prefix: serialPrefix },
        rfid: rfidOn({
            data: "{serial}",
            fieldName: undefined,
            power: spec.power,
            writePositionMm: spec.writePositionMm,
        }),
    });
}

// Element builders. Defaults match the most common element shape so each
// template stays compact; pass an `opts` object to override.
let _eid = 0;
const eid = (prefix: string) => `${prefix}${++_eid}`;

const T = (
    text: string,
    x: number,
    y: number,
    w: number,
    h: number,
    opts: Partial<TextEl> = {},
): TextEl => {
    // Resolve ZPL font + scale (opts override defaults) so we can derive the
    // matching System-font `fontSizeMm`. ZPL fields stay populated as a
    // fallback for any path that still rasterises bitmap glyphs.
    const font: ZplFont = (opts.font ?? "B") as ZplFont;
    const scaleY = (opts.scaleY ?? 1) as number;
    let fontSizeMm = ZPL_FONT_HEIGHT_MM[font] * scaleY;
    // Bold web fonts overflow their ZPL-derived bounding box because system
    // fonts include ascent/descent in the em-box (whereas bitmap cells are
    // already padded). Pull the size in slightly so bold titles still fit.
    if ((opts.fontWeight ?? 400) >= 600) {
        fontSizeMm *= 0.82;
    }
    return {
        id: eid("t"),
        kind: "text",
        marginMm: DEFAULT_TEXT_MARGIN_MM,
        pos: { x, y },
        size: { w, h },
        text,
        font: "B",
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        fontSource: "system",
        fontFamily: "System Sans",
        fontSizeMm,
        ...opts,
    };
};

const QR = (
    data: string,
    x: number,
    y: number,
    s: number,
    opts: Partial<QrEl> = {},
): QrEl => {
    const magnification = typeof opts.magnification === "number" && opts.magnification > 0
        ? Math.min(10, Math.round(opts.magnification))
        : undefined;
    return {
        id: eid("q"),
        kind: "qr",
        pos: { x, y },
        size: { w: s, h: s },
        data,
        rotation: 0,
        ecc: "M",
        cell: opts.cell ?? magnification ?? 4,
        sizeMode: magnification ? "manual" : "auto",
        quietZoneModules: 4,
        minModuleMm: 0.33,
        version: 0,
        align: "center",
        verticalAlign: "center",
        ...opts,
        magnification,
    };
};

const BC = (
    data: string,
    x: number,
    y: number,
    w: number,
    h: number,
    opts: Partial<BarcodeEl> = {},
): BarcodeEl => ({
    id: eid("b"),
    kind: "barcode",
    pos: { x, y },
    size: { w, h },
    data,
    rotation: 0,
    symbology: "CODE128",
    humanReadable: true,
    align: "center",
    sizeMode: "auto",
    minModuleMm: 0.25,
    textSizeMm: 2,
    textPaddingMm: 0.3,
    textPosition: "below",
    textAlign: "center",
    ...opts,
});

const HR = (x: number, y: number, w: number, thickness = 0.3): LineEl => ({
    id: eid("l"),
    kind: "line",
    pos: { x, y },
    size: { w, h: thickness },
    orientation: "h",
    thickness,
});

const VR = (x: number, y: number, h: number, thickness = 0.3): LineEl => ({
    id: eid("l"),
    kind: "line",
    pos: { x, y },
    size: { w: thickness, h },
    orientation: "v",
    thickness,
});

const RECT = (
    x: number,
    y: number,
    w: number,
    h: number,
    opts: Partial<RectEl> = {},
): RectEl => ({
    id: eid("r"),
    kind: "rect",
    pos: { x, y },
    size: { w, h },
    thickness: 0.3,
    filled: false,
    ...opts,
});

// Empty image placeholder. Renders the dashed "Choose image" affordance the
// user can click to upload a logo or photo (see ImageElement.tsx:83-110).
// This is what makes every template "logo-ready" out of the box.
const LOGO = (x: number, y: number, w: number, h: number): ImageEl => ({
    id: eid("img"),
    kind: "image",
    pos: { x, y },
    size: { w, h },
    src: "",
    threshold: 0,
});

// Pre-filled icon element from the built-in library. Provides a visual
// category cue (RFID badge, tag, truck, …) on every template without the
// user having to add icons themselves. Falls back to an empty placeholder
// if the icon ID is unknown.
const ICON = (iconId: string, x: number, y: number, s: number): ImageEl => {
    const def = findIconById(iconId);
    return {
        id: eid("img"),
        kind: "image",
        pos: { x, y },
        size: { w: s, h: s },
        src: def ? svgToDataUrl(def.svg) : "",
        iconId,
        iconWeight: DEFAULT_ICON_WEIGHT,
        threshold: 0,
    };
};

// Solid filled rectangle for accent bars / banners (SALE, RETURN headers).
// Filled rects ignore stroke thickness so we set it to 0.
const FILL = (x: number, y: number, w: number, h: number): RectEl => ({
    id: eid("r"),
    kind: "rect",
    pos: { x, y },
    size: { w, h },
    thickness: 0,
    filled: true,
});

// =========================================================================
// NON-RFID TEMPLATES (30)
// =========================================================================

const product60x40: LabelDoc = {
    id: "tpl_product_60x40",
    name: "Product 60×40",
    builtIn: true,
    category: "product",
    tags: ["qr", "code128", "price"],
    settings: defaultSettings({ widthMm: 60, heightMm: 40 }),
    elements: [
        RECT(2, 2, 56, 36, { thickness: 0.4 }),
        LOGO(4, 4, 12, 7),
        ICON("tag", 49, 4, 6),
        T("{name}", 18, 4, 30, 5, { font: "D", fontWeight: 700 }),
        T("{sku}", 18, 10, 30, 4),
        HR(4, 14, 52, 0.3),
        T("{price}", 4, 16, 34, 8, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        QR("{sku}", 40, 17, 15),
        HR(4, 31, 52, 0.3),
        T("60×40 mm", 4, 32, 52, 4, { align: "center" }),
    ],
};

const productPremium70x40: LabelDoc = {
    id: "tpl_product_premium_70x40",
    name: "Product Premium 70×40",
    builtIn: true,
    category: "product",
    tags: ["qr", "premium", "price"],
    settings: defaultSettings({ widthMm: 70, heightMm: 40 }),
    elements: [
        RECT(2, 2, 66, 36, { thickness: 0.5 }),
        LOGO(4, 4, 12, 7),
        ICON("price-tag", 58, 4, 6),
        T("PREMIUM", 18, 4, 38, 3, { fontWeight: 600, align: "center" }),
        T("{name}", 18, 8, 38, 5, { font: "D", fontWeight: 700, align: "center" }),
        HR(6, 14, 58, 0.3),
        T("{sku}", 4, 16, 30, 4),
        T("{price}", 4, 22, 44, 8, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700 }),
        QR("{sku}", 50, 16, 14),
        HR(4, 32, 58, 0.3),
        T("Made in {country}", 4, 33, 60, 3, { align: "center" }),
    ],
};

const promoTag50x30: LabelDoc = {
    id: "tpl_promo_50x30",
    name: "Promo Tag 50×30",
    builtIn: true,
    category: "product",
    tags: ["sale", "promo", "code128"],
    settings: defaultSettings({ widthMm: 50, heightMm: 30 }),
    elements: [
        RECT(2, 2, 46, 26, { thickness: 0.6 }),
        FILL(2, 2, 46, 7),
        LOGO(3, 3, 10, 5),
        ICON("price-tag", 39, 3, 5),
        T("SALE", 14, 3, 24, 5, { font: "D", fontWeight: 700, align: "center" }),
        T("{discount}", 4, 10, 42, 6, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700, align: "center" }),
        T("{name}", 4, 18, 42, 3, { fontWeight: 600, align: "center" }),
        BC("{sku}", 6, 22, 38, 5, { humanReadable: false }),
    ],
};

const priceTag40x25: LabelDoc = {
    id: "tpl_price_40x25",
    name: "Price Tag 40×25",
    builtIn: true,
    category: "retail",
    tags: ["price", "code128"],
    settings: defaultSettings({ widthMm: 40, heightMm: 25 }),
    elements: [
        LOGO(2, 2, 10, 5),
        ICON("tag", 33, 2, 5),
        T("{name}", 13, 2, 19, 3, { fontWeight: 700 }),
        T("{price}", 2, 7, 36, 7, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700, align: "center" }),
        BC("{sku}", 2, 15, 36, 6, { textSize: 2 }),
        T("{sku}", 2, 22, 36, 2, { align: "center" }),
    ],
};

const jewelryTag50x20: LabelDoc = {
    id: "tpl_jewelry_50x20",
    name: "Jewelry Tag 50×20",
    builtIn: true,
    category: "retail",
    tags: ["jewelry", "qr", "small"],
    settings: defaultSettings({ widthMm: 50, heightMm: 20 }),
    elements: [
        LOGO(2, 2, 9, 5),
        ICON("star", 12, 2, 4),
        T("{sku}", 17, 2, 16, 4, { font: "D", fontWeight: 700 }),
        T("{material}", 2, 8, 31, 3),
        T("{price}", 2, 11, 31, 7, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        QR("{sku}", 34, 2, 14),
    ],
};

const apparelHangtag50x80: LabelDoc = {
    id: "tpl_apparel_50x80",
    name: "Apparel Hangtag 50×80",
    builtIn: true,
    category: "retail",
    tags: ["apparel", "hangtag", "qr", "code128"],
    settings: defaultSettings({ widthMm: 50, heightMm: 80 }),
    elements: [
        LOGO(3, 3, 14, 8),
        ICON("tag", 33, 3, 7),
        T("{brand}", 3, 13, 44, 4, { fontWeight: 700, align: "center" }),
        HR(6, 18, 38, 0.3),
        T("{name}", 3, 20, 44, 5, { font: "D", fontWeight: 700, align: "center" }),
        T("SIZE", 3, 28, 44, 3, { fontWeight: 600, align: "center" }),
        T("{size}", 3, 32, 44, 8, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700, align: "center" }),
        HR(6, 43, 38, 0.3),
        T("{color}", 3, 45, 44, 4, { align: "center" }),
        QR("{sku}", 17, 50, 16),
        BC("{sku}", 4, 67, 42, 5),
        HR(6, 73, 38, 0.3),
        T("{price}", 3, 74, 44, 6, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700, align: "center" }),
    ],
};

const wineBottle80x40: LabelDoc = {
    id: "tpl_wine_80x40",
    name: "Wine Bottle 80×40",
    builtIn: true,
    category: "product",
    tags: ["wine", "elegant"],
    settings: defaultSettings({ widthMm: 80, heightMm: 40 }),
    elements: [
        RECT(2, 2, 76, 36, { thickness: 0.5 }),
        LOGO(4, 4, 12, 7),
        ICON("bottle", 68, 4, 6),
        T("{vintage}", 18, 4, 50, 6, { font: "D", fontWeight: 700, align: "center" }),
        HR(20, 12, 40, 0.3),
        T("{winery}", 4, 14, 72, 5, { font: "D", fontWeight: 700, align: "center" }),
        T("{variety}", 4, 21, 72, 4, { align: "center" }),
        T("{region}", 4, 26, 72, 3, { align: "center" }),
        HR(20, 31, 40, 0.3),
        T("Alc. {abv}% Vol", 4, 33, 72, 3, { align: "center" }),
    ],
};

const foodNutrition60x40: LabelDoc = {
    id: "tpl_food_60x40",
    name: "Food Nutrition 60×40",
    builtIn: true,
    category: "product",
    tags: ["food", "nutrition", "ean13"],
    settings: defaultSettings({ widthMm: 60, heightMm: 40 }),
    elements: [
        LOGO(3, 2, 12, 6),
        ICON("apple", 51, 2, 6),
        T("{name}", 17, 3, 32, 5, { font: "D", fontWeight: 700 }),
        HR(3, 9, 54, 0.3),
        ICON("scale", 3, 10, 3),
        T("Net Weight: {weight}", 7, 10, 50, 3),
        ICON("expiry", 3, 14, 3),
        T("Best Before: {expires}", 7, 14, 50, 3),
        ICON("tag", 3, 18, 3),
        T("Lot: {lot}", 7, 18, 26, 3),
        T("Cal: {kcal}", 33, 18, 24, 3),
        BC("5901234123457", 3, 24, 54, 13, { symbology: "EAN13", textSize: 2 }),
    ],
};

const shipping100x60: LabelDoc = {
    id: "tpl_shipping_100x60",
    name: "Shipping 100×60",
    builtIn: true,
    category: "shipping",
    tags: ["address", "tracking", "code128"],
    settings: defaultSettings({ widthMm: 100, heightMm: 60 }),
    elements: [
        LOGO(3, 3, 16, 8),
        ICON("truck", 88, 3, 8),
        T("FROM", 22, 3, 40, 3, { fontWeight: 600 }),
        T("Nextwaves Logistics", 22, 7, 60, 4, { font: "D", fontWeight: 700 }),
        HR(4, 14, 92, 0.4),
        T("SHIP TO", 4, 16, 40, 3, { fontWeight: 600 }),
        T("{to_name}", 4, 21, 92, 6, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        T("{to_addr}", 4, 30, 92, 4, { font: "D" }),
        T("{to_city}", 4, 36, 92, 4, { font: "D" }),
        BC("{tracking}", 4, 44, 92, 12),
    ],
};

const shippingCompact80x50: LabelDoc = {
    id: "tpl_shipping_compact_80x50",
    name: "Shipping Compact 80×50",
    builtIn: true,
    category: "shipping",
    tags: ["address", "compact", "code128"],
    settings: defaultSettings({ widthMm: 80, heightMm: 50 }),
    elements: [
        LOGO(3, 2, 12, 6),
        ICON("package", 70, 2, 6),
        T("FROM:", 18, 2, 30, 3, { fontWeight: 600 }),
        T("{from_name}", 18, 6, 50, 4, { font: "D", fontWeight: 700 }),
        T("{from_addr}", 3, 11, 74, 3),
        HR(3, 16, 74, 0.4),
        T("TO:", 3, 17, 30, 3, { fontWeight: 600 }),
        T("{to_name}", 3, 21, 74, 5, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        T("{to_addr}", 3, 28, 74, 3),
        T("{to_city}", 3, 32, 74, 3),
        BC("{tracking}", 3, 37, 74, 10),
    ],
};

const palletPlain100x150: LabelDoc = {
    id: "tpl_pallet_plain_100x150",
    name: "Pallet 100×150",
    builtIn: true,
    category: "logistics",
    tags: ["pallet", "code128", "qr", "serial"],
    settings: defaultSettings({
        widthMm: 100,
        heightMm: 150,
        serial: { enabled: true, start: 1, step: 1, pad: 8, prefix: "PAL" },
    }),
    elements: [
        LOGO(4, 4, 18, 10),
        ICON("pallet", 80, 4, 12),
        T("PALLET ID", 26, 5, 50, 4, { fontWeight: 600, align: "center" }),
        T("{serial}", 4, 16, 92, 12, { font: "E", scaleX: 3, scaleY: 3, fontWeight: 700, align: "center" }),
        HR(4, 32, 92, 0.5),
        T("SHIP TO", 4, 34, 50, 4, { fontWeight: 600 }),
        T("{to_name}", 4, 39, 92, 6, { font: "D", fontWeight: 700 }),
        T("{to_addr}", 4, 46, 92, 4),
        T("{to_city}", 4, 51, 92, 4),
        HR(4, 58, 92, 0.4),
        T("PIECES", 4, 60, 30, 3, { fontWeight: 600 }),
        T("{pieces}", 4, 64, 30, 8, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        T("WEIGHT", 36, 60, 30, 3, { fontWeight: 600 }),
        T("{weight} kg", 36, 64, 30, 8, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        T("CARRIER", 68, 60, 28, 3, { fontWeight: 600 }),
        T("{carrier}", 68, 64, 28, 5, { fontWeight: 700 }),
        HR(4, 76, 92, 0.4),
        T("PO #", 4, 78, 50, 3, { fontWeight: 600 }),
        T("{po}", 4, 83, 50, 6, { font: "D", fontWeight: 700 }),
        QR("{serial}", 70, 78, 24),
        BC("{serial}", 4, 108, 92, 30),
        T("{serial}", 4, 142, 92, 5, { align: "center" }),
    ],
};

const returnLabel100x60: LabelDoc = {
    id: "tpl_return_100x60",
    name: "Return Label 100×60",
    builtIn: true,
    category: "shipping",
    tags: ["return", "rma", "code128"],
    settings: defaultSettings({ widthMm: 100, heightMm: 60 }),
    elements: [
        FILL(3, 3, 94, 12),
        LOGO(5, 4, 16, 9),
        T("RETURN", 23, 4, 40, 8, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700 }),
        ICON("recycle", 65, 5, 8),
        T("RMA #", 75, 4, 20, 3, { fontWeight: 600 }),
        T("{rma}", 75, 8, 20, 5, { font: "D", fontWeight: 700 }),
        T("FROM:", 4, 18, 30, 3, { fontWeight: 600 }),
        T("{from_name}", 4, 22, 92, 4, { font: "D", fontWeight: 700 }),
        T("{from_addr}", 4, 27, 92, 3),
        HR(4, 32, 92, 0.4),
        T("RETURN TO:", 4, 34, 30, 3, { fontWeight: 600 }),
        T("Returns Center", 4, 38, 92, 5, { font: "D", fontWeight: 700 }),
        T("{return_addr}", 4, 44, 92, 3),
        BC("{rma}", 4, 49, 92, 9),
    ],
};

const addressLabel60x30: LabelDoc = {
    id: "tpl_address_60x30",
    name: "Address Label 60×30",
    builtIn: true,
    category: "shipping",
    tags: ["address", "simple"],
    settings: defaultSettings({ widthMm: 60, heightMm: 30 }),
    elements: [
        LOGO(3, 2, 12, 6),
        ICON("location-pin", 51, 2, 6),
        T("{name}", 17, 3, 32, 5, { font: "D", fontWeight: 700 }),
        HR(3, 10, 54, 0.3),
        T("{street}", 3, 11, 54, 4),
        T("{city}", 3, 16, 54, 4),
        T("{country}", 3, 21, 30, 4),
        T("{zip}", 33, 21, 24, 4, { font: "D", fontWeight: 700, align: "right" }),
    ],
};

const uspsStyle100x60: LabelDoc = {
    id: "tpl_usps_100x60",
    name: "USPS-style 100×60",
    builtIn: true,
    category: "shipping",
    tags: ["mail", "tracking", "code128"],
    settings: defaultSettings({ widthMm: 100, heightMm: 60 }),
    elements: [
        FILL(3, 3, 94, 7),
        LOGO(5, 3, 14, 7),
        ICON("truck", 84, 3, 7),
        T("PRIORITY MAIL", 21, 4, 62, 5, { font: "D", fontWeight: 700, align: "center" }),
        T("{class}", 4, 12, 30, 3, { fontWeight: 600 }),
        T("{weight} oz", 70, 12, 26, 3, { fontWeight: 600, align: "right" }),
        T("FROM:", 4, 17, 30, 3, { fontWeight: 600 }),
        T("{from_name}", 4, 21, 92, 3, { fontWeight: 700 }),
        T("{from_addr}", 4, 25, 92, 3),
        HR(4, 29, 92, 0.4),
        T("TO:", 4, 31, 30, 3, { fontWeight: 600 }),
        T("{to_name}", 4, 35, 92, 5, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        T("{to_addr}", 4, 42, 92, 3),
        T("{to_city}", 4, 46, 92, 3),
        BC("{tracking}", 4, 50, 92, 8),
    ],
};

const inventory40x25: LabelDoc = {
    id: "tpl_inventory_40x25",
    name: "Inventory 40×25",
    builtIn: true,
    category: "inventory",
    tags: ["serial", "qr"],
    settings: defaultSettings({
        widthMm: 40,
        heightMm: 25,
        copies: 5,
        serial: { enabled: true, start: 1, step: 1, pad: 5, prefix: "INV" },
    }),
    elements: [
        LOGO(2, 2, 9, 5),
        ICON("box", 12, 2, 4),
        T("ITEM", 17, 2, 14, 3, { fontWeight: 600 }),
        T("{serial}", 2, 8, 22, 6, { font: "D", fontWeight: 700 }),
        QR("{serial}", 26, 3, 11, { cell: 3 }),
        HR(2, 17, 36, 0.3),
        T("Scan to verify", 2, 19, 36, 3, { align: "center" }),
    ],
};

const binLabel60x30: LabelDoc = {
    id: "tpl_bin_60x30",
    name: "Bin Label 60×30",
    builtIn: true,
    category: "inventory",
    tags: ["bin", "warehouse", "code128"],
    settings: defaultSettings({ widthMm: 60, heightMm: 30 }),
    elements: [
        LOGO(3, 2, 10, 5),
        ICON("warehouse", 14, 2, 5),
        T("BIN", 20, 3, 18, 3, { fontWeight: 600 }),
        T("{bin_id}", 3, 8, 36, 7, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700 }),
        QR("{bin_id}", 41, 2, 16),
        HR(3, 19, 54, 0.3),
        T("{description}", 3, 20, 54, 3),
        BC("{bin_id}", 3, 23, 54, 6, { humanReadable: false }),
    ],
};

const shelfLabel80x30: LabelDoc = {
    id: "tpl_shelf_80x30",
    name: "Shelf Label 80×30",
    builtIn: true,
    category: "inventory",
    tags: ["shelf", "retail", "code128"],
    settings: defaultSettings({ widthMm: 80, heightMm: 30 }),
    elements: [
        LOGO(3, 2, 12, 6),
        ICON("warehouse", 17, 2, 5),
        T("{name}", 23, 2, 30, 5, { font: "D", fontWeight: 700 }),
        T("{sku}", 23, 8, 30, 4),
        T("{price}", 56, 2, 22, 8, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700, align: "right" }),
        HR(3, 14, 74, 0.3),
        T("Shelf {shelf}", 3, 15, 30, 3, { fontWeight: 600 }),
        T("{location}", 50, 15, 27, 3, { fontWeight: 600, align: "right" }),
        BC("{sku}", 3, 19, 74, 9),
    ],
};

const locationTag50x30: LabelDoc = {
    id: "tpl_location_50x30",
    name: "Location Tag 50×30",
    builtIn: true,
    category: "inventory",
    tags: ["location", "qr", "warehouse"],
    settings: defaultSettings({ widthMm: 50, heightMm: 30 }),
    elements: [
        LOGO(3, 2, 10, 5),
        ICON("location-pin", 14, 2, 5),
        T("LOCATION", 20, 3, 22, 3, { fontWeight: 600 }),
        T("{zone}", 3, 8, 28, 7, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        T("{aisle}-{bay}", 3, 16, 28, 6, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        QR("{zone}-{aisle}-{bay}", 32, 4, 16),
        HR(3, 23, 44, 0.3),
        T("Scan to confirm", 3, 25, 44, 3, { align: "center" }),
    ],
};

const pickSlip100x40: LabelDoc = {
    id: "tpl_pick_100x40",
    name: "Pick Slip 100×40",
    builtIn: true,
    category: "inventory",
    tags: ["pick", "order", "code128"],
    settings: defaultSettings({ widthMm: 100, heightMm: 40 }),
    elements: [
        LOGO(3, 2, 14, 7),
        ICON("scan", 88, 2, 6),
        T("ORDER", 20, 2, 20, 3, { fontWeight: 600 }),
        T("{order_id}", 20, 6, 50, 6, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        T("QTY", 70, 2, 15, 3, { fontWeight: 600 }),
        T("{qty}", 60, 6, 27, 8, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700, align: "right" }),
        HR(3, 16, 94, 0.3),
        T("ITEM", 3, 17, 30, 3, { fontWeight: 600 }),
        T("{sku}", 3, 21, 50, 4, { font: "D", fontWeight: 700 }),
        T("{name}", 3, 26, 70, 3),
        T("LOC", 80, 17, 18, 3, { fontWeight: 600 }),
        T("{location}", 80, 21, 18, 4, { font: "D", fontWeight: 700, align: "right" }),
        BC("{order_id}", 3, 31, 94, 7),
    ],
};

const skuStrip60x20: LabelDoc = {
    id: "tpl_sku_strip_60x20",
    name: "SKU Strip 60×20",
    builtIn: true,
    category: "inventory",
    tags: ["sku", "code128", "compact"],
    settings: defaultSettings({ widthMm: 60, heightMm: 20 }),
    elements: [
        LOGO(2, 2, 10, 5),
        ICON("scan", 52, 2, 5),
        T("{sku}", 13, 2, 38, 4, { font: "D", fontWeight: 700, align: "center" }),
        BC("{sku}", 3, 7, 54, 11),
    ],
};

const nameBadge80x50: LabelDoc = {
    id: "tpl_namebadge_80x50",
    name: "Name Badge 80×50",
    builtIn: true,
    category: "office",
    tags: ["badge", "name", "qr"],
    settings: defaultSettings({ widthMm: 80, heightMm: 50 }),
    elements: [
        LOGO(3, 3, 14, 7),
        ICON("bookmark", 67, 3, 7),
        T("{company}", 19, 4, 46, 4, { fontWeight: 600, align: "center" }),
        HR(15, 11, 50, 0.3),
        T("{name}", 4, 14, 72, 8, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700, align: "center" }),
        T("{title}", 4, 25, 72, 4, { font: "D", fontWeight: 700, align: "center" }),
        T("{department}", 4, 31, 72, 3, { align: "center" }),
        QR("{contact}", 32, 35, 12),
    ],
};

const fileFolder80x30: LabelDoc = {
    id: "tpl_filefolder_80x30",
    name: "File Folder 80×30",
    builtIn: true,
    category: "office",
    tags: ["file", "folder"],
    settings: defaultSettings({ widthMm: 80, heightMm: 30 }),
    elements: [
        LOGO(3, 2, 12, 6),
        ICON("bookmark", 70, 2, 6),
        T("{category}", 17, 3, 50, 3, { fontWeight: 600 }),
        T("{file_id}", 3, 9, 74, 7, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700 }),
        HR(3, 18, 74, 0.3),
        T("{description}", 3, 19, 74, 4),
        T("{date}", 3, 24, 30, 3),
        T("Box {box}", 60, 24, 17, 3, { fontWeight: 600, align: "right" }),
    ],
};

const cableWrap30x15: LabelDoc = {
    id: "tpl_cable_30x15",
    name: "Cable Wrap 30×15",
    builtIn: true,
    category: "office",
    tags: ["cable", "small"],
    settings: defaultSettings({ widthMm: 30, heightMm: 15 }),
    elements: [
        ICON("wifi", 2, 2, 4),
        T("{label}", 7, 2, 21, 4, { font: "D", fontWeight: 700, align: "center" }),
        T("{port}", 2, 7, 26, 6, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700, align: "center" }),
    ],
};

const barcodeStrip60x20: LabelDoc = {
    id: "tpl_barcode_60x20",
    name: "Barcode Strip 60×20",
    builtIn: true,
    category: "product",
    tags: ["ean13", "compact"],
    settings: defaultSettings({ widthMm: 60, heightMm: 20 }),
    elements: [
        LOGO(2, 2, 9, 5),
        ICON("tag", 12, 2, 4),
        T("PRODUCT CODE", 17, 2, 41, 3, { fontWeight: 600, align: "center" }),
        BC("5901234123457", 3, 7, 54, 11, { symbology: "EAN13" }),
    ],
};

const eanSticker50x30: LabelDoc = {
    id: "tpl_ean_50x30",
    name: "EAN Sticker 50×30",
    builtIn: true,
    category: "product",
    tags: ["ean13", "retail"],
    settings: defaultSettings({ widthMm: 50, heightMm: 30 }),
    elements: [
        LOGO(2, 2, 10, 5),
        ICON("tag", 41, 2, 5),
        T("{name}", 13, 2, 27, 4, { font: "D", fontWeight: 700 }),
        BC("5901234123457", 3, 8, 44, 14, { symbology: "EAN13", textSize: 2 }),
        T("{price}", 3, 24, 44, 4, { fontWeight: 700, align: "right" }),
    ],
};

// --- New Non-RFID templates (5) ---

const giftTag60x40: LabelDoc = {
    id: "tpl_gift_60x40",
    name: "Gift Tag 60×40",
    builtIn: true,
    category: "product",
    tags: ["gift", "tag", "elegant"],
    settings: defaultSettings({ widthMm: 60, heightMm: 40 }),
    elements: [
        RECT(2, 2, 56, 36, { thickness: 0.5 }),
        RECT(4, 4, 52, 32, { thickness: 0.2 }),
        LOGO(6, 6, 12, 6),
        ICON("heart", 47, 6, 7),
        T("With Love", 19, 7, 27, 4, { font: "D", fontWeight: 700, align: "center" }),
        HR(8, 14, 44, 0.3),
        T("To", 6, 16, 12, 3, { fontWeight: 600 }),
        T("{to}", 18, 16, 36, 5, { font: "D", fontWeight: 700 }),
        HR(8, 23, 44, 0.3),
        T("From", 6, 25, 12, 3, { fontWeight: 600 }),
        T("{from}", 18, 25, 36, 5, { font: "D", fontWeight: 700 }),
        HR(8, 32, 44, 0.3),
        T("{message}", 6, 33, 50, 3, { align: "center" }),
    ],
};

const eventBadge80x50: LabelDoc = {
    id: "tpl_event_80x50",
    name: "Event Badge 80×50",
    builtIn: true,
    category: "office",
    tags: ["event", "badge", "conference", "qr"],
    settings: defaultSettings({ widthMm: 80, heightMm: 50 }),
    elements: [
        FILL(2, 2, 76, 9),
        LOGO(4, 3, 14, 7),
        ICON("star", 67, 3, 7),
        T("{event_name}", 20, 3, 46, 6, { font: "D", fontWeight: 700, align: "center" }),
        T("{name}", 4, 14, 60, 9, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700 }),
        T("{event_role}", 4, 26, 60, 4, { font: "D", fontWeight: 700 }),
        T("{company}", 4, 32, 60, 4),
        HR(4, 38, 60, 0.3),
        T("{event_date}", 4, 40, 60, 3, { fontWeight: 600 }),
        QR("{contact}", 60, 28, 16),
    ],
};

const electronicsSpec70x40: LabelDoc = {
    id: "tpl_electronics_70x40",
    name: "Electronics Spec 70×40",
    builtIn: true,
    category: "product",
    tags: ["electronics", "spec", "code128"],
    settings: defaultSettings({ widthMm: 70, heightMm: 40 }),
    elements: [
        LOGO(3, 2, 14, 7),
        ICON("flame", 60, 2, 7),
        T("{brand} {model}", 19, 3, 40, 5, { font: "D", fontWeight: 700 }),
        T("{sku}", 19, 8, 40, 3),
        HR(3, 13, 64, 0.3),
        ICON("flame", 3, 15, 3),
        T("Power: {power}", 7, 15, 30, 3),
        ICON("scale", 38, 15, 3),
        T("Weight: {weight}", 42, 15, 25, 3),
        ICON("ruler", 3, 19, 3),
        T("Dim: {dimensions}", 7, 19, 30, 3),
        ICON("shield", 38, 19, 3),
        T("Cert: {cert}", 42, 19, 25, 3),
        BC("{sku}", 3, 24, 64, 12),
    ],
};

const groceryShelf50x30: LabelDoc = {
    id: "tpl_grocery_50x30",
    name: "Grocery Shelf 50×30",
    builtIn: true,
    category: "retail",
    tags: ["grocery", "ean13", "promo"],
    settings: defaultSettings({ widthMm: 50, heightMm: 30 }),
    elements: [
        LOGO(2, 2, 10, 5),
        FILL(36, 2, 12, 5),
        T("PROMO", 36, 2.5, 12, 4, { fontWeight: 700, align: "center" }),
        T("{name}", 13, 2, 22, 5, { font: "D", fontWeight: 700 }),
        T("{price}", 2, 8, 30, 7, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        T("{unit_price}", 2, 16, 30, 3),
        ICON("apple", 33, 9, 5),
        BC("5901234123457", 2, 20, 46, 8, { symbology: "EAN13", textSize: 1.5 }),
    ],
};

const archiveBox60x40: LabelDoc = {
    id: "tpl_archive_60x40",
    name: "Archive Box 60×40",
    builtIn: true,
    category: "office",
    tags: ["archive", "records", "box", "qr"],
    settings: defaultSettings({ widthMm: 60, heightMm: 40 }),
    elements: [
        RECT(2, 2, 56, 36, { thickness: 0.5 }),
        RECT(3.5, 3.5, 53, 33, { thickness: 0.2 }),
        LOGO(5, 5, 12, 6),
        ICON("box", 47, 5, 7),
        T("ARCHIVE", 18, 6, 27, 4, { font: "D", fontWeight: 700, align: "center" }),
        HR(5, 13, 50, 0.3),
        T("Box ID", 5, 14, 30, 3, { fontWeight: 600 }),
        T("{box_id}", 5, 18, 30, 6, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        QR("{box_id}", 36, 14, 16),
        HR(5, 27, 50, 0.3),
        T("{contents_list}", 5, 28, 50, 3),
        T("{date_range}", 5, 32, 50, 3, { fontWeight: 600, align: "center" }),
    ],
};

// =========================================================================
// NWS LABEL TEMPLATES
// =========================================================================

const nwsLabel45x20: LabelDoc = {
    id: "tpl_nws_label_45x20",
    name: "NWS Label 45x20",
    builtIn: true,
    category: "product",
    tags: ["nws", "nextwaves", "label", "rfid", "calibrated", "45x20"],
    nwsLabel: nwsProfile(NWS_LABEL_SPECS["45x20"]),
    settings: nwsSettings(NWS_LABEL_SPECS["45x20"], "NWS45"),
    elements: [
        RECT(1.5, 1.5, 42, 17, { thickness: 0.35 }),
        LOGO(2.5, 2.5, 8, 4),
        T("NWS LABEL", 11, 2.5, 26, 3, { fontWeight: 700, align: "center" }),
        ICON("rfid", 39, 2.5, 3.5),
        T("45x20 RFID", 2.5, 7, 22, 3, { fontWeight: 600 }),
        T("{serial}", 2.5, 11, 24, 5, { font: "D", fontWeight: 700 }),
        QR("{serial}", 30, 7, 11, { cell: 2 }),
    ],
};

const nwsLabel60x40: LabelDoc = {
    id: "tpl_nws_label_60x40",
    name: "NWS Label 60x40",
    builtIn: true,
    category: "product",
    tags: ["nws", "nextwaves", "label", "rfid", "calibrated", "60x40"],
    nwsLabel: nwsProfile(NWS_LABEL_SPECS["60x40"]),
    settings: nwsSettings(NWS_LABEL_SPECS["60x40"], "NWS60"),
    elements: [
        RECT(2, 2, 56, 36, { thickness: 0.4 }),
        LOGO(4, 4, 12, 6),
        ICON("rfid", 51, 4, 6),
        T("NEXTWAVES", 18, 4, 30, 3, { fontWeight: 600, align: "center" }),
        T("NWS LABEL", 18, 8, 30, 5, { font: "D", fontWeight: 700, align: "center" }),
        HR(4, 15, 52, 0.3),
        T("60x40 RFID", 4, 17, 30, 3, { fontWeight: 600 }),
        T("{serial}", 4, 22, 34, 6, { font: "D", scaleY: 2, fontWeight: 700 }),
        QR("{serial}", 40, 18, 15),
        T("Lab profile: NWS-60x40", 4, 34, 52, 3, { align: "center" }),
    ],
};

const nwsLabel80x30: LabelDoc = {
    id: "tpl_nws_label_80x30",
    name: "NWS Label 80x30",
    builtIn: true,
    category: "product",
    tags: ["nws", "nextwaves", "label", "rfid", "calibrated", "80x30"],
    nwsLabel: nwsProfile(NWS_LABEL_SPECS["80x30"]),
    settings: nwsSettings(NWS_LABEL_SPECS["80x30"], "NWS80"),
    elements: [
        RECT(2, 2, 76, 26, { thickness: 0.4 }),
        LOGO(4, 4, 12, 6),
        ICON("rfid", 69, 4, 6),
        T("NEXTWAVES LABEL", 18, 4, 48, 4, { fontWeight: 700, align: "center" }),
        HR(4, 11, 72, 0.3),
        T("80x30 RFID", 4, 13, 25, 3, { fontWeight: 600 }),
        T("{serial}", 4, 18, 44, 6, { font: "D", scaleY: 2, fontWeight: 700 }),
        QR("{serial}", 55, 12, 14),
        T("NWS lab calibrated", 50, 26, 26, 2, { align: "right" }),
    ],
};

const nwsLabel100x30: LabelDoc = {
    id: "tpl_nws_label_100x30",
    name: "NWS Label 100x30",
    builtIn: true,
    category: "product",
    tags: ["nws", "nextwaves", "label", "rfid", "calibrated", "100x30"],
    nwsLabel: nwsProfile(NWS_LABEL_SPECS["100x30"]),
    settings: nwsSettings(NWS_LABEL_SPECS["100x30"], "NWS100"),
    elements: [
        RECT(2, 2, 96, 26, { thickness: 0.4 }),
        LOGO(4, 4, 14, 6),
        ICON("rfid", 90, 4, 6),
        T("NEXTWAVES LABEL", 20, 4, 68, 4, { fontWeight: 700, align: "center" }),
        T("100x30 RFID", 4, 12, 30, 3, { fontWeight: 600 }),
        T("{serial}", 4, 17, 36, 6, { font: "D", scaleY: 2, fontWeight: 700 }),
        BC("{serial}", 43, 14, 42, 10, { humanReadable: false }),
        T("NWS lab calibrated", 43, 25, 42, 2, { align: "center" }),
    ],
};

// =========================================================================
// RFID TEMPLATES (30)
// =========================================================================

const assetTag50x30: LabelDoc = {
    id: "tpl_asset_50x30",
    name: "Asset Tag 50×30",
    builtIn: true,
    category: "asset",
    tags: ["rfid", "qr", "serial"],
    settings: defaultSettings({
        widthMm: 50,
        heightMm: 30,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 6, prefix: "AST" },
    }),
    elements: [
        LOGO(2, 2, 10, 5),
        ICON("rfid", 44, 2, 4),
        T("ASSET", 13, 2, 30, 3, { fontWeight: 600 }),
        T("{serial}", 3, 8, 32, 6, { font: "D", scaleY: 3, fontWeight: 700 }),
        QR("{serial}", 37, 9, 11),
        HR(3, 16, 32, 0.3),
        T("Property of Nextwaves", 3, 18, 32, 3),
        T("RFID enabled", 3, 24, 44, 3, { fontWeight: 600, align: "center" }),
    ],
};

const itAsset60x40: LabelDoc = {
    id: "tpl_it_asset_60x40",
    name: "IT Asset 60×40",
    builtIn: true,
    category: "asset",
    tags: ["rfid", "qr", "it", "serial"],
    settings: defaultSettings({
        widthMm: 60,
        heightMm: 40,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 6, prefix: "IT" },
    }),
    elements: [
        LOGO(3, 2, 12, 6),
        ICON("rfid", 51, 2, 6),
        T("IT ASSET", 17, 3, 32, 3, { fontWeight: 600, align: "center" }),
        T("{serial}", 3, 9, 38, 7, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700 }),
        QR("{serial}", 42, 9, 14),
        HR(3, 18, 38, 0.3),
        T("Model: {model}", 3, 19, 38, 3),
        T("MAC: {mac}", 3, 23, 38, 3),
        T("IP: {ip}", 3, 27, 38, 3),
        HR(3, 31, 54, 0.3),
        T("Property of Nextwaves IT", 3, 32, 54, 3, { align: "center" }),
        T("RFID + QR Verified", 3, 36, 54, 3, { fontWeight: 600, align: "center" }),
    ],
};

const toolCrib50x25: LabelDoc = {
    id: "tpl_tool_50x25",
    name: "Tool Crib 50×25",
    builtIn: true,
    category: "asset",
    tags: ["rfid", "qr", "tool", "serial"],
    settings: defaultSettings({
        widthMm: 50,
        heightMm: 25,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 5, prefix: "TOOL" },
    }),
    elements: [
        LOGO(2, 2, 9, 5),
        ICON("rfid", 12, 2, 4),
        T("TOOL", 17, 2, 16, 3, { fontWeight: 600 }),
        T("{serial}", 2, 8, 30, 5, { font: "D", scaleY: 3, fontWeight: 700 }),
        T("{description}", 2, 14, 30, 4),
        QR("{serial}", 34, 3, 13),
        T("RFID", 34, 19, 14, 3, { fontWeight: 600, align: "center" }),
    ],
};

const equipmentPlate70x40: LabelDoc = {
    id: "tpl_equipment_70x40",
    name: "Equipment Plate 70×40",
    builtIn: true,
    category: "asset",
    tags: ["rfid", "qr", "equipment", "serial"],
    settings: defaultSettings({
        widthMm: 70,
        heightMm: 40,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 7, prefix: "EQ" },
    }),
    elements: [
        RECT(2, 2, 66, 36, { thickness: 0.4 }),
        LOGO(4, 4, 12, 6),
        ICON("rfid", 57, 4, 6),
        T("{company}", 18, 4, 38, 3, { fontWeight: 600, align: "center" }),
        T("EQUIPMENT ID", 18, 8, 38, 3, { fontWeight: 600, align: "center" }),
        T("{serial}", 4, 13, 44, 7, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700 }),
        HR(4, 22, 44, 0.3),
        T("Model: {model}", 4, 23, 44, 3),
        T("Mfg: {mfg_date}", 4, 27, 44, 3),
        T("RFID + QR Verified", 4, 33, 44, 3, { fontWeight: 600 }),
        QR("{serial}", 50, 12, 16),
    ],
};

const serverRack60x20: LabelDoc = {
    id: "tpl_server_60x20",
    name: "Server Rack 60×20",
    builtIn: true,
    category: "asset",
    tags: ["rfid", "server", "rack"],
    settings: defaultSettings({
        widthMm: 60,
        heightMm: 20,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 4, prefix: "SRV" },
    }),
    elements: [
        LOGO(2, 2, 9, 5),
        ICON("rfid", 12, 2, 4),
        T("{hostname}", 17, 2, 24, 5, { font: "D", fontWeight: 700 }),
        T("{ip}", 2, 9, 38, 3),
        T("Rack {rack} U{u}", 2, 13, 38, 3, { fontWeight: 600 }),
        QR("{hostname}", 47, 4, 11),
    ],
};

const vehicleAsset80x50: LabelDoc = {
    id: "tpl_vehicle_80x50",
    name: "Vehicle Asset 80×50",
    builtIn: true,
    category: "asset",
    tags: ["rfid", "qr", "fleet", "serial"],
    settings: defaultSettings({
        widthMm: 80,
        heightMm: 50,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 5, prefix: "VEH" },
    }),
    elements: [
        LOGO(3, 3, 14, 7),
        ICON("rfid", 67, 3, 7),
        T("FLEET ASSET", 19, 4, 46, 4, { fontWeight: 600, align: "center" }),
        T("{serial}", 3, 11, 50, 8, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700 }),
        HR(3, 21, 50, 0.3),
        ICON("scan", 3, 23, 3),
        T("VIN", 7, 23, 14, 3, { fontWeight: 600 }),
        T("{vin}", 3, 27, 50, 4),
        ICON("truck", 3, 32, 3),
        T("MAKE", 7, 32, 14, 3, { fontWeight: 600 }),
        T("{make} {model}", 3, 36, 50, 4, { fontWeight: 700 }),
        ICON("key", 3, 41, 3),
        T("PLATE", 7, 41, 14, 3, { fontWeight: 600 }),
        T("{plate}", 3, 45, 50, 4, { fontWeight: 700 }),
        QR("{vin}", 56, 21, 22),
    ],
};

const furnitureTag50x30: LabelDoc = {
    id: "tpl_furniture_50x30",
    name: "Furniture Tag 50×30",
    builtIn: true,
    category: "asset",
    tags: ["rfid", "qr", "furniture"],
    settings: defaultSettings({
        widthMm: 50,
        heightMm: 30,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 5, prefix: "FUR" },
    }),
    elements: [
        LOGO(2, 2, 10, 5),
        ICON("rfid", 44, 2, 4),
        T("FURNITURE", 13, 2, 30, 3, { fontWeight: 600 }),
        T("{serial}", 2, 8, 30, 5, { font: "D", scaleY: 3, fontWeight: 700 }),
        T("Room: {room}", 2, 14, 30, 3),
        T("Type: {type}", 2, 18, 30, 3),
        QR("{serial}", 34, 9, 13),
        T("RFID enabled", 2, 25, 46, 3, { fontWeight: 600, align: "center" }),
    ],
};

const labEquipment70x40: LabelDoc = {
    id: "tpl_lab_70x40",
    name: "Lab Equipment 70×40",
    builtIn: true,
    category: "asset",
    tags: ["rfid", "qr", "lab", "calibration"],
    settings: defaultSettings({
        widthMm: 70,
        heightMm: 40,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 6, prefix: "LAB" },
    }),
    elements: [
        LOGO(3, 3, 12, 6),
        ICON("rfid", 58, 3, 6),
        T("LAB EQUIPMENT", 17, 4, 38, 4, { fontWeight: 600, align: "center" }),
        T("{serial}", 3, 11, 50, 7, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        HR(3, 19, 50, 0.3),
        T("Model: {model}", 3, 20, 50, 3),
        ICON("calendar", 3, 24, 3),
        T("Calibrated: {cal_date}", 7, 24, 46, 3),
        ICON("expiry", 3, 28, 3),
        T("Next Cal: {cal_due}", 7, 28, 46, 3),
        T("Owner: {owner}", 3, 32, 50, 3),
        QR("{serial}", 54, 18, 13),
        T("RFID", 54, 33, 13, 3, { fontWeight: 600, align: "center" }),
    ],
};

const apparelRfidHangtag50x80: LabelDoc = {
    id: "tpl_apparel_rfid_50x80",
    name: "Apparel RFID Hangtag 50×80",
    builtIn: true,
    category: "retail",
    tags: ["rfid", "apparel", "hangtag", "qr", "code128"],
    settings: defaultSettings({
        widthMm: 50,
        heightMm: 80,
        rfid: rfidOn(),
    }),
    elements: [
        LOGO(3, 3, 14, 7),
        ICON("rfid", 33, 3, 7),
        T("{brand}", 3, 12, 44, 4, { font: "D", fontWeight: 700, align: "center" }),
        HR(6, 17, 38, 0.3),
        T("{name}", 3, 19, 44, 4, { fontWeight: 600, align: "center" }),
        T("SIZE", 3, 25, 44, 3, { fontWeight: 600, align: "center" }),
        T("{size}", 3, 29, 44, 9, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700, align: "center" }),
        HR(6, 41, 38, 0.3),
        T("{color}", 3, 43, 44, 3, { align: "center" }),
        T("{material}", 3, 47, 44, 3, { align: "center" }),
        QR("{sku}", 17, 51, 16),
        BC("{sku}", 4, 68, 42, 5),
        T("RFID + QR", 3, 75, 22, 3, { fontWeight: 600 }),
        T("{price}", 25, 75, 22, 5, { font: "D", fontWeight: 700, align: "right" }),
    ],
};

const footwearRfid60x30: LabelDoc = {
    id: "tpl_footwear_60x30",
    name: "Footwear RFID 60×30",
    builtIn: true,
    category: "retail",
    tags: ["rfid", "footwear", "qr"],
    settings: defaultSettings({
        widthMm: 60,
        heightMm: 30,
        rfid: rfidOn(),
    }),
    elements: [
        LOGO(2, 2, 10, 5),
        ICON("rfid", 54, 2, 4),
        T("{brand}", 13, 2, 28, 3, { fontWeight: 600 }),
        T("{model}", 13, 5, 26, 4, { font: "D", fontWeight: 700 }),
        RECT(2, 11, 16, 14, { thickness: 0.4 }),
        T("SIZE", 3, 12, 14, 3, { fontWeight: 600, align: "center" }),
        T("{size}", 3, 16, 14, 8, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700, align: "center" }),
        ICON("paint", 21, 12, 3),
        T("{color}", 25, 13, 18, 3),
        ICON("tag", 21, 16, 3),
        T("{sku}", 25, 17, 18, 3),
        T("{price}", 21, 21, 22, 4, { font: "D", fontWeight: 700 }),
        QR("{sku}", 44, 11, 14),
    ],
};

const jewelryRfid40x20: LabelDoc = {
    id: "tpl_jewelry_rfid_40x20",
    name: "Jewelry RFID 40×20",
    builtIn: true,
    category: "retail",
    tags: ["rfid", "jewelry", "qr", "small"],
    settings: defaultSettings({
        widthMm: 40,
        heightMm: 20,
        rfid: rfidOn(),
    }),
    elements: [
        ICON("rfid", 2, 2, 3),
        T("{sku}", 6, 2, 20, 3, { font: "D", fontWeight: 700 }),
        T("{material}", 2, 6, 24, 3),
        T("{price}", 2, 10, 24, 7, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        QR("{sku}", 26, 2, 12),
    ],
};

const eyewearRfid50x25: LabelDoc = {
    id: "tpl_eyewear_50x25",
    name: "Eyewear RFID 50×25",
    builtIn: true,
    category: "retail",
    tags: ["rfid", "eyewear", "qr"],
    settings: defaultSettings({
        widthMm: 50,
        heightMm: 25,
        rfid: rfidOn(),
    }),
    elements: [
        LOGO(2, 2, 9, 5),
        ICON("rfid", 12, 2, 4),
        T("{brand}", 17, 2, 18, 3, { fontWeight: 600 }),
        T("{model}", 2, 8, 32, 4, { font: "D", fontWeight: 700 }),
        ICON("paint", 2, 13, 3),
        T("{color}", 6, 13, 28, 3),
        T("{price}", 2, 17, 32, 5, { font: "D", fontWeight: 700 }),
        QR("{sku}", 36, 4, 12),
    ],
};

const cosmeticsRfid40x25: LabelDoc = {
    id: "tpl_cosmetics_40x25",
    name: "Cosmetics RFID 40×25",
    builtIn: true,
    category: "retail",
    tags: ["rfid", "cosmetics", "code128"],
    settings: defaultSettings({
        widthMm: 40,
        heightMm: 25,
        rfid: rfidOn(),
    }),
    elements: [
        ICON("rfid", 2, 2, 4),
        T("{brand}", 7, 2, 31, 3, { fontWeight: 600 }),
        T("{name}", 2, 6, 36, 4, { font: "D", fontWeight: 700 }),
        ICON("paint", 2, 11, 3),
        T("Shade: {shade}", 6, 11, 32, 3),
        BC("{sku}", 2, 15, 36, 7, { humanReadable: false }),
        T("{price}", 2, 22, 36, 3, { fontWeight: 700, align: "right" }),
    ],
};

const premiumTag60x40: LabelDoc = {
    id: "tpl_premium_60x40",
    name: "Premium Tag 60×40",
    builtIn: true,
    category: "retail",
    tags: ["rfid", "premium", "qr"],
    settings: defaultSettings({
        widthMm: 60,
        heightMm: 40,
        rfid: rfidOn(),
    }),
    elements: [
        RECT(2, 2, 56, 36, { thickness: 0.6 }),
        RECT(3.5, 3.5, 53, 33, { thickness: 0.2 }),
        LOGO(5, 5, 12, 6),
        ICON("rfid", 47, 5, 6),
        T("{brand}", 18, 5, 28, 4, { font: "D", fontWeight: 700, align: "center" }),
        HR(10, 12, 26, 0.3),
        T("{name}", 4, 14, 38, 3, { fontWeight: 600, align: "center" }),
        T("{price}", 4, 18, 38, 9, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700, align: "center" }),
        HR(10, 28, 26, 0.3),
        T("RFID Authenticated", 4, 31, 36, 3, { fontWeight: 600, align: "center" }),
        QR("{sku}", 42, 13, 14),
        T("VERIFY", 42, 28, 14, 3, { fontWeight: 600, align: "center" }),
    ],
};

const palletRfid100x150: LabelDoc = {
    id: "tpl_pallet_rfid_100x150",
    name: "Pallet RFID 100×150",
    builtIn: true,
    category: "logistics",
    tags: ["rfid", "pallet", "code128", "qr", "serial"],
    settings: defaultSettings({
        widthMm: 100,
        heightMm: 150,
        rfid: rfidOn({
            data: "{rfid_epc_encode}",
            fieldName: "rfid_epc_encode",
        }),
        serial: { enabled: true, start: 1, step: 1, pad: 8, prefix: "PALR" },
    }),
    elements: [
        LOGO(4, 4, 18, 10),
        ICON("rfid", 80, 4, 12),
        T("RFID PALLET", 26, 5, 50, 5, { fontWeight: 600, align: "center" }),
        T("{serial}", 4, 16, 92, 12, { font: "E", scaleX: 3, scaleY: 3, fontWeight: 700, align: "center" }),
        HR(4, 32, 92, 0.5),
        T("SHIP TO", 4, 34, 50, 4, { fontWeight: 600 }),
        T("{to_name}", 4, 39, 92, 6, { font: "D", fontWeight: 700 }),
        T("{to_addr}", 4, 46, 92, 4),
        T("{to_city}", 4, 51, 92, 4),
        HR(4, 58, 92, 0.4),
        T("PIECES", 4, 60, 28, 3, { fontWeight: 600 }),
        T("{pieces}", 4, 64, 28, 7, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        T("WEIGHT", 36, 60, 28, 3, { fontWeight: 600 }),
        T("{weight} kg", 36, 64, 28, 7, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        T("EPC", 68, 60, 28, 3, { fontWeight: 600 }),
        T("{rfid_epc_encode}", 68, 64, 28, 4),
        HR(4, 76, 92, 0.4),
        T("PO #", 4, 78, 50, 3, { fontWeight: 600 }),
        T("{po}", 4, 83, 50, 6, { font: "D", fontWeight: 700 }),
        QR("{serial}", 70, 78, 24),
        BC("{serial}", 4, 108, 92, 28),
        T("RFID ENCODED · {serial}", 4, 140, 92, 5, { fontWeight: 600, align: "center" }),
    ],
};

const containerRfid100x60: LabelDoc = {
    id: "tpl_container_100x60",
    name: "Container RFID 100×60",
    builtIn: true,
    category: "logistics",
    tags: ["rfid", "container", "code128", "qr", "serial"],
    settings: defaultSettings({
        widthMm: 100,
        heightMm: 60,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 7, prefix: "CTN" },
    }),
    elements: [
        LOGO(4, 3, 14, 7),
        ICON("rfid", 60, 3, 7),
        T("CONTAINER", 20, 4, 38, 4, { fontWeight: 600, align: "center" }),
        T("{serial}", 4, 11, 60, 8, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700 }),
        QR("{serial}", 70, 12, 22),
        HR(4, 21, 64, 0.4),
        T("DESTINATION", 4, 22, 40, 3, { fontWeight: 600 }),
        T("{to_name}", 4, 26, 60, 5, { font: "D", fontWeight: 700 }),
        T("SEAL #", 4, 33, 30, 3, { fontWeight: 600 }),
        T("{seal}", 4, 37, 30, 4, { font: "D", fontWeight: 700 }),
        T("CARRIER", 50, 33, 30, 3, { fontWeight: 600 }),
        T("{carrier}", 50, 37, 30, 4, { fontWeight: 700 }),
        BC("{serial}", 4, 44, 92, 12),
    ],
};

const returnableCrate80x50: LabelDoc = {
    id: "tpl_returnable_80x50",
    name: "Returnable Crate 80×50",
    builtIn: true,
    category: "logistics",
    tags: ["rfid", "crate", "returnable", "qr"],
    settings: defaultSettings({
        widthMm: 80,
        heightMm: 50,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 6, prefix: "RTN" },
    }),
    elements: [
        LOGO(3, 3, 12, 6),
        ICON("rfid", 67, 3, 7),
        T("RETURNABLE", 17, 4, 48, 4, { fontWeight: 600, align: "center" }),
        T("{serial}", 3, 11, 50, 7, { font: "D", scaleY: 3, fontWeight: 700 }),
        HR(3, 20, 52, 0.3),
        T("Owner: {owner}", 3, 22, 50, 3),
        T("Type: {type}", 3, 26, 50, 3),
        QR("{serial}", 56, 11, 20),
        HR(3, 33, 74, 0.3),
        T("Return To:", 3, 34, 50, 3, { fontWeight: 600 }),
        T("{return_to}", 3, 38, 74, 4, { font: "D", fontWeight: 700 }),
        T("{return_addr}", 3, 43, 74, 3),
        T("RFID + QR", 3, 47, 74, 3, { fontWeight: 600, align: "center" }),
    ],
};

const cartonRfid100x40: LabelDoc = {
    id: "tpl_carton_100x40",
    name: "Carton RFID 100×40",
    builtIn: true,
    category: "logistics",
    tags: ["rfid", "carton", "code128", "serial"],
    settings: defaultSettings({
        widthMm: 100,
        heightMm: 40,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 7, prefix: "CTN" },
    }),
    elements: [
        LOGO(3, 2, 12, 6),
        ICON("rfid", 87, 2, 6),
        T("CARTON", 17, 2, 30, 3, { fontWeight: 600 }),
        T("{serial}", 3, 8, 60, 7, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700 }),
        T("PIECES", 70, 9, 16, 3, { fontWeight: 600, align: "right" }),
        T("{pieces}", 64, 13, 22, 7, { font: "E", scaleX: 3, scaleY: 2, fontWeight: 700, align: "right" }),
        HR(3, 17, 94, 0.3),
        T("TO: {to_name}", 3, 18, 60, 3, { fontWeight: 600 }),
        T("PO: {po}", 3, 22, 40, 3, { fontWeight: 600 }),
        BC("{serial}", 3, 26, 94, 12),
    ],
};

const reelSpool50x50: LabelDoc = {
    id: "tpl_reel_50x50",
    name: "Reel/Spool 50×50",
    builtIn: true,
    category: "logistics",
    tags: ["rfid", "reel", "spool", "qr"],
    settings: defaultSettings({
        widthMm: 50,
        heightMm: 50,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 5, prefix: "REEL" },
    }),
    elements: [
        LOGO(2, 2, 10, 5),
        ICON("rfid", 44, 2, 4),
        T("REEL", 13, 3, 30, 3, { fontWeight: 600, align: "center" }),
        T("{serial}", 2, 8, 44, 6, { font: "D", scaleY: 3, fontWeight: 700, align: "center" }),
        HR(3, 16, 44, 0.3),
        ICON("tag", 3, 18, 3),
        T("Part: {part}", 7, 18, 38, 3),
        ICON("ruler", 3, 22, 3),
        T("Length: {length}m", 7, 22, 38, 3),
        ICON("calendar", 3, 26, 3),
        T("Date: {date}", 7, 26, 38, 3),
        QR("{serial}", 16, 31, 16),
        T("RFID + QR", 3, 47, 44, 3, { fontWeight: 600, align: "center" }),
    ],
};

const patientWristband100x25: LabelDoc = {
    id: "tpl_patient_100x25",
    name: "Patient Wristband 100×25",
    builtIn: true,
    category: "healthcare",
    tags: ["rfid", "patient", "qr"],
    settings: defaultSettings({
        widthMm: 100,
        heightMm: 25,
        rfid: rfidOn(),
    }),
    elements: [
        LOGO(2, 2, 12, 6),
        ICON("rfid", 94, 2, 4),
        T("{hospital}", 16, 3, 76, 3, { fontWeight: 600 }),
        T("{patient_name}", 2, 9, 50, 5, { font: "D", fontWeight: 700 }),
        T("DOB: {dob}", 2, 15, 30, 3),
        T("MRN: {patient_id}", 2, 19, 30, 3, { fontWeight: 600 }),
        T("Allergy: {allergy}", 33, 15, 25, 3, { fontWeight: 700 }),
        QR("{patient_id}", 56, 3, 18),
        T("{patient_id}", 76, 16, 22, 3, { align: "center" }),
        T("RFID", 76, 21, 22, 3, { fontWeight: 600, align: "center" }),
    ],
};

const specimen60x30: LabelDoc = {
    id: "tpl_specimen_60x30",
    name: "Specimen 60×30",
    builtIn: true,
    category: "healthcare",
    tags: ["rfid", "specimen", "lab", "code128"],
    settings: defaultSettings({
        widthMm: 60,
        heightMm: 30,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 8, prefix: "SPC" },
    }),
    elements: [
        LOGO(3, 2, 10, 5),
        ICON("rfid", 54, 2, 4),
        T("LAB SPECIMEN", 14, 3, 38, 3, { fontWeight: 600, align: "center" }),
        T("{serial}", 3, 8, 36, 5, { font: "D", scaleY: 2, fontWeight: 700 }),
        T("Patient: {patient_id}", 3, 14, 54, 3, { fontWeight: 600 }),
        ICON("calendar", 3, 18, 3),
        T("Collected: {collect_date}", 7, 18, 50, 3),
        T("Type: {type}", 3, 22, 36, 3),
        BC("{serial}", 3, 26, 54, 4, { humanReadable: false }),
        QR("{serial}", 42, 8, 14),
    ],
};

const pharmacy50x30: LabelDoc = {
    id: "tpl_pharmacy_50x30",
    name: "Pharmacy 50×30",
    builtIn: true,
    category: "healthcare",
    tags: ["rfid", "rx", "pharmacy", "code128"],
    settings: defaultSettings({
        widthMm: 50,
        heightMm: 30,
        rfid: rfidOn(),
    }),
    elements: [
        LOGO(2, 2, 10, 5),
        FILL(13, 2, 8, 5),
        T("RX", 13, 2.5, 8, 4, { fontWeight: 700, align: "center" }),
        ICON("rfid", 44, 2, 4),
        T("{rx_id}", 22, 3, 20, 3, { fontWeight: 600, align: "right" }),
        HR(2, 8, 46, 0.3),
        T("{drug_name}", 2, 9, 46, 4, { font: "D", fontWeight: 700 }),
        T("{dose}", 2, 14, 46, 3, { fontWeight: 600 }),
        T("Patient: {patient_name}", 2, 18, 46, 3),
        T("Dr: {doctor}", 2, 22, 46, 3),
        BC("{rx_id}", 2, 25, 46, 4, { humanReadable: false }),
    ],
};

const bloodBag80x50: LabelDoc = {
    id: "tpl_blood_80x50",
    name: "Blood Bag 80×50",
    builtIn: true,
    category: "healthcare",
    tags: ["rfid", "blood", "qr", "code128"],
    settings: defaultSettings({
        widthMm: 80,
        heightMm: 50,
        rfid: rfidOn(),
    }),
    elements: [
        LOGO(3, 3, 12, 6),
        ICON("rfid", 67, 3, 7),
        T("BLOOD UNIT", 17, 4, 48, 4, { font: "D", fontWeight: 700, align: "center" }),
        HR(3, 11, 74, 0.4),
        T("Donor ID", 3, 13, 30, 3, { fontWeight: 600 }),
        T("{donor_id}", 3, 17, 50, 5, { font: "D", fontWeight: 700 }),
        T("Type", 3, 23, 18, 3, { fontWeight: 600 }),
        T("{blood_type}", 3, 27, 18, 7, { font: "E", scaleX: 2, scaleY: 2, fontWeight: 700 }),
        T("Volume", 24, 23, 18, 3, { fontWeight: 600 }),
        T("{volume} mL", 24, 27, 22, 4, { fontWeight: 700 }),
        ICON("expiry", 3, 36, 3),
        T("Expires", 7, 36, 16, 3, { fontWeight: 600 }),
        T("{expires}", 3, 40, 50, 4, { font: "D", fontWeight: 700 }),
        QR("{donor_id}", 56, 13, 20),
        BC("{donor_id}", 3, 45, 74, 4, { humanReadable: false }),
    ],
};

const reusableBin60x40: LabelDoc = {
    id: "tpl_reusable_bin_60x40",
    name: "Reusable Bin 60×40",
    builtIn: true,
    category: "inventory",
    tags: ["rfid", "bin", "reusable", "qr"],
    settings: defaultSettings({
        widthMm: 60,
        heightMm: 40,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 5, prefix: "BIN" },
    }),
    elements: [
        LOGO(3, 3, 12, 6),
        ICON("rfid", 51, 3, 6),
        T("REUSABLE BIN", 17, 4, 32, 3, { fontWeight: 600, align: "center" }),
        T("{serial}", 3, 11, 38, 7, { font: "D", scaleY: 3, fontWeight: 700 }),
        QR("{serial}", 42, 11, 14),
        HR(3, 26, 54, 0.3),
        ICON("box", 3, 28, 3),
        T("Contents: {contents}", 7, 28, 50, 3),
        ICON("key", 3, 32, 3),
        T("Owner: {owner}", 7, 32, 50, 3),
        ICON("scale", 3, 36, 3),
        T("Capacity: {capacity}", 7, 36, 50, 3),
    ],
};

const wipTracker50x30: LabelDoc = {
    id: "tpl_wip_50x30",
    name: "WIP Tracker 50×30",
    builtIn: true,
    category: "inventory",
    tags: ["rfid", "wip", "manufacturing", "qr"],
    settings: defaultSettings({
        widthMm: 50,
        heightMm: 30,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 6, prefix: "WIP" },
    }),
    elements: [
        LOGO(2, 2, 9, 5),
        ICON("rfid", 12, 2, 4),
        T("WIP", 17, 2, 16, 3, { fontWeight: 600 }),
        T("{serial}", 2, 8, 30, 5, { font: "D", scaleY: 3, fontWeight: 700 }),
        HR(2, 14, 30, 0.3),
        T("Part: {part}", 2, 15, 30, 3),
        T("Station: {station}", 2, 19, 30, 3, { fontWeight: 600 }),
        T("Step: {step}/{total}", 2, 23, 30, 3),
        QR("{serial}", 34, 3, 13),
    ],
};

// --- New RFID templates (5) ---

const libraryBook50x25: LabelDoc = {
    id: "tpl_book_50x25",
    name: "Library Book RFID 50×25",
    builtIn: true,
    category: "asset",
    tags: ["rfid", "library", "book", "code128"],
    settings: defaultSettings({
        widthMm: 50,
        heightMm: 25,
        rfid: rfidOn(),
    }),
    elements: [
        LOGO(2, 2, 10, 5),
        ICON("bookmark", 12, 2, 4),
        T("LIBRARY", 17, 2, 16, 3, { fontWeight: 600 }),
        ICON("rfid", 44, 2, 4),
        T("{call_number}", 2, 8, 32, 5, { font: "D", scaleY: 2, fontWeight: 700 }),
        T("{name}", 2, 14, 32, 3, { fontWeight: 600 }),
        T("{author}", 2, 17, 32, 3),
        BC("{isbn}", 2, 20, 32, 4, { humanReadable: false }),
        QR("{call_number}", 36, 7, 12),
    ],
};

const uniformRfid50x30: LabelDoc = {
    id: "tpl_uniform_50x30",
    name: "Uniform RFID 50×30",
    builtIn: true,
    category: "retail",
    tags: ["rfid", "uniform", "laundry"],
    settings: defaultSettings({
        widthMm: 50,
        heightMm: 30,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 5, prefix: "UNI" },
    }),
    elements: [
        LOGO(2, 2, 10, 5),
        ICON("rfid", 44, 2, 4),
        T("UNIFORM", 14, 2, 28, 3, { fontWeight: 600 }),
        T("{name}", 14, 5, 28, 3, { font: "D", fontWeight: 700 }),
        T("{serial}", 2, 9, 30, 5, { font: "D", scaleY: 2, fontWeight: 700 }),
        HR(2, 15, 30, 0.3),
        T("Dept: {dept}", 2, 16, 30, 3),
        T("Size: {size}", 2, 20, 14, 3),
        T("Cycles: {cycle}", 16, 20, 16, 3, { fontWeight: 600 }),
        QR("{serial}", 34, 8, 14),
        T("{serial}", 2, 25, 46, 3, { fontWeight: 600, align: "center" }),
    ],
};

const artworkRfid80x50: LabelDoc = {
    id: "tpl_artwork_80x50",
    name: "Artwork RFID 80×50",
    builtIn: true,
    category: "asset",
    tags: ["rfid", "artwork", "museum", "qr"],
    settings: defaultSettings({
        widthMm: 80,
        heightMm: 50,
        rfid: rfidOn(),
    }),
    elements: [
        RECT(2, 2, 76, 46, { thickness: 0.4 }),
        LOGO(4, 4, 14, 8),
        ICON("rfid", 67, 4, 7),
        T("MUSEUM COLLECTION", 19, 4, 46, 3, { fontWeight: 600, align: "center" }),
        T("{name}", 19, 8, 46, 5, { font: "D", fontWeight: 700, align: "center" }),
        HR(4, 15, 54, 0.3),
        T("Artist", 4, 16, 30, 3, { fontWeight: 600 }),
        T("{artist}", 4, 20, 50, 4, { fontWeight: 700 }),
        T("Year", 4, 25, 14, 3, { fontWeight: 600 }),
        T("{year}", 4, 29, 14, 4, { fontWeight: 700 }),
        T("Medium", 22, 25, 30, 3, { fontWeight: 600 }),
        T("{material}", 22, 29, 32, 4),
        HR(4, 35, 54, 0.3),
        T("Accession #", 4, 36, 50, 3, { fontWeight: 600 }),
        T("{accession}", 4, 40, 54, 5, { font: "D", fontWeight: 700 }),
        QR("{accession}", 60, 30, 16),
    ],
};

const kegRfid60x40: LabelDoc = {
    id: "tpl_keg_60x40",
    name: "Beverage Keg RFID 60×40",
    builtIn: true,
    category: "logistics",
    tags: ["rfid", "keg", "beverage", "qr"],
    settings: defaultSettings({
        widthMm: 60,
        heightMm: 40,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 6, prefix: "KEG" },
    }),
    elements: [
        LOGO(3, 3, 12, 6),
        ICON("rfid", 51, 3, 6),
        ICON("bottle", 17, 3, 6),
        T("BEVERAGE KEG", 24, 4, 26, 3, { fontWeight: 600, align: "center" }),
        T("{keg_id}", 3, 11, 38, 6, { font: "D", scaleY: 3, fontWeight: 700 }),
        QR("{keg_id}", 42, 11, 14),
        HR(3, 26, 54, 0.3),
        T("{beverage}", 3, 27, 54, 5, { font: "D", fontWeight: 700 }),
        T("ABV: {abv}%", 3, 32, 25, 3, { fontWeight: 600 }),
        T("Vol: {volume} L", 30, 32, 27, 3, { fontWeight: 600 }),
        T("Owner: {owner}", 3, 35, 54, 3),
    ],
};

const medicalDeviceRfid60x40: LabelDoc = {
    id: "tpl_medical_device_60x40",
    name: "Medical Device RFID 60×40",
    builtIn: true,
    category: "healthcare",
    tags: ["rfid", "medical", "device", "service"],
    settings: defaultSettings({
        widthMm: 60,
        heightMm: 40,
        rfid: rfidOn(),
        serial: { enabled: true, start: 1, step: 1, pad: 7, prefix: "MED" },
    }),
    elements: [
        LOGO(3, 2, 12, 6),
        ICON("rfid", 51, 2, 6),
        T("MEDICAL DEVICE", 17, 3, 32, 3, { fontWeight: 600, align: "center" }),
        T("{device}", 3, 9, 38, 4, { font: "D", fontWeight: 700 }),
        T("{serial}", 3, 14, 38, 5, { font: "D", scaleY: 2, fontWeight: 700 }),
        QR("{serial}", 42, 9, 14),
        HR(3, 24, 38, 0.3),
        ICON("calendar", 3, 25, 3),
        T("Last Service: {service_date}", 7, 25, 50, 3),
        ICON("expiry", 3, 29, 3),
        T("Next Service: {service_due}", 7, 29, 50, 3, { fontWeight: 600 }),
        ICON("shield", 3, 33, 3),
        T("Owner: {owner}", 7, 33, 50, 3),
        T("RFID + QR Verified", 3, 37, 54, 3, { fontWeight: 600, align: "center" }),
    ],
};

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
    product: "Product",
    shipping: "Shipping",
    inventory: "Inventory",
    asset: "Asset",
    retail: "Retail",
    logistics: "Logistics",
    healthcare: "Healthcare",
    office: "Office",
};

export const CATEGORY_ORDER: TemplateCategory[] = [
    "product",
    "shipping",
    "inventory",
    "asset",
    "retail",
    "logistics",
    "healthcare",
    "office",
];

export const BUILT_IN_TEMPLATES: LabelDoc[] = [
    // Non-RFID
    product60x40,
    productPremium70x40,
    promoTag50x30,
    priceTag40x25,
    jewelryTag50x20,
    apparelHangtag50x80,
    wineBottle80x40,
    foodNutrition60x40,
    shipping100x60,
    shippingCompact80x50,
    palletPlain100x150,
    returnLabel100x60,
    addressLabel60x30,
    uspsStyle100x60,
    inventory40x25,
    binLabel60x30,
    shelfLabel80x30,
    locationTag50x30,
    pickSlip100x40,
    skuStrip60x20,
    nameBadge80x50,
    fileFolder80x30,
    cableWrap30x15,
    barcodeStrip60x20,
    eanSticker50x30,
    giftTag60x40,
    eventBadge80x50,
    electronicsSpec70x40,
    groceryShelf50x30,
    archiveBox60x40,
    // NWS Label
    nwsLabel45x20,
    nwsLabel60x40,
    nwsLabel80x30,
    nwsLabel100x30,
    // RFID
    assetTag50x30,
    itAsset60x40,
    toolCrib50x25,
    equipmentPlate70x40,
    serverRack60x20,
    vehicleAsset80x50,
    furnitureTag50x30,
    labEquipment70x40,
    apparelRfidHangtag50x80,
    footwearRfid60x30,
    jewelryRfid40x20,
    eyewearRfid50x25,
    cosmeticsRfid40x25,
    premiumTag60x40,
    palletRfid100x150,
    containerRfid100x60,
    returnableCrate80x50,
    cartonRfid100x40,
    reelSpool50x50,
    patientWristband100x25,
    specimen60x30,
    pharmacy50x30,
    bloodBag80x50,
    reusableBin60x40,
    wipTracker50x30,
    libraryBook50x25,
    uniformRfid50x30,
    artworkRfid80x50,
    kegRfid60x40,
    medicalDeviceRfid60x40,
];

export function cloneTemplate(doc: LabelDoc, newId: string, newName?: string): LabelDoc {
    return {
        ...doc,
        id: newId,
        name: newName ?? `${doc.name} copy`,
        builtIn: false,
        settings: {
            ...doc.settings,
            serial: { ...doc.settings.serial },
            rfid: { ...doc.settings.rfid },
        },
        elements: doc.elements.map((el) => ({ ...el, pos: { ...el.pos }, size: { ...el.size } })),
    };
}

// Re-fit a template's elements to a different label size.
// Positions and sizes scale linearly per axis so the layout adapts to any
// dimensions (e.g. 60×40 → 54×34). Stroke/cell/thickness follow the smaller
// axis ratio so circles stay circles and outlines don't blow up.
export function scaleTemplate(doc: LabelDoc, newW: number, newH: number): LabelDoc {
    const oldW = doc.settings.widthMm;
    const oldH = doc.settings.heightMm;
    if (newW === oldW && newH === oldH) {
        return doc;
    }
    const sx = newW / oldW;
    const sy = newH / oldH;
    const sMin = Math.min(sx, sy);

    const scaledElements = doc.elements.map((el) => {
        const base = {
            ...el,
            pos: { x: el.pos.x * sx, y: el.pos.y * sy },
            size: { w: el.size.w * sx, h: el.size.h * sy },
        };
        if (el.kind === "rect" || el.kind === "line") {
            return { ...base, thickness: el.thickness * sMin };
        }
        if (el.kind === "qr") {
            const cell = Math.max(1, Math.round(el.cell * sMin));
            return { ...base, cell };
        }
        return base;
    });

    return {
        ...doc,
        settings: {
            ...doc.settings,
            widthMm: newW,
            heightMm: newH,
            serial: { ...doc.settings.serial },
            rfid: { ...doc.settings.rfid },
        },
        elements: scaledElements,
    };
}
