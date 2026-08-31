import {describe, it} from "node:test";
import assert from "node:assert";
import {
    DEFAULT_COMPLETION_HOLDBACK_MILLIS,
    DEFAULT_MAX_TRACES,
    DEFAULT_MAX_TRANSACTION_SPANS,
    ENV_COMPLETION_HOLDBACK_MILLIS,
    ENV_MAX_TRACES,
    ENV_MAX_TRANSACTION_SPANS,
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
            maxTransactionSpans: DEFAULT_MAX_TRANSACTION_SPANS,
            maxTraces: DEFAULT_MAX_TRACES,
        });
    });

    it("reads env when constructor omits a field", () => {
        const env = {
            [ENV_COMPLETION_HOLDBACK_MILLIS]: "0",
        };
        const resolved = resolveProcessorOptions({}, env);
        assert.deepStrictEqual(resolved, {
            completionHoldbackMillis: 0,
            maxTransactionSpans: DEFAULT_MAX_TRANSACTION_SPANS,
            maxTraces: DEFAULT_MAX_TRACES,
        });
    });

    it("constructor options win over env", () => {
        const env = {
            [ENV_COMPLETION_HOLDBACK_MILLIS]: "50",
        };
        const resolved = resolveProcessorOptions({
            completionHoldbackMillis: 0,
            maxTransactionSpans: DEFAULT_MAX_TRANSACTION_SPANS,
            maxTraces: DEFAULT_MAX_TRACES,
        }, env);
        assert.deepStrictEqual(resolved, {
            completionHoldbackMillis: 0,
            maxTransactionSpans: DEFAULT_MAX_TRANSACTION_SPANS,
            maxTraces: DEFAULT_MAX_TRACES,
        });
    });

    it("invalid completion-holdback env falls back to its default", () => {
        const env = {
            [ENV_COMPLETION_HOLDBACK_MILLIS]: "nope",
        };
        const resolved = resolveProcessorOptions({}, env);
        assert.strictEqual(resolved.completionHoldbackMillis, DEFAULT_COMPLETION_HOLDBACK_MILLIS);
    });

    it("resolves transaction limits from env and lets constructor options win", () => {
        const env = {
            [ENV_MAX_TRANSACTION_SPANS]: "12",
            [ENV_MAX_TRACES]: "3",
        };
        assert.deepStrictEqual(resolveProcessorOptions({}, env), {
            completionHoldbackMillis: DEFAULT_COMPLETION_HOLDBACK_MILLIS,
            maxTransactionSpans: 12,
            maxTraces: 3,
        });
        assert.deepStrictEqual(resolveProcessorOptions({maxTransactionSpans: 9, maxTraces: 2}, env), {
            completionHoldbackMillis: DEFAULT_COMPLETION_HOLDBACK_MILLIS,
            maxTransactionSpans: 9,
            maxTraces: 2,
        });
    });

    it("accepts zero transaction limits", () => {
        const resolved = resolveProcessorOptions({}, {
            [ENV_MAX_TRANSACTION_SPANS]: "0",
            [ENV_MAX_TRACES]: "0",
        });
        assert.strictEqual(resolved.maxTransactionSpans, 0);
        assert.strictEqual(resolved.maxTraces, 0);
    });
});
