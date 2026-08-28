/** Maximum finalized-batch spans that receive self-duration work. */

export const MAX_SELF_DURATION_SPANS = 256;
export const DEFAULT_COMPLETION_HOLDBACK_MILLIS = 100;
export const DEFAULT_SHUTDOWN_IDLE_WAIT_MILLIS = 30_000;

/** Env vars applied when constructor options omit a field. Constructor wins over env. */
export const ENV_COMPLETION_HOLDBACK_MILLIS = "OTEL_CX_TRANSACTION_COMPLETION_HOLDBACK_MILLIS";
