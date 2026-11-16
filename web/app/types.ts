export type Vec = { x: number; y: number };
export type Size = { w: number; h: number };

export type ZplFont = "A" | "B" | "D" | "E";
export type Scale = 1 | 2 | 3;
export type Rotation = 0 | 90 | 180 | 270;
export type Symbology = "CODE128" | "EAN13";
export type ECC = "L" | "M" | "Q" | "H";
export type SymbolSizeMode = "auto" | "manual";
export type QrType = "enhanced" | "model1";
export type QrMode = "mixing" | "numeric" | "alphanumeric" | "byte" | "kanji";
export type QrTextAlignment = "none" | "left" | "center" | "right";
export type QrTextEncoding = "utf8" | "latin1";
export type DataMatrixContentFormat = "standard" | "gs1" | "gs1_digital_link";
export type DataMatrixShape = "square" | "rectangle";
export type DataMatrixTextEncoding = "utf8" | "latin1";
export type DataMatrixAlign = "left" | "center" | "right";
export type DataMatrixVerticalAlign = "top" | "center" | "bottom";

type BaseEl = {
    id: string;
    pos: Vec;
    size: Size;
    locked?: boolean;
    /** Clockwise content rotation inside the physical pos/size frame. */
    rotation?: Rotation;
};

export type FontSource = "zpl" | "system" | "google" | "custom";
export type FontWeight = 300 | 400 | 500 | 600 | 700 | 900;

export type TextAlign = "left" | "center" | "right";
export type TextWrapMode = "none" | "word" | "anywhere";
export type TextFitMode = "clip" | "shrink";

export type TextEl = BaseEl & {
    kind: "text";
    text: string;
    fieldName?: string;
    /** Print only the last N HEX characters of this Text's RFID read value. Undefined = full value. */
    rfidReadLastChars?: number;
    align?: TextAlign;
    wrapMode?: TextWrapMode;
    fitMode?: TextFitMode;
    /** Clearance inside all four edges of the text frame, in mm. */
    marginMm?: number;
    rotation: Rotation;
    // Zebra ZPL built-in bitmap font A/B/D/E with integer scale.
    font: ZplFont;
    scaleX: Scale;
    scaleY: Scale;
    // Optional web-font overrides. When fontSource !== "zpl", these drive
    // the on-screen render. Native ZPL output falls back to a printer font
    // sized from fontSizeMm when browser rasterization is unavailable.
    fontSource?: FontSource;
    fontFamily?: string;
    fontSizeMm?: number;
    fontWeight?: FontWeight;
    fontItalic?: boolean;
    fontUnderline?: boolean;
    // Data URL for "custom" fonts uploaded by the user (TTF/OTF/WOFF).
    customFontDataUrl?: string;
};

export type QrEl = BaseEl & {
    kind: "qr";
    data: string;
    fieldName?: string;
    rotation?: Rotation;
    ecc: ECC;
    cell: number;
    // One QR module must occupy a whole number of printer dots. Auto chooses
    // the largest whole-dot module that fits; manual uses `magnification`.
    sizeMode?: SymbolSizeMode;
    magnification?: number;
    // ISO/IEC QR requires at least four blank modules on every side. The
    // editor may allow a larger value, but never renders fewer than four.
    quietZoneModules?: number;
    // Deployment-specific scanner requirement used by preflight. This is an
    // X-dimension in physical millimetres, not a visual scale percentage.
    minModuleMm?: number;
    version?: number; // Bitmap output: 0 = Auto, 1-40 = minimum QR version.
    align?: DataMatrixAlign;
    verticalAlign?: DataMatrixVerticalAlign;
    // Legacy fields kept for document compatibility. They are deliberately
    // not offered as active controls until all render paths can honour them.
    /** @deprecated Preserved for import compatibility; not emitted by V2 renderers. */
    mask?: number;
    /** @deprecated V2 always generates QR Model 2. */
    qrType?: QrType;
    /** @deprecated Encoder mode is selected from the actual payload. */
    mode?: QrMode;
    /** @deprecated QR symbols do not contain a human-readable text line. */
    textAlignment?: QrTextAlignment;
    /** @deprecated V2 uses UTF-8 data consistently. */
    textEncoding?: QrTextEncoding;
};

export type DataMatrixEl = BaseEl & {
    kind: "datamatrix";
    data: string;
    fieldName?: string;
    rotation?: Rotation;
    /** Standard ECC 200, GS1 AI syntax, or a validated GS1 Digital Link URI. */
    contentFormat?: DataMatrixContentFormat;
    shape?: DataMatrixShape;
    /** Undefined means the encoder selects the smallest valid ECC 200 matrix. */
    symbolRows?: number;
    symbolColumns?: number;
    textEncoding?: DataMatrixTextEncoding;
    sizeMode?: SymbolSizeMode;
    /** Whole printer dots per module. Zebra ^BX supports 1..label width; UI caps at 40. */
    magnification?: number;
    /** ISO/IEC 16022 requires at least one clear module around the symbol. */
    quietZoneModules?: number;
    minModuleMm?: number;
    align?: DataMatrixAlign;
    verticalAlign?: DataMatrixVerticalAlign;
};

export type BarcodeTextPosition = "below" | "above";
export type BarcodeWidthMode = "scan_safe" | "fill";
export type BarcodeAlign = "left" | "center" | "right";
export type BarcodeTextAlign = "left" | "center" | "right";

export type BarcodeEl = BaseEl & {
    kind: "barcode";
    data: string;
    fieldName?: string;
    rotation?: Rotation;
    symbology: Symbology;
    humanReadable: boolean;
    align?: BarcodeAlign;
    sizeMode?: SymbolSizeMode;
    // Deprecated compatibility field; V2 uses sizeMode + narrowDots.
    widthMode?: BarcodeWidthMode;
    narrowDots?: number;
    minModuleMm?: number;
    // Deprecated: Code 128 and EAN-13 derive every bar/space width from the
    // X-dimension; an independent wide-dot value is not meaningful.
    wideDots?: number;
    // Physical HRI metrics used consistently by designer and bitmap output.
    // Undefined barHeightMm derives the bar height from the element frame after
    // reserving any human-readable text and padding.
    barHeightMm?: number;
    textSizeMm?: number;
    textPaddingMm?: number;
    // Legacy canvas-pixel fields migrated by normalizeZebraDocument().
    textSize?: number;
    textPadding?: number;
    textPosition?: BarcodeTextPosition;
    textAlign?: BarcodeTextAlign;
};

export type RectEl = BaseEl & {
    kind: "rect";
    thickness: number;
    filled: boolean;
};

export type LineEl = BaseEl & {
    kind: "line";
    thickness: number;
    orientation: "h" | "v";
    /** Ink sits at the top/left or bottom/right edge of the editable frame. */
    strokeAnchor?: "start" | "end";
};

export type ImageEl = BaseEl & {
    kind: "image";
    src: string;
    fileName?: string;
    threshold: number;
    iconId?: string;
    iconWeight?: number;
};

// Table scaling behaviour when the user drags the resize handles.
//   "all"   — drag scales rows AND columns proportionally to the dragged size.
//   "rows"  — only row heights scale (vertical drag); column widths stay put.
//   "cols"  — only column widths scale (horizontal drag); row heights stay put.
//   "fixed" — outer table size is locked; resize is a no-op. The grid only
//             changes when rows/cols are added/removed (cells redistribute
//             inside the fixed bounds).
//   "auto"  — outer size is derived from cell content (text width × font
//             metrics). Manual drag is ignored; grow/shrink follows text.
export type TableScaleMode = "all" | "rows" | "cols" | "fixed" | "auto";

// Per-cell formatting overrides. Anything left undefined falls back to the
// table-level setting (fontSizeMm, align, headerRow → bold).
//
// `color` is a canvas-only override. Thermal printers are monochrome
// (black ink on white media), so colored cells render in color in the
// designer but always print as black.
export type TableCellStyle = {
    bold?: boolean;
    italic?: boolean;
    align?: TextAlign;
    fontSizeMm?: number;
    color?: string;
    // Per-cell font overrides. Same FontSource semantics as TextEl: "zpl"
    // uses the bitmap-monospace stack; "system" / "google" / "custom" use
    // the chosen web font in the designer. Native output falls back to a
    // built-in printer font when browser raster output is unavailable.
    fontSource?: FontSource;
    fontFamily?: string;
    fontWeight?: FontWeight;
};

export type TableEl = BaseEl & {
    kind: "table";
    rows: number;
    cols: number;
    // Row-major: cells[r * cols + c]. Plain strings — `{var}` placeholders
    // are resolved at print time the same way they are for TextEl.
    cells: string[];
    // Sparse, parallel to `cells`. Each entry may be undefined if that cell
    // uses the table defaults. Length is kept in sync with cells when rows
    // or cols change.
    cellStyles?: Array<TableCellStyle | undefined>;
    // Per-row / per-column sizes in mm. Length must equal rows / cols.
    // The element's outer size.w / size.h is the SUM of these in normal
    // modes; "fixed" mode keeps size.* locked but lets these redistribute.
    rowHeights: number[];
    colWidths: number[];
    scaleMode: TableScaleMode;
    // Border thickness in mm. 0 = no borders.
    borderThickness: number;
    // First row drawn bold. Purely cosmetic — header text still flows
    // through the same {var} expansion path as the rest.
    headerRow?: boolean;
    // Cell text size (mm). Auto-fit computes column widths from this size.
    fontSizeMm: number;
    align?: TextAlign;
    // Table-level font defaults. Cells can override per-cell via cellStyles.
    fontSource?: FontSource;
    fontFamily?: string;
    fontWeight?: FontWeight;
    // Inner cell padding in mm.
    padding: number;
};

export type LabelElement =
    | TextEl
    | QrEl
    | DataMatrixEl
    | BarcodeEl
    | RectEl
    | LineEl
    | ImageEl
    | TableEl;
export type ElementKind = LabelElement["kind"];

export type SerialSettings = {
    enabled: boolean;
    start: number;
    step: number;
    pad: number;
    prefix: string;
};

export type RfidReadBank = "EPC" | "TID";
export type ZebraRfidModel =
    | "auto"
    | "zd611r"
    | "zd421r"
    | "zd621r"
    | "zd500r"
    | "zt231r"
    | "zt411r"
    | "zt421r"
    | "zt610r"
    | "zt620r"
    | "zq511r"
    | "zq521r"
    | "zq630r"
    | "ze511r"
    | "ze521r"
    | "other_link_os";
export type ZebraRfidPositionMode = "calibrated" | "forward" | "backward";
export type ZebraRfidErrorHandling = "N" | "P" | "E";
export type ZebraRfidEpcReadMode = "pc" | "fixed";

export type RfidChipType =
    | "epc_96"
    | "nxp_ucode_9"
    | "nxp_ucode_8m"
    | "impinj_m730"
    | "impinj_m750"
    | "impinj_monza_r6"
    | "alien_higgs_9"
    | "quanray_qstar_7u"
    | "manual";

export type RfidSettings = {
    enabled: boolean;
    chip: RfidChipType;
    epcBits: number;          // typically 96 / 128 / 240; derived from chip
    autoEpcBitsFromData?: boolean; // derive the write length from each RFID payload instead of epcBits.
    format: "A" | "H";
    retries: number;
    block: number;
    words: number;            // legacy - kept in sync with epcBits / 16
    data: string;             // literal EPC data or a source placeholder like "{rfid}"
    fieldName?: string;
    power?: number;           // lab/profile RFID write power reference
    writePositionMm?: number; // W.P reference
    readEnabled?: boolean;
    /** Save per-label printer readback in the local TCP connector's session history. */
    captureToHost?: boolean;
    readBank?: RfidReadBank;
    readStartBlock?: number;
    readLength?: number;      // HEX character count; fixed Zebra reads convert 2 chars to one ^RF byte.
    readFieldName?: string;   // Template variable populated by the printer RFID read (default: rfid_read).
    zebraModel?: ZebraRfidModel;
    zebraUsePrinterSettings?: boolean; // true uses values saved by Zebra RFID calibration.
    zebraPositionMode?: ZebraRfidPositionMode;
    zebraReadPower?: number;
    zebraWritePower?: number;
    zebraAntenna?: string;
    zebraAdaptiveAntenna?: boolean;
    zebraErrorHandling?: ZebraRfidErrorHandling;
    zebraEpcReadMode?: ZebraRfidEpcReadMode;
    zebraReadByteCount?: number;
};

export type PrinterDpi = 203 | 300 | 600;
export type PrintMode = "thermal_transfer" | "direct_thermal";
export type SensorMode = 0 | 1 | 2;
export type CodePage = 850 | 852 | 437 | 860 | 863 | 865;

export type LabelSettings = {
    /** Absolute template orientation; geometry already includes this rotation. */
    contentRotation?: Rotation;
    widthMm: number;
    heightMm: number;
    gapMm: number;
    dpi: PrinterDpi;
    // Design-time printer target. Physical connection details remain local in
    // PrinterSettings so portable .nwl templates never embed an IP/COM/queue.
    targetPrinterModel?: ZebraRfidModel;
    copies: number;
    speed: number;
    darkness: number;
    printMode?: PrintMode;
    sensorMode?: SensorMode;
    startOffsetDots?: number;
    rowOffsetDots?: number;
    codePage?: CodePage;
    serial: SerialSettings;
    rfid: RfidSettings;
    // Visual-only paper background extending outside the printable label
    // area. Helps the user see how the label sits on a wider paper roll for
    // calibration. Does not affect ZPL output — the printer always treats
    // (0,0) as the top-left of its own paper.
    paperMarginXMm?: number;
    paperMarginYMm?: number;
};

export type DataCell = string;

// Excel-style "Format Cells" — controls presentation only. The underlying
// stored value stays raw (e.g. "10000"); display, label preview, and ZPL
// output show the formatted version (e.g. "10,000" or "$10,000.00"). Formula
// references (`{price}*2`) continue to use the raw numeric value.
export type ColumnFormat =
    | { type: "text" }
    | { type: "number"; decimals?: number; thousands?: boolean }
    | {
          type: "currency";
          decimals?: number;
          thousands?: boolean;
          symbol?: string;
          position?: "before" | "after";
      }
    | { type: "percent"; decimals?: number; thousands?: boolean }
    | {
          type: "custom";
          prefix?: string;
          suffix?: string;
          decimals?: number;
          thousands?: boolean;
      };

export type DataColumn = {
    id: string;
    name: string;
    formula?: string;
    width?: number;
    format?: ColumnFormat;
    // System columns are tied to built-in mechanisms (the serial counter for
    // `step`). They can't be renamed, reformulated, or deleted by the user
    // AND their cells are read-only (computed by the system).
    system?: boolean;
    // Protected columns are name-locked + delete-locked but their cells are
    // still user-editable. Kept for managed/legacy columns.
    protected?: boolean;
};

export type DataRow = {
    id: string;
    cells: Record<string, DataCell>;
};

export type DataFeed = {
    columns: DataColumn[];
    rows: DataRow[];
};

export type TemplateFieldDefinition = {
    id: string;
    name: string;
    value: string;
};

export type TemplateCategory =
    | "product"
    | "shipping"
    | "inventory"
    | "asset"
    | "retail"
    | "logistics"
    | "healthcare"
    | "office";

export type NwsLabelProfile = {
    sizeLabel: string;
    profileId: string;
    media: {
        widthMm: number;
        heightMm: number;
        gapMm: number;
        speed: number;
        darkness: number;
        dpi: PrinterDpi;
        printMode?: PrintMode;
        sensorMode: SensorMode;
        startOffsetDots?: number;
        rowOffsetDots?: number;
        codePage?: CodePage;
    };
    rfid: {
        power: number;
        writePositionMm: number;
    };
};

export type LabelDoc = {
    symbolConfigVersion?: 2;
    id: string;
    name: string;
    builtIn?: boolean;
    category?: TemplateCategory;
    tags?: string[];
    nwsLabel?: NwsLabelProfile;
    settings: LabelSettings;
    elements: LabelElement[];
    templateFields?: TemplateFieldDefinition[];
    dataFeed?: DataFeed;
    // Epoch ms; stamped by upsertCustomTemplate so the saved-files history can
    // sort by recency. Absent on built-in templates and pre-existing saves.
    updatedAt?: number;
};

export type DesignerState = {
    doc: LabelDoc;
    selectedId: string | null;
    selectedIds: string[];
    editingId: string | null;
    snapToGrid: boolean;
    showGrid: boolean;
    highlightVars: boolean;
    zoom: number;
    feedOpen: boolean;
    feedFullscreen: boolean;
    previewRowId: string | null;
};

export type DesignerAction =
    | { type: "load"; doc: LabelDoc }
    | { type: "addElement"; element: LabelElement }
    | { type: "updateElement"; id: string; patch: Partial<LabelElement> }
    | { type: "removeElement"; id: string }
    | { type: "removeElements"; ids: string[] }
    | { type: "select"; id: string | null }
    | { type: "selectAdd"; id: string }
    | { type: "selectToggle"; id: string }
    | { type: "selectMany"; ids: string[] }
    | { type: "moveElements"; deltas: { id: string; pos: Vec }[] }
    | { type: "moveElement"; id: string; pos: Vec }
    | { type: "resizeElement"; id: string; pos: Vec; size: Size }
    | {
          type: "updateSettings";
          patch: Partial<LabelSettings>;
          resizePolicy?: "scale" | "keep";
      }
    | { type: "updateSerial"; patch: Partial<SerialSettings> }
    | { type: "updateRfid"; patch: Partial<RfidSettings> }
    | { type: "rename"; name: string }
    | { type: "toggleSnap" }
    | { type: "toggleGrid" }
    | { type: "toggleHighlightVars" }
    | { type: "setZoom"; zoom: number }
    | { type: "reorder"; id: string; direction: "up" | "down" | "top" | "bottom" }
    | { type: "moveLayerTo"; id: string; toIndex: number }
    | { type: "beginEdit"; id: string }
    | { type: "endEdit" }
    | { type: "feed/setOpen"; open: boolean }
    | { type: "feed/setFullscreen"; fullscreen: boolean }
    | { type: "feed/setPreviewRow"; rowId: string | null }
    | { type: "feed/addColumn"; name?: string }
    | { type: "feed/renameColumn"; id: string; name: string }
    | { type: "feed/setColumnFormula"; id: string; formula: string | undefined }
    | { type: "feed/deleteColumn"; id: string }
    | { type: "feed/reorderColumn"; id: string; toIndex: number }
    | { type: "feed/setColumnWidth"; id: string; width: number | undefined }
    | { type: "feed/setColumnFormat"; id: string; format: ColumnFormat | undefined }
    | { type: "feed/addRow" }
    | { type: "feed/addRows"; count: number }
    | { type: "feed/setCell"; rowId: string; colId: string; value: string }
    | {
          type: "feed/setCells";
          updates: Array<{ rowId: string; colId: string; value: string }>;
          addRows?: number;
      }
    | { type: "feed/deleteRows"; rowIds: string[] }
    | { type: "feed/replaceAll"; columns: DataColumn[]; rows: DataRow[] };
