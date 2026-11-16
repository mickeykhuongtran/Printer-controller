/**
 * Packed monochrome bitmap used by Zebra ZPL graphic commands.
 *
 * Pixels are stored most-significant-bit first, with each scanline padded to
 * a whole byte. `widthBytes` therefore equals `Math.ceil(widthDots / 8)`.
 */
export type RasterBitmap = {
    widthDots: number;
    heightDots: number;
    widthBytes: number;
    bytes: Uint8Array;
};
