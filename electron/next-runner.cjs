const Module = require("node:module");
const path = require("node:path");

const [serverPath, tracedModulesPath] = process.argv.slice(2);
if (!serverPath || !tracedModulesPath) {
    throw new Error("Next runner requires server.js and traced module paths.");
}

process.env.NODE_PATH = [
    tracedModulesPath,
    process.env.NODE_PATH,
].filter(Boolean).join(path.delimiter);

// utilityProcess initializes Node's global module paths before this wrapper
// receives control. Rebuild them after applying the traced standalone path.
Module._initPaths();

require(serverPath);
