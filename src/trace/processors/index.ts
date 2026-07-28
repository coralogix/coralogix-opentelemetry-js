export {TransactionSpanProcessor} from './transaction-span-processor';
export type {TransactionSpanProcessorOptions} from './transaction-span-processor';
export {startNewTransaction} from './start-new-transaction';
export {
    DEFAULT_MAX_TXN_TRACE_NODES,
    selectSlowestSpans,
} from './trace-heap';
export {
    DEFAULT_HARVEST_PERIOD_MILLIS,
    DEFAULT_MAX_REGULAR_TRACES,
    RegularTraceHeap,
    rootDurationNs,
} from './harvest';
export type {HarvestTrace} from './harvest';
