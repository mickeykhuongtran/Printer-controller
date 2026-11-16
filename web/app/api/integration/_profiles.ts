import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { extractTemplateFields, type TemplateField } from "@/integration";
import type { LabelDoc } from "@/types";

export type IntegrationProfile = {
    profileId: string;
    name: string;
    template: LabelDoc;
    fields: TemplateField[];
    createdAt: string;
    updatedAt: string;
    version: number;
};

export type IntegrationProfileSummary = Omit<IntegrationProfile, "template"> & {
    templateId: string;
    templateName: string;
};

function profileDir(): string {
    const configured = process.env.NEXTWAVES_PROFILE_DIR?.trim();
    if (configured) return path.resolve(configured);

    const dataRoot = process.env.NEXTWAVES_DATA_DIR?.trim();
    return dataRoot
        ? path.resolve(dataRoot, "integration-profiles")
        : path.join(process.cwd(), "data", "integration-profiles");
}

export function sanitizeProfileId(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
}

function profileIdFor(template: LabelDoc, requested?: string): string {
    const preferred = requested || template.id || template.name || `profile-${randomUUID()}`;
    const safe = sanitizeProfileId(preferred);
    return safe || `profile-${randomUUID()}`;
}

function profilePath(profileId: string): string {
    const safe = sanitizeProfileId(profileId);
    if (!safe) throw new Error("profileId is required.");
    return path.join(profileDir(), `${safe}.json`);
}

async function ensureProfileDir(): Promise<void> {
    await fs.mkdir(profileDir(), { recursive: true });
}

function summaryFromProfile(profile: IntegrationProfile): IntegrationProfileSummary {
    return {
        profileId: profile.profileId,
        name: profile.name,
        fields: profile.fields,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        version: profile.version,
        templateId: profile.template.id,
        templateName: profile.template.name,
    };
}

function parseProfile(value: unknown): IntegrationProfile | null {
    if (!value || typeof value !== "object") return null;
    const profile = value as Partial<IntegrationProfile>;
    if (typeof profile.profileId !== "string") return null;
    if (typeof profile.name !== "string") return null;
    if (!profile.template || typeof profile.template !== "object") return null;
    if (!Array.isArray(profile.fields)) return null;
    if (typeof profile.createdAt !== "string") return null;
    if (typeof profile.updatedAt !== "string") return null;
    if (typeof profile.version !== "number") return null;
    return profile as IntegrationProfile;
}

export async function listProfiles(): Promise<IntegrationProfileSummary[]> {
    await ensureProfileDir();
    const dir = profileDir();
    const files = await fs.readdir(dir).catch(() => []);
    const profiles = await Promise.all(
        files
            .filter((file) => file.endsWith(".json"))
            .map(async (file) => {
                try {
                    const raw = await fs.readFile(path.join(dir, file), "utf8");
                    const parsed = parseProfile(JSON.parse(raw));
                    return parsed ? summaryFromProfile(parsed) : null;
                } catch {
                    return null;
                }
            }),
    );
    return profiles
        .filter((profile): profile is IntegrationProfileSummary => profile !== null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readProfile(profileId: string): Promise<IntegrationProfile | null> {
    try {
        const raw = await fs.readFile(profilePath(profileId), "utf8");
        return parseProfile(JSON.parse(raw));
    } catch {
        return null;
    }
}

export async function saveProfile({
    template,
    profileId,
    name,
    overwrite = true,
}: {
    template: LabelDoc;
    profileId?: string;
    name?: string;
    overwrite?: boolean;
}): Promise<IntegrationProfile> {
    await ensureProfileDir();
    const id = profileIdFor(template, profileId);
    const filePath = profilePath(id);
    const existing = await readProfile(id);
    if (existing && !overwrite) {
        const err = new Error(`Profile "${id}" already exists.`);
        err.name = "ProfileConflict";
        throw err;
    }
    const now = new Date().toISOString();
    const profile: IntegrationProfile = {
        profileId: id,
        name: name?.trim() || template.name || id,
        template,
        fields: extractTemplateFields(template),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        version: (existing?.version ?? 0) + 1,
    };
    await fs.writeFile(filePath, JSON.stringify(profile, null, 2), "utf8");
    return profile;
}

export async function deleteProfile(profileId: string): Promise<boolean> {
    try {
        await fs.unlink(profilePath(profileId));
        return true;
    } catch {
        return false;
    }
}

export function profileSummary(profile: IntegrationProfile): IntegrationProfileSummary {
    return summaryFromProfile(profile);
}
