import {describe, it} from "node:test";
import assert from "node:assert";
import {
    DEFAULT_COMPLETION_HOLDBACK_MILLIS,
    DEFAULT_HARVEST_PERIOD_MILLIS,
    DEFAULT_MAX_REGULAR_TRACES,
    DEFAULT_MAX_TXN_TRACE_NODES,
    ENV_COMPLETION_HOLDBACK_MILLIS,
    ENV_HARVEST_PERIOD_MILLIS,
    ENV_MAX_NODES,
    ENV_MAX_REGULAR_TRACES,
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
        assert.strictEqual(parseEnvInt("-1", 7), -1);
    });

    it("uses defaults when constructor and env are empty", () => {
        const resolved = resolveProcessorOptions({}, {});
        assert.deepStrictEqual(resolved, {
            maxNodes: DEFAULT_MAX_TXN_TRACE_NODES,
            maxRegularTraces: DEFAULT_MAX_REGULAR_TRACES,
            harvestPeriodMillis: DEFAULT_HARVEST_PERIOD_MILLIS,
            completionHoldbackMillis: DEFAULT_COMPLETION_HOLDBACK_MILLIS,
        });
    });

    it("reads env when constructor omits a field", () => {
        const env = {
            [ENV_MAX_NODES]: "128",
            [ENV_MAX_REGULAR_TRACES]: "0",
            [ENV_HARVEST_PERIOD_MILLIS]: "5000",
            [ENV_COMPLETION_HOLDBACK_MILLIS]: "0",
        };
        const resolved = resolveProcessorOptions({}, env);
        assert.deepStrictEqual(resolved, {
            maxNodes: 128,
            maxRegularTraces: 0,
            harvestPeriodMillis: 5000,
            completionHoldbackMillis: 0,
        });
    });

    it("constructor options win over env", () => {
        const env = {
            [ENV_MAX_NODES]: "128",
            [ENV_MAX_REGULAR_TRACES]: "3",
            [ENV_HARVEST_PERIOD_MILLIS]: "5000",
            [ENV_COMPLETION_HOLDBACK_MILLIS]: "50",
        };
        const resolved = resolveProcessorOptions({
            maxNodes: 64,
            maxRegularTraces: 0,
            harvestPeriodMillis: 1000,
            completionHoldbackMillis: 0,
        }, env);
        assert.deepStrictEqual(resolved, {
            maxNodes: 64,
            maxRegularTraces: 0,
            harvestPeriodMillis: 1000,
            completionHoldbackMillis: 0,
        });
    });

    it("invalid env falls back to default for that field", () => {
        const env = {
            [ENV_MAX_NODES]: "nope",
            [ENV_MAX_REGULAR_TRACES]: "2.5",
        };
        const resolved = resolveProcessorOptions({}, env);
        assert.strictEqual(resolved.maxNodes, DEFAULT_MAX_TXN_TRACE_NODES);
        assert.strictEqual(resolved.maxRegularTraces, DEFAULT_MAX_REGULAR_TRACES);
    });
});
