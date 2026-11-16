/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { inflateSync } = require("node:zlib");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
        fileName: filename,
    }).outputText;
    module._compile(output, filename);
};

const {
    buildFullPageStoredGraphicDownloadZpl,
    buildFullPageStoredGraphicRecallZpl,
    buildFullPageZpl,
    buildStoredGraphicDeleteZpl,
} = require(path.join(__dirname, "..", "app", "zpl.ts"));

function crc16CcittAscii(value) {
    let crc = 0;
    for (const character of value) {
        crc ^= character.charCodeAt(0) << 8;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = crc & 0x8000
                ? ((crc << 1) ^ 0x1021) & 0xffff
                : (crc << 1) & 0xffff;
        }
    }
    return crc.toString(16).padStart(4, "0").toUpperCase();
}

// Zebra's published ~DG Z64 example ends in :17f0. This fixture verifies
// the independent CRC implementation used to inspect generated output.
const zebraPublishedBase64 = (
    "eJyt0jsOwyAMBmBHDIwcgaNwszymHqNXIeqQkSuQi"
    + "ZURJMRf0wxVtqTFE0gfsrFN1C30gjhgJhpJRenJWAlb+CaiTH2NwKOZwgfGJgkUjRf4"
    + "lYnTLbMcRmFHRP0Yhw3+nlFpgFgzSIWAWEcd8fTKbcFD4I7xEm5NE+dig6SteSTV"
    + "cpXbBl9T2Sz1F5O4yuEwhdhEzJODBNdc6bpps8CQuYdhb38/emhl8Od5XTLr/6btmMv"
    + "Zs/GKDe+YrqqZ8x52MV3iDalNlj4="
);
assert.equal(crc16CcittAscii(zebraPublishedBase64), "17F0");

const widthBytes = 90;
const heightDots = 480;
const bytes = new Uint8Array(widthBytes * heightDots);

// Structured one-bit rows resemble text, rules, and QR modules while retaining
// repeated data that a real label compressor should exploit.
for (let y = 0; y < heightDots; y += 1) {
    for (let xByte = 0; xByte < widthBytes; xByte += 1) {
        if (y % 48 < 4 || (xByte > 7 && xByte < 28 && y % 36 < 18)) {
            bytes[y * widthBytes + xByte] = (xByte + y) % 3 === 0 ? 0xf0 : 0x0f;
        }
    }
}

const settings = {
    widthMm: 60,
    heightMm: 40,
    gapMm: 3,
    dpi: 300,
    copies: 1,
    speed: 4,
    darkness: 10,
    printMode: "thermal_transfer",
    tearOffMm: 0,
    sensorMode: 2,
    startOffsetDots: 0,
    rowOffsetDots: 0,
    codePage: 850,
    serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
    rfid: {
        enabled: false,
        chip: "epc_96",
        epcBits: 96,
        format: "H",
        retries: 3,
        block: 2,
        words: 6,
        data: "",
        zebraUsePrinterSettings: true,
    },
};

const bitmap = {
    widthDots: widthBytes * 8,
    heightDots,
    widthBytes,
    bytes,
};
const first = buildFullPageZpl(settings, bitmap, 1);
const second = buildFullPageZpl(settings, bitmap, 1);
assert.equal(first, second, "the same bitmap must produce deterministic Z64");

function graphicMatch(zpl) {
    const graphic = zpl.match(
        /\^GFA,(\d+),(\d+),(\d+),:Z64:([A-Za-z0-9+/=]+):([0-9A-F]{4})\^FS/,
    );
    assert.ok(graphic, "full-page bitmap must use Zebra Z64 inside ^GFA");
    return graphic;
}

function assertGraphicRoundTrip(sourceBytes, sourceWidthBytes) {
    const zpl = buildFullPageZpl(settings, {
        widthDots: sourceWidthBytes * 8,
        heightDots: sourceBytes.length / sourceWidthBytes,
        widthBytes: sourceWidthBytes,
        bytes: sourceBytes,
    }, 1);
    const graphic = graphicMatch(zpl);
    assert.equal(Number(graphic[1]), sourceBytes.length, "binary byte count must remain uncompressed size");
    assert.equal(Number(graphic[2]), sourceBytes.length, "graphic field count must remain uncompressed size");
    assert.equal(Number(graphic[3]), sourceWidthBytes, "bytes-per-row must retain bitmap geometry");
    assert.equal(graphic[5], crc16CcittAscii(graphic[4]), "Z64 CRC must cover Base64 text");
    assert.deepEqual(
        new Uint8Array(inflateSync(Buffer.from(graphic[4], "base64"))),
        sourceBytes,
        "Z64 must inflate to the exact original one-bit bitmap",
    );
    return graphic;
}

const graphic = assertGraphicRoundTrip(bytes, widthBytes);
// Cover both Base64 padding branches rather than relying only on production
// label dimensions that happen to be divisible by three.
assertGraphicRoundTrip(Uint8Array.of(0x80), 1);
assertGraphicRoundTrip(Uint8Array.of(0x80, 0x01), 1);

const asciiHexLength = bytes.length * 2;
assert.ok(
    graphic[4].length < asciiHexLength / 4,
    "structured label fixture should be materially smaller than ASCII hex",
);
assert.match(first, /\^PQ1\r?\n\^XZ/, "compression must not change label quantity semantics");

const storedDownload = buildFullPageStoredGraphicDownloadZpl(bitmap, "NWABC123");
const storedRecall = buildFullPageStoredGraphicRecallZpl(
    settings,
    "NWABC123",
    100,
);
const storedDelete = buildStoredGraphicDeleteZpl("NWABC123");
assert.match(storedDownload, /^~DGR:NWABC123\.GRF,43200,90,:Z64:/);
assert.doesNotMatch(storedRecall, /\^GFA|:Z64:/, "recall windows must not retransmit the bitmap");
assert.match(storedRecall, /\^XGR:NWABC123\.GRF,1,1\^FS/);
assert.match(storedRecall, /\^PQ100/);
assert.match(storedDelete, /\^IDR:NWABC123\.GRF\^FS/);

console.log(
    `Z64 test passed: ${asciiHexLength} ASCII-hex chars -> ${graphic[4].length} Base64 chars; CRC and bitmap round-trip are valid.`,
);
