/** Defaults that bound transaction-processor buffering. */

export const DEFAULT_MAX_TRANSACTION_SPANS = 256;
export const DEFAULT_MAX_TRACES = 0;
export const DEFAULT_COMPLETION_HOLDBACK_MILLIS = 100;
export const DEFAULT_SHUTDOWN_IDLE_WAIT_MILLIS = 30_000;

/** Env vars applied when constructor options omit a field. Constructor wins over env. */
export const ENV_COMPLETION_HOLDBACK_MILLIS = "OTEL_CX_TRANSACTION_COMPLETION_HOLDBACK_MILLIS";
export const ENV_MAX_TRANSACTION_SPANS = "CORALOGIX_MAX_SPANS_PER_TRACE";
export const ENV_MAX_TRACES = "CORALOGIX_MAX_TRANSACTION_TRACES";
