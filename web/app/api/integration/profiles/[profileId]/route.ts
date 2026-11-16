import {
    jsonResponse,
    optionsResponse,
} from "../../_common";
import {
    deleteProfile,
    profileSummary,
    readProfile,
} from "../../_profiles";

export const runtime = "nodejs";

type RouteContext = {
    params: Promise<{ profileId: string }>;
};

export function OPTIONS(): Response {
    return optionsResponse();
}

export async function GET(_req: Request, context: RouteContext): Promise<Response> {
    try {
        const { profileId } = await context.params;
        const profile = await readProfile(profileId);
        if (!profile) {
            return jsonResponse({ ok: false, error: `Profile "${profileId}" was not found.` }, 404);
        }
        return jsonResponse({
            ok: true,
            profile: profileSummary(profile),
            template: profile.template,
        });
    } catch (err) {
        return jsonResponse(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}

export async function DELETE(_req: Request, context: RouteContext): Promise<Response> {
    try {
        const { profileId } = await context.params;
        const deleted = await deleteProfile(profileId);
        if (!deleted) {
            return jsonResponse({ ok: false, error: `Profile "${profileId}" was not found.` }, 404);
        }
        return jsonResponse({ ok: true, profileId });
    } catch (err) {
        return jsonResponse(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            500,
        );
    }
}
