import {
    DEFAULT_COMPLETION_HOLDBACK_MILLIS,
    DEFAULT_MAX_TRACES,
    DEFAULT_MAX_TRANSACTION_SPANS,
    ENV_COMPLETION_HOLDBACK_MILLIS,
    ENV_MAX_TRACES,
    ENV_MAX_TRANSACTION_SPANS,
} from "./defaults";

export interface EnvResolvedProcessorOptions {
    completionHoldbackMillis: number;
    maxTransactionSpans: number;
    maxTraces: number;
}

/**
 * Resolve processor numeric options: constructor value wins; else env; else default.
 * Invalid / non-finite env values fall back to the default.
 */
export function resolveProcessorOptions(options: {
    completionHoldbackMillis?: number;
    maxTransactionSpans?: number;
    maxTraces?: number;
}, env: NodeJS.ProcessEnv = process.env): EnvResolvedProcessorOptions {
    return {
        completionHoldbackMillis: pickInt(
            options.completionHoldbackMillis,
            env[ENV_COMPLETION_HOLDBACK_MILLIS],
            DEFAULT_COMPLETION_HOLDBACK_MILLIS,
        ),
        maxTransactionSpans: pickInt(
            options.maxTransactionSpans,
            env[ENV_MAX_TRANSACTION_SPANS],
            DEFAULT_MAX_TRANSACTION_SPANS,
        ),
        maxTraces: pickInt(
            options.maxTraces,
            env[ENV_MAX_TRACES],
            DEFAULT_MAX_TRACES,
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
