import {describe, it} from "node:test";
import assert from "node:assert";
import {
    DEFAULT_COMPLETION_HOLDBACK_MILLIS,
    ENV_COMPLETION_HOLDBACK_MILLIS,
} from "../../../src/trace/processors/defaults";
import {parseEnvInt, resolveProcessorOptions} from "../../../src/trace/processors/env-options";

export default describe("resolveProcessorOptions / parseEnvInt", () => {
    it("parseEnvInt falls back on invalid values", () => {
        assert.strictEqual(parseEnvInt(undefined, 7), 7);
        assert.strictEqual(parseEnvInt("", 7), 7);
        assert.strictEqual(parseEnvInt("  ", 7), 7);
        assert.strictEqual(parseEnvInt("abc", 7), 7);
        assert.strictEqual(parseEnvInt("1.5", 7), 7);
        assert.strictEqual(parseEnvInt("NaN", 7), 7);
        assert.strictEqual(parseEnvInt("42", 7), 42);
        assert.strictEqual(parseEnvInt("0", 7), 0);
        assert.strictEqual(parseEnvInt("-1", 7), 7);
        assert.strictEqual(parseEnvInt("-42", 7), 7);
    });

    it("uses defaults when constructor and env are empty", () => {
        const resolved = resolveProcessorOptions({}, {});
        assert.deepStrictEqual(resolved, {
            completionHoldbackMillis: DEFAULT_COMPLETION_HOLDBACK_MILLIS,
        });
    });

    it("reads env when constructor omits a field", () => {
        const env = {
            [ENV_COMPLETION_HOLDBACK_MILLIS]: "0",
        };
        const resolved = resolveProcessorOptions({}, env);
        assert.deepStrictEqual(resolved, {
            completionHoldbackMillis: 0,
        });
    });

    it("constructor options win over env", () => {
        const env = {
            [ENV_COMPLETION_HOLDBACK_MILLIS]: "50",
        };
        const resolved = resolveProcessorOptions({
            completionHoldbackMillis: 0,
        }, env);
        assert.deepStrictEqual(resolved, {
            completionHoldbackMillis: 0,
        });
    });

    it("invalid completion-holdback env falls back to its default", () => {
        const env = {
            [ENV_COMPLETION_HOLDBACK_MILLIS]: "nope",
        };
        const resolved = resolveProcessorOptions({}, env);
        assert.strictEqual(resolved.completionHoldbackMillis, DEFAULT_COMPLETION_HOLDBACK_MILLIS);
    });
});
