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

/** Default holdback after the last live span ends before finalizing a local trace. */
export const DEFAULT_COMPLETION_HOLDBACK_MILLIS = 100;

/**
 * Tags Coralogix transactions on start, stamps exclusive self-time on end,
 * records the {@link CoralogixAttributes.SELF_TIME} histogram, trims to the
 * slowest nodes, and harvests the slowest completed local trace(s) per window.
 */
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
    /** In-flight exporter.export promises; forceFlush/shutdown wait for these. */
    private readonly pendingExports = new Set<Promise<void>>();
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
            // Do not keep the process alive solely for harvest.
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

        // A new span on this traceId cancels an in-flight completion holdback
        // (fire-and-forget child starting after the parent ended).
        this.cancelPendingCompletion(traceId);

        // After shutdown begins, do not open new local traces — but still
        // register children of already-tracked traces so onEnd cannot finalize
        // a parent while a post-shutdown child is still running.
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

        const buffer = this.buffers.get(traceId) ?? [];
        buffer.push(span);
        this.buffers.set(traceId, buffer);

        if (live) {
            live.delete(spanId);
            if (live.size === 0) {
                this.liveParents.delete(traceId);
                this.scheduleCompletion(traceId);
            }
        } else if (!this.liveParents.has(traceId)) {
            // No live tracking (missed onStart); finalize via holdback/immediate.
            this.scheduleCompletion(traceId);
        }
    }

    async forceFlush(): Promise<void> {
        this.flushPendingCompletions();
        await this.flushHarvest();
        await this.awaitPendingExports();
        if (this.exporter.forceFlush) {
            await this.exporter.forceFlush();
        }
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

        // Finalize traces whose last live span already ended (holdback pending).
        this.flushPendingCompletions();

        const pending = Array.from(this.buffers.entries());
        this.buffers.clear();
        const liveSnapshot = new Map(this.liveParents);
        this.liveParents.clear();

        for (const [traceId, spans] of pending) {
            const live = liveSnapshot.get(traceId);
            // Finalize only when every tracked span in the local trace ended.
            if (live && live.size > 0) {
                this.clearTransactionsForTrace(traceId);
                continue;
            }
            if (spans.length > 0) {
                this.acceptCompleted(spans);
            }
            this.clearTransactionsForTrace(traceId);
        }
        await this.flushHarvest();
        await this.awaitPendingExports();
        this.exporterShutdown = true;
        this.transactionsBySpan.clear();
        await this.exporter.shutdown();
    }

    private cancelPendingCompletion(traceId: string): void {
        const timer = this.pendingCompletions.get(traceId);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.pendingCompletions.delete(traceId);
        }
    }

    /**
     * After the last live span ends, wait briefly so a same-traceId child that
     * starts afterward (fire-and-forget) can still join this local trace.
     */
    private scheduleCompletion(traceId: string): void {
        this.cancelPendingCompletion(traceId);
        if (this.completionHoldbackMillis <= 0) {
            this.finalizeTraceIfIdle(traceId);
            return;
        }
        const timer = setTimeout(() => {
            this.pendingCompletions.delete(traceId);
            this.finalizeTraceIfIdle(traceId);
        }, this.completionHoldbackMillis);
        if (typeof timer.unref === "function") {
            timer.unref();
        }
        this.pendingCompletions.set(traceId, timer);
    }

    private flushPendingCompletions(): void {
        const traceIds = [...this.pendingCompletions.keys()];
        for (const traceId of traceIds) {
            this.cancelPendingCompletion(traceId);
            this.finalizeTraceIfIdle(traceId);
        }
    }

    private finalizeTraceIfIdle(traceId: string): void {
        const live = this.liveParents.get(traceId);
        if (live && live.size > 0) {
            return;
        }
        const buffer = this.buffers.get(traceId);
        if (!buffer || buffer.length === 0) {
            return;
        }
        this.buffers.delete(traceId);
        this.liveParents.delete(traceId);
        this.clearTransactionsForTrace(traceId);
        this.acceptCompleted(buffer);
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

        // Prefer a name already on the span (e.g. sampler Express template)
        // over span.name so processor + sampler can be stacked safely.
        const existingName = asString(span.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER]);
        const transaction = startsNewTransaction
            ? (existingName ?? span.name)
            : (parentTransaction as string);
        const attributes: Attributes = {
            [CoralogixAttributes.TRANSACTION_IDENTIFIER]: transaction,
        };
        if (startsNewTransaction) {
            attributes[CoralogixAttributes.TRANSACTION_ROOT] = true;
        }
        span.setAttributes(attributes);
        this.transactionsBySpan.set(spanKey(span.spanContext().traceId, span.spanContext().spanId), transaction);
    }

    /**
     * Resolve the parent's local transaction name from (in order): live parent
     * span attributes, parent TraceState (non-recording / sampler path), then
     * this processor's side table for spans we already tagged.
     */
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

    /**
     * Stamp self-time + metric on the full tree, trim to maxNodes, then harvest
     * or export immediately when maxRegularTraces is 0 or harvestPeriodMillis <= 0.
     */
    private acceptCompleted(spans: ReadableSpan[]): void {
        this.stampSelfTimeAndMetrics(spans);

        const rootSpanIds = spans
            .filter((span) => span.attributes[CoralogixAttributes.TRANSACTION_ROOT] === true)
            .map((span) => span.spanContext().spanId);
        const trimmed = selectSlowestSpans(spans, this.maxNodes, rootSpanIds);
        if (trimmed.length === 0) {
            return;
        }

        // No harvest capacity, or no period (timer never scheduled): export now
        // so traces cannot sit forever in the heap and be dropped on exit.
        if (this.maxRegularTraces <= 0 || this.harvestPeriodMillis <= 0) {
            this.exportSpans(trimmed);
            return;
        }

        this.harvest.witness({
            durationNs: rootDurationNs(trimmed),
            spans: trimmed,
        });
    }

    private stampSelfTimeAndMetrics(spans: ReadableSpan[]): void {
        const rows: SpanTimingRow[] = spans.map((span) => ({
            spanId: span.spanContext().spanId,
            parentSpanId: span.parentSpanContext?.spanId,
            startNs: hrTimeToBigIntNanos(span.startTime),
            endNs: hrTimeToBigIntNanos(span.endTime),
        }));
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
        await Promise.all(winners.map(async (winner) => this.exportSpansAsync(winner.spans)));
    }

    private exportSpans(spans: ReadableSpan[]): void {
        void this.exportSpansAsync(spans);
    }

    private async exportSpansAsync(spans: ReadableSpan[]): Promise<void> {
        if (spans.length === 0 || this.exporterShutdown) {
            return;
        }
        const pending = new Promise<void>((resolve) => {
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
        this.pendingExports.add(pending);
        try {
            await pending;
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
