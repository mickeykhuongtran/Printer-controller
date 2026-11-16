import { extractTemplateFields } from "@/integration";
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

        return jsonResponse({
            ok: true,
            templateId: template.id,
            templateName: template.name,
            fields: extractTemplateFields(template),
        });
    } catch (err) {
        return jsonResponse(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}
