const assert = require("node:assert/strict");
const test = require("node:test");

const {
    enabled,
    runtimeManifestPolicyErrors,
} = require("../scripts/bundle-policy.cjs");

function manifest({
    version = "0.12.2",
    sourceDirty = true,
    signed = false,
} = {}) {
    return {
        web: { sourceDirty },
        connector: { version, signed },
    };
}

test("development bundle policy permits dirty and unsigned compatible artifacts", () => {
    assert.deepEqual(runtimeManifestPolicyErrors(manifest()), []);
});

test("bundle policy rejects a connector below the desktop minimum", () => {
    assert.match(
        runtimeManifestPolicyErrors(manifest({ version: "0.3.9" }))[0],
        /older than 0\.12\.2/,
    );
});

test("strict release policy requires clean source and a signed connector", () => {
    const errors = runtimeManifestPolicyErrors(manifest(), { strictRelease: true });
    assert.equal(errors.length, 2);
    assert.match(errors[0], /sourceDirty must be false/);
    assert.match(errors[1], /signed Windows connector/);
    assert.deepEqual(runtimeManifestPolicyErrors(manifest({
        sourceDirty: false,
        signed: true,
    }), { strictRelease: true }), []);
});

test("strict release environment flag accepts explicit enabled values only", () => {
    for (const value of ["1", "true", "TRUE", "yes", "enabled"]) {
        assert.equal(enabled(value), true);
    }
    for (const value of ["", "0", "false", "no", "unexpected"]) {
        assert.equal(enabled(value), false);
    }
});
