export {
    TransactionSpanProcessor,
    DEFAULT_COMPLETION_HOLDBACK_MILLIS,
    DEFAULT_MAX_TXN_TRACE_NODES,
} from './transaction-span-processor';
export type {TransactionSpanProcessorOptions} from './transaction-span-processor';
export {
    DEFAULT_SHUTDOWN_IDLE_WAIT_MILLIS,
    ENV_COMPLETION_HOLDBACK_MILLIS,
    ENV_MAX_NODES,
} from './defaults';
export {selectSlowestSpans} from './trace-heap';
