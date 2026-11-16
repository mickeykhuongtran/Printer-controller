import { compileZplNative, type TemplateValues } from "@/integration";
import {
    isRecord,
    jsonResponse,
    optionsResponse,
} from "../../../_common";
import {
    profileSummary,
    readProfile,
} from "../../../_profiles";

export const runtime = "nodejs";

type RouteContext = {
    params: Promise<{ profileId: string }>;
};

export function OPTIONS(): Response {
    return optionsResponse();
}

function bytesToBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
}

export async function POST(req: Request, context: RouteContext): Promise<Response> {
    try {
        const { profileId } = await context.params;
        const profile = await readProfile(profileId);
        if (!profile) {
            return jsonResponse({ ok: false, error: `Profile "${profileId}" was not found.` }, 404);
        }

        const body = await req.json();
        if (!isRecord(body)) {
            return jsonResponse({ ok: false, error: "JSON body must be an object." }, 400);
        }

        const values = isRecord(body.values) ? (body.values as TemplateValues) : {};
        const copies = typeof body.copies === "number" ? body.copies : undefined;
        const compiled = compileZplNative(profile.template, values, { copies });

        return jsonResponse({
            ok: true,
            language: "zpl",
            profile: profileSummary(profile),
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
