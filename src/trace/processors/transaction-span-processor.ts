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
import {CoralogixAttributes} from "../common";
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
    /** Harvest flush interval in milliseconds. Default 60_000. */
    harvestPeriodMillis?: number;
}

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
    private readonly selfTimeHistogram: Histogram;
    private readonly maxNodes: number;
    private readonly maxRegularTraces: number;
    private readonly harvest: RegularTraceHeap;
    private readonly harvestPeriodMillis: number;
    private harvestTimer: ReturnType<typeof setInterval> | undefined;
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
        if (this.stopped || !isSpanContextValid(span.spanContext())) {
            return;
        }
        const {traceId, spanId} = span.spanContext();
        const parentId = trace.getSpanContext(parentContext)?.spanId;
        const live = this.liveParents.get(traceId) ?? new Map<string, string | undefined>();
        live.set(spanId, parentId);
        this.liveParents.set(traceId, live);

        try {
            this.applyTransactionAttributes(span, parentContext);
        } catch (error) {
            diag.debug("TransactionSpanProcessor: failed to resolve transaction attributes, leaving span untagged", error);
        }
    }

    onEnd(span: ReadableSpan): void {
        if (this.exporterShutdown || !isSpanContextValid(span.spanContext())) {
            return;
        }
        const {traceId, spanId} = span.spanContext();
        const live = this.liveParents.get(traceId);
        if (!live && this.stopped) {
            return;
        }

        const buffer = this.buffers.get(traceId) ?? [];
        buffer.push(span);
        this.buffers.set(traceId, buffer);

        if (live) {
            live.delete(spanId);
            if (live.size === 0) {
                this.liveParents.delete(traceId);
                this.buffers.delete(traceId);
                this.acceptCompleted(buffer);
            }
        } else {
            this.buffers.delete(traceId);
            this.acceptCompleted(buffer);
        }
    }

    async forceFlush(): Promise<void> {
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
        await this.waitForIdle();

        const pending = Array.from(this.buffers.entries());
        this.buffers.clear();
        const liveSnapshot = new Map(this.liveParents);
        this.liveParents.clear();

        for (const [traceId, spans] of pending) {
            const safe = safeEndedSpans(spans, liveSnapshot.get(traceId));
            if (safe.length > 0) {
                this.acceptCompleted(safe);
            }
        }
        await this.flushHarvest();
        await this.awaitPendingExports();
        this.exporterShutdown = true;
        await this.exporter.shutdown();
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
        const parentTransaction = asString(
            getAttributesOf(trace.getSpan(parentContext))?.[CoralogixAttributes.TRANSACTION_IDENTIFIER],
        );

        const startsNewTransaction = parentTransaction === undefined
            || parentSpanContext?.isRemote === true
            || span.kind === SpanKind.SERVER
            || span.kind === SpanKind.CONSUMER;

        const attributes: Attributes = {
            [CoralogixAttributes.TRANSACTION_IDENTIFIER]: startsNewTransaction ? span.name : parentTransaction,
        };
        if (startsNewTransaction) {
            attributes[CoralogixAttributes.TRANSACTION_ROOT] = true;
        }
        span.setAttributes(attributes);
    }

    /**
     * Stamp self-time + metric on the full tree, trim to maxNodes, then harvest
     * or export immediately when maxRegularTraces is 0.
     */
    private acceptCompleted(spans: ReadableSpan[]): void {
        this.stampSelfTimeAndMetrics(spans);

        const rootSpanId = spans.find(
            (span) => span.attributes[CoralogixAttributes.TRANSACTION_ROOT] === true,
        )?.spanContext().spanId;
        const trimmed = selectSlowestSpans(spans, this.maxNodes, rootSpanId);
        if (trimmed.length === 0) {
            return;
        }

        if (this.maxRegularTraces <= 0) {
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

function safeEndedSpans(
    spans: ReadableSpan[],
    liveParents: Map<string, string | undefined> | undefined,
): ReadableSpan[] {
    if (!liveParents || liveParents.size === 0) {
        return spans;
    }
    const blocked = new Set<string>();
    for (const parentId of liveParents.values()) {
        if (parentId) {
            blocked.add(parentId);
        }
    }
    return spans.filter((span) => !blocked.has(span.spanContext().spanId));
}
