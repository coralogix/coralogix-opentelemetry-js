export {
    TransactionSpanProcessor,
    DEFAULT_COMPLETION_HOLDBACK_MILLIS,
    DEFAULT_HARVEST_PERIOD_MILLIS,
    DEFAULT_MAX_REGULAR_TRACES,
    DEFAULT_MAX_TXN_TRACE_NODES,
} from './transaction-span-processor';
export type {TransactionSpanProcessorOptions} from './transaction-span-processor';
export {startNewTransaction} from './start-new-transaction';
export {
    DEFAULT_SHUTDOWN_IDLE_WAIT_MILLIS,
    ENV_COMPLETION_HOLDBACK_MILLIS,
    ENV_HARVEST_PERIOD_MILLIS,
    ENV_MAX_NODES,
    ENV_MAX_REGULAR_TRACES,
} from './defaults';
export {selectSlowestSpans} from './trace-heap';
export {
    RegularTraceHeap,
    rootDurationNs,
} from './harvest';
export type {HarvestTrace} from './harvest';
