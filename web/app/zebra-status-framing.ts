/** Return as soon as a complete framed status reply arrives, not after idle. */
export function hasCompleteZebraStatusResponse(command: string, response: string): boolean {
    const count = command.trim() === "~HQES" ? 1 : command.trim() === "~HS" ? 3 : 0;
    if (!count) return false;
    let remaining = response;
    for (let frame = 0; frame < count; frame++) {
        remaining = remaining.trimStart();
        if (!remaining.startsWith("\x02")) return false;
        const end = remaining.indexOf("\x03", 1);
        if (end < 0 || remaining.slice(1, end).includes("\x02")) return false;
        if (count === 3 && remaining.slice(end + 1, end + 3) !== "\r\n") return false;
        remaining = remaining.slice(end + (count === 3 ? 3 : 1));
    }
    return remaining.trim() === "";
}
