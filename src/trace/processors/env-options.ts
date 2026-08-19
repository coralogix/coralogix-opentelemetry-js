import {
    DEFAULT_COMPLETION_HOLDBACK_MILLIS,
    DEFAULT_HARVEST_PERIOD_MILLIS,
    DEFAULT_MAX_REGULAR_TRACES,
    DEFAULT_MAX_TXN_TRACE_NODES,
    ENV_COMPLETION_HOLDBACK_MILLIS,
    ENV_HARVEST_PERIOD_MILLIS,
    ENV_MAX_NODES,
    ENV_MAX_REGULAR_TRACES,
} from "./defaults";

export interface EnvResolvedProcessorOptions {
    maxNodes: number;
    maxRegularTraces: number;
    harvestPeriodMillis: number;
    completionHoldbackMillis: number;
}

/**
 * Resolve processor numeric options: constructor value wins; else env; else default.
 * Invalid / non-finite env values fall back to the default.
 */
export function resolveProcessorOptions(options: {
    maxNodes?: number;
    maxRegularTraces?: number;
    harvestPeriodMillis?: number;
    completionHoldbackMillis?: number;
}, env: NodeJS.ProcessEnv = process.env): EnvResolvedProcessorOptions {
    return {
        maxNodes: pickInt(options.maxNodes, env[ENV_MAX_NODES], DEFAULT_MAX_TXN_TRACE_NODES),
        maxRegularTraces: pickInt(
            options.maxRegularTraces,
            env[ENV_MAX_REGULAR_TRACES],
            DEFAULT_MAX_REGULAR_TRACES,
        ),
        harvestPeriodMillis: pickInt(
            options.harvestPeriodMillis,
            env[ENV_HARVEST_PERIOD_MILLIS],
            DEFAULT_HARVEST_PERIOD_MILLIS,
        ),
        completionHoldbackMillis: pickInt(
            options.completionHoldbackMillis,
            env[ENV_COMPLETION_HOLDBACK_MILLIS],
            DEFAULT_COMPLETION_HOLDBACK_MILLIS,
        ),
    };
}

function pickInt(
    constructorValue: number | undefined,
    envValue: string | undefined,
    fallback: number,
): number {
    if (constructorValue !== undefined) {
        return constructorValue;
    }
    return parseEnvInt(envValue, fallback);
}

/** Parse an env integer; invalid / empty → fallback. Exported for unit tests. */
export function parseEnvInt(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === "") {
        return fallback;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        return fallback;
    }
    return n;
}
