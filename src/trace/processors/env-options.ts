import {
    DEFAULT_COMPLETION_HOLDBACK_MILLIS,
    ENV_COMPLETION_HOLDBACK_MILLIS,
} from "./defaults";

export interface EnvResolvedProcessorOptions {
    completionHoldbackMillis: number;
}

/**
 * Resolve processor numeric options: constructor value wins; else env; else default.
 * Invalid / non-finite env values fall back to the default.
 */
export function resolveProcessorOptions(options: {
    completionHoldbackMillis?: number;
}, env: NodeJS.ProcessEnv = process.env): EnvResolvedProcessorOptions {
    return {
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
