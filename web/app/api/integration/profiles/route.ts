import {
    cleanString,
    isRecord,
    jsonResponse,
    optionsResponse,
    parseTemplate,
} from "../_common";
import {
    listProfiles,
    profileSummary,
    saveProfile,
} from "../_profiles";

export const runtime = "nodejs";

export function OPTIONS(): Response {
    return optionsResponse();
}

export async function GET(): Promise<Response> {
    try {
        return jsonResponse({
            ok: true,
            profiles: await listProfiles(),
        });
    } catch (err) {
        return jsonResponse(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
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

        const profile = await saveProfile({
            template,
            profileId: cleanString(body.profileId),
            name: cleanString(body.name, template.name),
            overwrite: body.overwrite !== false,
        });
        const base = `/api/integration/profiles/${profile.profileId}`;

        return jsonResponse({
            ok: true,
            profile: profileSummary(profile),
            endpoints: {
                profile: base,
                compile: `${base}/compile`,
                print: `${base}/print`,
            },
        });
    } catch (err) {
        const status = err instanceof Error && err.name === "ProfileConflict" ? 409 : 500;
        return jsonResponse(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            status,
        );
    }
}
