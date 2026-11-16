const { connectorVersionError } = require("../electron/runtime.cjs");

function enabled(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "1"
        || normalized === "true"
        || normalized === "yes"
        || normalized === "enabled";
}

function runtimeManifestPolicyErrors(manifest, {
    strictRelease = false,
} = {}) {
    const errors = [];
    const versionError = connectorVersionError(manifest?.connector?.version);
    if (versionError) errors.push(`runtime manifest connector is incompatible: ${versionError}`);

    if (strictRelease) {
        if (manifest?.web?.sourceDirty !== false) {
            errors.push(
                "strict release requires a clean, verifiable web source (sourceDirty must be false)",
            );
        }
        if (manifest?.connector?.signed !== true) {
            errors.push("strict release requires a signed Windows connector artifact");
        }
    }
    return errors;
}

module.exports = {
    enabled,
    runtimeManifestPolicyErrors,
};
