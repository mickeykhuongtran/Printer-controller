import { compileZplNative, type TemplateValues } from "@/integration";
import {
    isRecord,
    jsonResponse,
    optionsResponse,
    parseTemplate,
} from "../_common";

export const runtime = "nodejs";

export function OPTIONS(): Response {
    return optionsResponse();
}

function bytesToBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
}

export async function POST(req: Request): Promise<Response> {
    try {
        const body = await req.json();
        if (!isRecord(body)) {
            return jsonResponse({ ok: false, error: "JSON body must be an object." }, 400);
        }

        const template = parseTemplate(body.template);
        if (!template) {
            return jsonResponse({ ok: false, error: "template must be a valid .nwl LabelDoc object or JSON string." }, 400);
        }

        const values = isRecord(body.values) ? (body.values as TemplateValues) : {};
        const copies = typeof body.copies === "number" ? body.copies : undefined;
        const compiled = compileZplNative(template, values, { copies });

        return jsonResponse({
            ok: true,
            language: "zpl",
            templateId: template.id,
            templateName: template.name,
            fields: compiled.fields,
            bytes: compiled.payload.byteLength,
            payloadBase64: bytesToBase64(compiled.payload),
            zpl: compiled.zpl,
        });
    } catch (err) {
        return jsonResponse(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            err instanceof RangeError ? 400 : 500,
        );
    }
}
