import {
    printerRoutingConfigPath,
    type PrinterAliasConfig,
    readPrinterRoutingConfig,
    writePrinterRoutingConfig,
} from "@/printer-routing";
import { isRecord, jsonResponse, optionsResponse } from "../_common";

export const runtime = "nodejs";

export function OPTIONS(): Response {
    return optionsResponse();
}

export async function GET(): Promise<Response> {
    const config = await readPrinterRoutingConfig();
    return jsonResponse({ ok: true, config, path: printerRoutingConfigPath() });
}

export async function POST(req: Request): Promise<Response> {
    const body = await req.json().catch(() => null);
    if (!isRecord(body)) {
        return jsonResponse({ ok: false, error: "JSON body must be an object." }, 400);
    }
    const config = await writePrinterRoutingConfig({
        agentUrl: typeof body.agentUrl === "string" ? body.agentUrl : undefined,
        aliases: isRecord(body.aliases)
            ? (body.aliases as Record<string, PrinterAliasConfig>)
            : {},
    });
    return jsonResponse({ ok: true, config, path: printerRoutingConfigPath() });
}
