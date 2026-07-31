import {
    Attributes,
    AttributeValue,
    Context,
    diag,
    Histogram,
    isSpanContextValid,
    MeterProvider,
    metrics,
    SpanKind,
    trace,
} from "@opentelemetry/api";
import {ReadableSpan, Span, SpanExporter, SpanProcessor} from "@opentelemetry/sdk-trace-base";
import {CoralogixAttributes, CoralogixTraceState} from "../common";
import {
    DEFAULT_HARVEST_PERIOD_MILLIS,
    DEFAULT_MAX_REGULAR_TRACES,
    RegularTraceHeap,
    rootDurationNs,
} from "./harvest";
import {selfTimeNsBySpanId, SpanTimingRow} from "./self-time";
import {DEFAULT_MAX_TXN_TRACE_NODES, selectSlowestSpans} from "./trace-heap";

const METRIC_ATTR_SPAN_NAME = "span.name";
const INSTRUMENTATION_SCOPE_NAME = "coralogix.opentelemetry.transaction";

export interface TransactionSpanProcessorOptions {
    /** MeterProvider used to create the self-time histogram. Defaults to the global MeterProvider. */
    meterProvider?: MeterProvider;
    /**
     * Keep at most this many spans per completed local trace (slowest first;
     * transaction root always kept). Default 256.
     */
    maxNodes?: number;
    /**
     * Keep only the slowest completed local trace(s) until harvest.
     * Default 1. Set to 0 to export every completed trace immediately.
     */
    maxRegularTraces?: number;
    /** Harvest flush interval in milliseconds. Default 60_000. Values <= 0 export every completed trace immediately (no heap). */
    harvestPeriodMillis?: number;
    /**
     * After the last live span in a local trace ends, wait this long before
     * finalizing so fire-and-forget children that start on the same traceId
     * can still join. Default 100. Set to 0 to finalize immediately.
     */
    completionHoldbackMillis?: number;
    /** How long shutdown waits for in-flight spans. Default 30_000. */
    shutdownIdleWaitMillis?: number;
}

export const DEFAULT_COMPLETION_HOLDBACK_MILLIS = 100;

export class TransactionSpanProcessor implements SpanProcessor {
    private readonly exporter: SpanExporter;
    private readonly buffers = new Map<string, ReadableSpan[]>();
    /** traceId -> (spanId -> parentSpanId) for still-running spans */
    private readonly liveParents = new Map<string, Map<string, string | undefined>>();
    /** `${traceId}:${spanId}` -> transaction name for parents that are non-recording / attribute-less */
    private readonly transactionsBySpan = new Map<string, string>();
    private readonly selfTimeHistogram: Histogram;
    private readonly maxNodes: number;
    private readonly maxRegularTraces: number;
    private readonly harvest: RegularTraceHeap;
    private readonly harvestPeriodMillis: number;
    private readonly completionHoldbackMillis: number;
    private readonly shutdownIdleWaitMillis: number;
    private harvestTimer: ReturnType<typeof setInterval> | undefined;
    /** traceId -> holdback timer after last live span ended */
    private readonly pendingCompletions = new Map<string, ReturnType<typeof setTimeout>>();
    /** parentSpanId -> ended direct-child intervals kept for outer self-time after nested txn export */
    private readonly childIntervals = new Map<string, Array<{startNs: bigint; endNs: bigint}>>();
    /** In-flight exporter.export promises; forceFlush/shutdown wait for these. */
    private readonly pendingExports = new Set<Promise<void>>();
    /** Serializes exporter.export so at most one call is in flight. */
    private exportChain: Promise<void> = Promise.resolve();
    private stopped = false;
    private exporterShutdown = false;
    private shutdownPromise: Promise<void> | undefined;

    constructor(exporter: SpanExporter, options: TransactionSpanProcessorOptions = {}) {
        this.exporter = exporter;
        this.maxNodes = options.maxNodes ?? DEFAULT_MAX_TXN_TRACE_NODES;
        this.maxRegularTraces = options.maxRegularTraces ?? DEFAULT_MAX_REGULAR_TRACES;
        this.harvestPeriodMillis = options.harvestPeriodMillis ?? DEFAULT_HARVEST_PERIOD_MILLIS;
        this.completionHoldbackMillis = options.completionHoldbackMillis ?? DEFAULT_COMPLETION_HOLDBACK_MILLIS;
        this.shutdownIdleWaitMillis = options.shutdownIdleWaitMillis ?? 30_000;
        this.harvest = new RegularTraceHeap(this.maxRegularTraces);
        const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(INSTRUMENTATION_SCOPE_NAME);
        this.selfTimeHistogram = meter.createHistogram(CoralogixAttributes.SELF_TIME, {
            unit: "s",
            description: "Exclusive (self) wall time per span within a Coralogix transaction",
        });
        if (this.maxRegularTraces > 0 && this.harvestPeriodMillis > 0) {
            this.harvestTimer = setInterval(() => {
                void this.flushHarvest().catch((error) => {
                    diag.warn("TransactionSpanProcessor: harvest flush failed", error);
                });
            }, this.harvestPeriodMillis);
            if (typeof this.harvestTimer.unref === "function") {
                this.harvestTimer.unref();
            }
        }
    }

    onStart(span: Span, parentContext: Context): void {
        if (!isSpanContextValid(span.spanContext())) {
            return;
        }

        try {
            this.applyTransactionAttributes(span, parentContext);
        } catch (error) {
            diag.debug("TransactionSpanProcessor: failed to resolve transaction attributes, leaving span untagged", error);
        }

        if (this.exporterShutdown) {
            return;
        }

        const {traceId, spanId} = span.spanContext();
        const parentId = trace.getSpanContext(parentContext)?.spanId;

        this.cancelPendingCompletion(traceId);

        if (this.stopped) {
            const live = this.liveParents.get(traceId);
            const hasBuffer = this.buffers.has(traceId);
            if (!live && !hasBuffer) {
                return;
            }
            const tracked = live ?? new Map<string, string | undefined>();
            tracked.set(spanId, parentId);
            this.liveParents.set(traceId, tracked);
            return;
        }

        const live = this.liveParents.get(traceId) ?? new Map<string, string | undefined>();
        live.set(spanId, parentId);
        this.liveParents.set(traceId, live);
    }

    onEnd(span: ReadableSpan): void {
        if (this.exporterShutdown || !isSpanContextValid(span.spanContext())) {
            return;
        }
        const {traceId, spanId} = span.spanContext();
        const live = this.liveParents.get(traceId);
        if (!live && this.stopped && !this.buffers.has(traceId)) {
            return;
        }

        const parentId = span.parentSpanContext?.spanId;
        if (parentId) {
            const intervals = this.childIntervals.get(parentId) ?? [];
            intervals.push({
                startNs: hrTimeToBigIntNanos(span.startTime),
                endNs: hrTimeToBigIntNanos(span.endTime),
            });
            this.childIntervals.set(parentId, intervals);
        }

        const buffer = this.buffers.get(traceId) ?? [];
        buffer.push(span);
        this.buffers.set(traceId, buffer);

        if (live) {
            live.delete(spanId);
            if (live.size === 0) {
                this.liveParents.delete(traceId);
            }
        }

        const stillLive = this.liveParents.get(traceId);
        if (stillLive && stillLive.size > 0) {
            const batches = this.extractCompletedLocalTransactions(traceId);
            for (const batch of batches) {
                this.acceptCompleted(batch);
            }
            return;
        }

        if (this.buffers.get(traceId)?.length) {
            this.scheduleCompletion(traceId);
        } else if (!this.liveParents.has(traceId) && !live) {
            // No live tracking (missed onStart); finalize via holdback/immediate.
            this.scheduleCompletion(traceId);
        }
    }

    async forceFlush(): Promise<void> {
        if (this.exporterShutdown) {
            return;
        }
        this.flushPendingCompletions();
        await this.flushHarvest();
        await this.awaitPendingExports();
        if (this.exporterShutdown || !this.exporter.forceFlush) {
            return;
        }
        await this.runOnExportChain(async () => this.exporter.forceFlush!());
    }

    async shutdown(): Promise<void> {
        if (this.shutdownPromise) {
            return this.shutdownPromise;
        }
        this.shutdownPromise = this.doShutdown();
        return this.shutdownPromise;
    }

    private async doShutdown(): Promise<void> {
        this.stopped = true;
        if (this.harvestTimer !== undefined) {
            clearInterval(this.harvestTimer);
            this.harvestTimer = undefined;
        }
        await this.waitForIdle(this.shutdownIdleWaitMillis);

        this.flushPendingCompletions();

        for (const traceId of [...this.buffers.keys()]) {
            const live = this.liveParents.get(traceId);
            if (live && live.size > 0) {
                const dropped = this.buffers.get(traceId) ?? [];
                this.buffers.delete(traceId);
                this.liveParents.delete(traceId);
                for (const span of dropped) {
                    this.childIntervals.delete(span.spanContext().spanId);
                }
                this.clearTransactionsForTrace(traceId);
                continue;
            }
            const batches = this.extractCompletedLocalTransactions(traceId, true);
            for (const batch of batches) {
                this.acceptCompleted(batch);
            }
            this.clearTransactionsForTrace(traceId);
        }
        this.buffers.clear();
        this.liveParents.clear();
        await this.flushHarvest();
        await this.awaitPendingExports();
        this.exporterShutdown = true;
        this.transactionsBySpan.clear();
        this.childIntervals.clear();
        await this.runOnExportChain(async () => this.exporter.shutdown());
    }

    private cancelPendingCompletion(traceId: string): void {
        const timer = this.pendingCompletions.get(traceId);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.pendingCompletions.delete(traceId);
        }
    }

    private scheduleCompletion(traceId: string): void {
        this.cancelPendingCompletion(traceId);
        if (this.exporterShutdown) {
            return;
        }
        if (this.completionHoldbackMillis <= 0) {
            this.finalizeTraceIfIdle(traceId);
            return;
        }
        const timer = setTimeout(() => {
            if (this.exporterShutdown) {
                return;
            }
            if (this.pendingCompletions.get(traceId) !== timer) {
                return;
            }
            this.pendingCompletions.delete(traceId);
            this.finalizeTraceIfIdle(traceId);
        }, this.completionHoldbackMillis);
        this.pendingCompletions.set(traceId, timer);
    }

    private flushPendingCompletions(): void {
        for (const traceId of [...this.pendingCompletions.keys()]) {
            this.cancelPendingCompletion(traceId);
        }
        for (const traceId of [...this.buffers.keys()]) {
            const live = this.liveParents.get(traceId);
            if (live && live.size > 0) {
                continue;
            }
            this.finalizeTraceIfIdle(traceId);
        }
    }

    private finalizeTraceIfIdle(traceId: string): void {
        if (this.exporterShutdown) {
            return;
        }
        const live = this.liveParents.get(traceId);
        if (live && live.size > 0) {
            return;
        }
        const batches = this.extractCompletedLocalTransactions(traceId, true);
        for (const batch of batches) {
            this.acceptCompleted(batch);
        }
        this.liveParents.delete(traceId);
        this.clearTransactionsForTrace(traceId);
    }

    private extractCompletedLocalTransactions(
        traceId: string,
        flushLeftoverWhenIdle = false,
    ): ReadableSpan[][] {
        const buffer = this.buffers.get(traceId);
        if (!buffer || buffer.length === 0) {
            return [];
        }

        const live = this.liveParents.get(traceId) ?? new Map<string, string | undefined>();
        const parentOf = new Map<string, string>();
        for (const span of buffer) {
            const parentId = span.parentSpanContext?.spanId;
            if (parentId) {
                parentOf.set(span.spanContext().spanId, parentId);
            }
        }
        for (const [spanId, parentId] of live) {
            if (parentId) {
                parentOf.set(spanId, parentId);
            }
        }

        const underRoot = (spanId: string, rootId: string): boolean => {
            const seen = new Set<string>();
            let cur: string | undefined = spanId;
            while (cur && !seen.has(cur)) {
                if (cur === rootId) {
                    return true;
                }
                seen.add(cur);
                cur = parentOf.get(cur);
            }
            return false;
        };

        const hasLiveInSubtree = (rootId: string): boolean => {
            if (live.has(rootId)) {
                return true;
            }
            for (const liveId of live.keys()) {
                if (underRoot(liveId, rootId)) {
                    return true;
                }
            }
            return false;
        };

        const depthOf = (spanId: string): number => {
            let depth = 0;
            let cur: string | undefined = spanId;
            const seen = new Set<string>();
            while (cur && !seen.has(cur)) {
                seen.add(cur);
                const parent = parentOf.get(cur);
                if (!parent) {
                    break;
                }
                depth++;
                cur = parent;
            }
            return depth;
        };

        const roots = buffer
            .filter((span) => span.attributes[CoralogixAttributes.TRANSACTION_ROOT] === true)
            .sort((a, b) => depthOf(b.spanContext().spanId) - depthOf(a.spanContext().spanId));

        const batches: ReadableSpan[][] = [];
        const extracted = new Set<string>();

        for (const root of roots) {
            const rootId = root.spanContext().spanId;
            if (extracted.has(rootId) || hasLiveInSubtree(rootId)) {
                continue;
            }
            const subtree = buffer.filter((span) => {
                const spanId = span.spanContext().spanId;
                if (extracted.has(spanId)) {
                    return false;
                }
                return underRoot(spanId, rootId);
            });
            if (subtree.length === 0) {
                continue;
            }
            for (const span of subtree) {
                extracted.add(span.spanContext().spanId);
            }
            batches.push(subtree);
        }

        if (extracted.size > 0) {
            const remaining = buffer.filter((span) => !extracted.has(span.spanContext().spanId));
            if (remaining.length > 0) {
                this.buffers.set(traceId, remaining);
            } else {
                this.buffers.delete(traceId);
            }
        }

        if (flushLeftoverWhenIdle && live.size === 0) {
            const leftover = this.buffers.get(traceId);
            if (leftover && leftover.length > 0) {
                this.buffers.delete(traceId);
                batches.push(leftover);
            }
        }

        return batches;
    }

    private async waitForIdle(timeoutMs = 30_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (this.totalLive() > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    private totalLive(): number {
        let n = 0;
        for (const live of this.liveParents.values()) {
            n += live.size;
        }
        return n;
    }

    private applyTransactionAttributes(span: Span, parentContext: Context): void {
        const parentSpanContext = trace.getSpanContext(parentContext);
        const parentTransaction = this.resolveParentTransaction(span.spanContext().traceId, parentContext, parentSpanContext);

        const startsNewTransaction = parentTransaction === undefined
            || parentSpanContext?.isRemote === true
            || span.kind === SpanKind.SERVER
            || span.kind === SpanKind.CONSUMER;

        const existingName = asString(span.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER]);
        let transaction: string;
        if (startsNewTransaction) {
            if (existingName !== undefined && existingName !== parentTransaction) {
                transaction = existingName;
            } else {
                transaction = span.name;
            }
        } else {
            transaction = parentTransaction as string;
        }
        const attributes: Attributes = {
            [CoralogixAttributes.TRANSACTION_IDENTIFIER]: transaction,
        };
        if (startsNewTransaction) {
            attributes[CoralogixAttributes.TRANSACTION_ROOT] = true;
        }
        span.setAttributes(attributes);
        this.transactionsBySpan.set(spanKey(span.spanContext().traceId, span.spanContext().spanId), transaction);
    }

    startNewTransaction(span: Span, name: string): void {
        span.setAttributes({
            [CoralogixAttributes.TRANSACTION_IDENTIFIER]: name,
            [CoralogixAttributes.TRANSACTION_ROOT]: true,
        });
        const {traceId, spanId} = span.spanContext();
        if (isSpanContextValid(span.spanContext())) {
            this.transactionsBySpan.set(spanKey(traceId, spanId), name);
        }
    }

    private resolveParentTransaction(
        traceId: string,
        parentContext: Context,
        parentSpanContext: ReturnType<typeof trace.getSpanContext>,
    ): string | undefined {
        const fromAttrs = asString(
            getAttributesOf(trace.getSpan(parentContext))?.[CoralogixAttributes.TRANSACTION_IDENTIFIER],
        );
        if (fromAttrs !== undefined) {
            return fromAttrs;
        }
        if (parentSpanContext && isSpanContextValid(parentSpanContext) && !parentSpanContext.isRemote) {
            const fromTraceState = parentSpanContext.traceState?.get(CoralogixTraceState.TRANSACTION_IDENTIFIER);
            if (fromTraceState) {
                return fromTraceState;
            }
            return this.transactionsBySpan.get(spanKey(traceId, parentSpanContext.spanId));
        }
        if (parentSpanContext?.isRemote === true) {
            return parentSpanContext.traceState?.get(CoralogixTraceState.TRANSACTION_IDENTIFIER);
        }
        return undefined;
    }

    private clearTransactionsForTrace(traceId: string): void {
        const prefix = `${traceId}:`;
        for (const key of this.transactionsBySpan.keys()) {
            if (key.startsWith(prefix)) {
                this.transactionsBySpan.delete(key);
            }
        }
    }

    private acceptCompleted(spans: ReadableSpan[]): void {
        const intervalSnapshot = new Map<string, Array<{startNs: bigint; endNs: bigint}>>();
        for (const span of spans) {
            const spanId = span.spanContext().spanId;
            const intervals = this.childIntervals.get(spanId);
            if (intervals && intervals.length > 0) {
                intervalSnapshot.set(spanId, intervals.slice());
            }
        }

        try {
            this.stampSelfTimeAndMetrics(spans, intervalSnapshot);

            const rootSpanIds = spans
                .filter((span) => span.attributes[CoralogixAttributes.TRANSACTION_ROOT] === true)
                .map((span) => span.spanContext().spanId);
            const trimmed = selectSlowestSpans(spans, this.maxNodes, rootSpanIds);
            if (trimmed.length === 0) {
                return;
            }

            if (
                this.maxRegularTraces <= 0
                || this.harvestPeriodMillis <= 0
                || this.stopped
                || this.exporterShutdown
            ) {
                this.exportSpans(trimmed);
                return;
            }

            const stubs = this.harvest.witness({
                durationNs: rootDurationNs(trimmed),
                spans: trimmed,
            });
            if (stubs.length > 0) {
                this.exportSpans(stubs);
            }
        } finally {
            for (const span of spans) {
                this.childIntervals.delete(span.spanContext().spanId);
            }
        }
    }

    private stampSelfTimeAndMetrics(
        spans: ReadableSpan[],
        childIntervalSnapshot: Map<string, Array<{startNs: bigint; endNs: bigint}>>,
    ): void {
        const rows: SpanTimingRow[] = [];
        for (const span of spans) {
            const spanId = span.spanContext().spanId;
            const startNs = hrTimeToBigIntNanos(span.startTime);
            const endNs = hrTimeToBigIntNanos(span.endTime);
            rows.push({
                spanId,
                parentSpanId: span.parentSpanContext?.spanId,
                startNs,
                endNs,
            });
            const priorIntervals = childIntervalSnapshot.get(spanId) ?? [];
            for (let index = 0; index < priorIntervals.length; index++) {
                const {startNs: priorStart, endNs: priorEnd} = priorIntervals[index]!;
                const duplicateInBatch = spans.some((other) => {
                    const otherParentId = other.parentSpanContext?.spanId;
                    if (otherParentId !== spanId) {
                        return false;
                    }
                    return hrTimeToBigIntNanos(other.startTime) === priorStart
                        && hrTimeToBigIntNanos(other.endTime) === priorEnd;
                });
                if (duplicateInBatch) {
                    continue;
                }
                rows.push({
                    spanId: `${spanId}:prior:${index}`,
                    parentSpanId: spanId,
                    startNs: priorStart,
                    endNs: priorEnd,
                });
            }
        }
        const selfTimes = selfTimeNsBySpanId(rows);

        for (const span of spans) {
            const selfTimeNs = selfTimes.get(span.spanContext().spanId);
            if (selfTimeNs === undefined) {
                continue;
            }
            const selfTimeSec = Number(selfTimeNs) / 1_000_000_000;
            span.attributes[CoralogixAttributes.SELF_TIME] = selfTimeSec;
            this.recordSelfTimeMetric(span, selfTimeSec);
        }
    }

    private async flushHarvest(): Promise<void> {
        const winners = this.harvest.drain();
        for (const winner of winners) {
            await this.exportSpansAsync(winner.spans);
        }
    }

    private exportSpans(spans: ReadableSpan[]): void {
        void this.exportSpansAsync(spans);
    }

    private async exportSpansAsync(spans: ReadableSpan[]): Promise<void> {
        if (spans.length === 0 || this.exporterShutdown) {
            return;
        }
        await this.runOnExportChain(async () => {
            if (this.exporterShutdown || spans.length === 0) {
                return;
            }
            await new Promise<void>((resolve) => {
                try {
                    this.exporter.export(spans, (result) => {
                        if (result.error) {
                            diag.warn("TransactionSpanProcessor: span export failed", result.error);
                        }
                        resolve();
                    });
                } catch (error) {
                    diag.error("TransactionSpanProcessor failed to export spans", error);
                    resolve();
                }
            });
        });
    }

    private async runOnExportChain<T>(fn: () => T | Promise<T>): Promise<T> {
        let result!: T;
        const run = async (): Promise<void> => {
            result = await fn();
        };
        const pending: Promise<void> = this.exportChain.then(run, run);
        this.exportChain = pending.then(
            () => undefined,
            () => undefined,
        );
        this.pendingExports.add(pending);
        try {
            await pending;
            return result;
        } finally {
            this.pendingExports.delete(pending);
        }
    }

    private async awaitPendingExports(): Promise<void> {
        while (this.pendingExports.size > 0) {
            await Promise.all([...this.pendingExports]);
        }
    }

    private recordSelfTimeMetric(span: ReadableSpan, selfTimeSec: number): void {
        const attributes = span.attributes;
        const metricAttributes: Record<string, string | boolean> = {
            [METRIC_ATTR_SPAN_NAME]: span.name,
        };
        const transaction = attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER];
        if (transaction !== undefined) {
            metricAttributes[CoralogixAttributes.TRANSACTION_IDENTIFIER] = String(transaction);
        }
        if (attributes[CoralogixAttributes.TRANSACTION_ROOT] === true) {
            metricAttributes[CoralogixAttributes.TRANSACTION_ROOT] = true;
        }
        this.selfTimeHistogram.record(selfTimeSec, metricAttributes);
    }
}

const NANOS_PER_SECOND = BigInt(1_000_000_000);

function hrTimeToBigIntNanos(hrTime: readonly [number, number]): bigint {
    return BigInt(hrTime[0]) * NANOS_PER_SECOND + BigInt(hrTime[1]);
}

function getAttributesOf(span: unknown): Attributes | undefined {
    if (!span || typeof span !== "object") {
        return undefined;
    }
    return (span as { attributes?: Attributes }).attributes;
}

function asString(value: AttributeValue | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function spanKey(traceId: string, spanId: string): string {
    return `${traceId}:${spanId}`;
}

function safeEndedSpans(
    spans: ReadableSpan[],
    liveParents: Map<string, string | undefined> | undefined,
): ReadableSpan[] {
    if (!liveParents || liveParents.size === 0) {
        return spans;
    }

    const parentOf = new Map<string, string>();
    for (const span of spans) {
        const parentId = span.parentSpanContext?.spanId;
        if (parentId) {
            parentOf.set(span.spanContext().spanId, parentId);
        }
    }
    for (const [spanId, parentId] of liveParents) {
        if (parentId) {
            parentOf.set(spanId, parentId);
        }
    }

    const blocked = new Set<string>();
    for (const liveId of liveParents.keys()) {
        let cur = parentOf.get(liveId);
        while (cur) {
            if (blocked.has(cur)) {
                break;
            }
            blocked.add(cur);
            cur = parentOf.get(cur);
        }
    }
    return spans.filter((span) => !blocked.has(span.spanContext().spanId));
}

/** Exported for unit tests. */
export {safeEndedSpans as _safeEndedSpansForTests};
