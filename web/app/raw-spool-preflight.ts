import type { LabelDoc } from "./types";
import { formatSerial, resolveDynamicValue, variablesForCopy } from "./label-data";
import { rfidBitsForData, validateRfidHexValue } from "./rfid";

/** Validate the original row value before rendering or any EPC padding. */
export function validateSpoolHexRows(doc: LabelDoc, startIndex: number, count: number, step: 1 | -1 = 1): void {
    const rfid = doc.settings.rfid;
    if (!rfid.enabled || rfid.format !== "H") return;
    const first = doc.elements.find((element) => element.kind === "text" || element.kind === "qr"
        || element.kind === "barcode" || element.kind === "datamatrix");
    const fallback = first?.kind === "text" ? first.text : first && "data" in first ? first.data : "";
    for (let offset = 0; offset < count; offset += 1) {
        const index = startIndex + offset * step;
        const serial = doc.settings.serial;
        const sn = serial.enabled ? formatSerial(serial.start + index * serial.step, serial.pad, serial.prefix) : "";
        const original = resolveDynamicValue(rfid.data || sn || fallback, rfid.fieldName, sn, variablesForCopy(doc, index));
        const expectedBits = rfidBitsForData(rfid, original);
        const validation = validateRfidHexValue(original, rfid.autoEpcBitsFromData ? undefined : expectedBits);
        const capacityBits = rfid.epcBits && rfid.epcBits > 0 ? rfid.epcBits : rfid.words * 16;
        if (!validation.valid || (capacityBits > 0 && validation.normalized.length * 4 > capacityBits)) {
            throw new Error(`RFID HEX validation failed at data row ${index + 1}: ${validation.reason ?? `EPC exceeds the configured ${capacityBits}-bit capacity`}. No batch has been committed to Windows.`);
        }
    }
}
