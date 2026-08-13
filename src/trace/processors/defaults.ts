/** Shared defaults for TransactionSpanProcessor and related harvest/trim helpers. */

export const DEFAULT_MAX_TXN_TRACE_NODES = 256;
export const DEFAULT_MAX_REGULAR_TRACES = 1;
export const DEFAULT_HARVEST_PERIOD_MILLIS = 60_000;
export const DEFAULT_COMPLETION_HOLDBACK_MILLIS = 100;
export const DEFAULT_SHUTDOWN_IDLE_WAIT_MILLIS = 30_000;

/** Env vars applied when constructor options omit a field. Constructor wins over env. */
export const ENV_MAX_NODES = "OTEL_CX_TRANSACTION_MAX_NODES";
export const ENV_MAX_REGULAR_TRACES = "OTEL_CX_TRANSACTION_MAX_REGULAR_TRACES";
export const ENV_HARVEST_PERIOD_MILLIS = "OTEL_CX_TRANSACTION_HARVEST_PERIOD_MILLIS";
export const ENV_COMPLETION_HOLDBACK_MILLIS = "OTEL_CX_TRANSACTION_COMPLETION_HOLDBACK_MILLIS";
