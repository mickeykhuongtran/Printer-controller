const fs = require("node:fs");
const path = require("node:path");

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function rotateIfNeeded(filePath) {
    try {
        if (fs.statSync(filePath).size < MAX_LOG_BYTES) return;
        const previous = `${filePath}.1`;
        fs.rmSync(previous, { force: true });
        fs.renameSync(filePath, previous);
    } catch {
        // A missing or temporarily locked log should not prevent app startup.
    }
}

function createLogger(logDir) {
    fs.mkdirSync(logDir, { recursive: true });
    const filePath = path.join(logDir, "desktop-main.log");

    function write(level, message, details) {
        rotateIfNeeded(filePath);
        const record = {
            timestamp: new Date().toISOString(),
            level,
            message: String(message),
            ...(details === undefined ? {} : { details }),
        };
        const line = `${JSON.stringify(record)}\n`;
        try {
            fs.appendFileSync(filePath, line, "utf8");
        } catch {
            // Avoid recursion or a startup crash when the disk is unavailable.
        }
        if (!process.env.NODE_ENV || process.env.NODE_ENV !== "production") {
            process.stderr.write(line);
        }
    }

    function pipe(stream, source) {
        if (!stream) return;
        let buffered = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
            buffered += chunk;
            const lines = buffered.split(/\r?\n/);
            buffered = lines.pop() || "";
            for (const line of lines) {
                if (line.trim()) write("info", `${source}: ${line}`);
            }
        });
        stream.on("end", () => {
            if (buffered.trim()) write("info", `${source}: ${buffered}`);
        });
    }

    return {
        filePath,
        info: (message, details) => write("info", message, details),
        warn: (message, details) => write("warn", message, details),
        error: (message, details) => write("error", message, details),
        pipe,
    };
}

module.exports = { createLogger };
