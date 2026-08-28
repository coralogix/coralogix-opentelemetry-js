import {
    Context,
    diag,
    Histogram,
    isSpanContextValid,
    MeterProvider,
    metrics,
    trace,
} from "@opentelemetry/api";
import {ReadableSpan, Span, SpanExporter, SpanProcessor} from "@opentelemetry/sdk-trace-base";
import {CoralogixAttributes, METRIC_SELF_DURATION} from "../common";
import {DEFAULT_SHUTDOWN_IDLE_WAIT_MILLIS, MAX_SELF_DURATION_SPANS} from "./defaults";
import {resolveProcessorOptions} from "./env-options";
import {stampSelfDurationAndMetrics} from "./self-duration-stamp";
import {
    extractCompletedLocalTransactions,
    hasExtractableNestedTransaction,
} from "./transaction-extract";
import {TransactionMembershipTracker} from "./transaction-membership";

const INSTRUMENTATION_SCOPE_NAME = "coralogix.opentelemetry.transaction";

export interface TransactionSpanProcessorOptions {
    /** MeterProvider used to create the self-duration histogram. Defaults to the global MeterProvider. */
    meterProvider?: MeterProvider;
    /**
     * After the last live span in a local trace ends, wait this long before
     * finalizing so fire-and-forget children that start on the same traceId
     * can still join. Default 100. Set to 0 to finalize immediately.
     * Env: `OTEL_CX_TRANSACTION_COMPLETION_HOLDBACK_MILLIS`.
     */
    completionHoldbackMillis?: number;
    /** How long shutdown waits for in-flight spans. Default 30_000. */
    shutdownIdleWaitMillis?: number;
}

export {
    DEFAULT_COMPLETION_HOLDBACK_MILLIS,
} from "./defaults";

/**
 * Tags Coralogix transactions and exports every completed local trace.
 * Self duration and its metrics are stamped only on the first 256 spans in
 * finalized-batch (completion) order.
 *
 * Flow:
 * - **onStart**: track live spans; decide new vs inherit transaction; set
 *   `cgx.transaction.root` for new txns. Does not freeze `cgx.transaction`
 *   from the early span name (Express may rename later).
 * - **onEnd / holdback**: buffer until the local transaction subtree is idle.
 * - **acceptCompleted (export finalize)**: stamp final `cgx.transaction` from
 *   `overrideName ?? rootSpan.name`, then optionally self duration + metrics, export.
 */
export class TransactionSpanProcessor implements SpanProcessor {
    private readonly exporter: SpanExporter;
    private readonly buffers = new Map<string, ReadableSpan[]>();
    /** Traces that crossed 256 ended spans and now bypass transaction processing. */
    private readonly passthroughTraces = new Set<string>();
    private readonly passthroughCleanup = new Map<string, ReturnType<typeof setTimeout>>();
    /** traceId -> (spanId -> parentSpanId) for still-running spans */
    private readonly liveParents = new Map<string, Map<string, string | undefined>>();
    private readonly membership = new TransactionMembershipTracker();
    private readonly selfDurationHistogram: Histogram;
    private readonly completionHoldbackMillis: number;
    private readonly shutdownIdleWaitMillis: number;
    /** traceId -> holdback timer after last live span ended */
    private readonly pendingCompletions = new Map<string, ReturnType<typeof setTimeout>>();
    /** traceId -> holdback timer while outer ancestors are still live but a nested txn completed */
    private readonly pendingNestedCompletions = new Map<string, ReturnType<typeof setTimeout>>();
    /** parentSpanId -> ended direct-child intervals kept for outer self-duration after nested txn export */
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
        const resolved = resolveProcessorOptions(options);
        this.completionHoldbackMillis = resolved.completionHoldbackMillis;
        this.shutdownIdleWaitMillis = options.shutdownIdleWaitMillis ?? DEFAULT_SHUTDOWN_IDLE_WAIT_MILLIS;
        const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(INSTRUMENTATION_SCOPE_NAME);
        this.selfDurationHistogram = meter.createHistogram(METRIC_SELF_DURATION, {
            unit: "s",
            description: "Exclusive (self) wall time per span within a Coralogix transaction",
        });
    }

    /**
     * Start path: track membership (new vs inherit) and live parent map.
     * Transaction display name is finalized at export, not here.
     */
    onStart(span: Span, parentContext: Context): void {
        if (!isSpanContextValid(span.spanContext())) {
            return;
        }

        const {traceId, spanId} = span.spanContext();
        if (!this.passthroughTraces.has(traceId)) try {
            this.membership.trackOnStart(span, parentContext);
        } catch (error) {
            diag.debug(
                "TransactionSpanProcessor: failed to track transaction membership, leaving span untagged",
                error,
            );
        }

        if (this.exporterShutdown) {
            return;
        }

        const parentId = trace.getSpanContext(parentContext)?.spanId;

        this.cancelPassthroughCleanup(traceId);

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

        if (this.passthroughTraces.has(traceId)) {
            this.finishPassthroughSpan(traceId, span, live);
            return;
        }

        const parentId = span.parentSpanContext?.spanId;
        const buffer = this.buffers.get(traceId) ?? [];
        // Only retain intervals for parents we track locally. Remote / external
        // parent IDs are never cleaned by acceptCompleted and would leak.
        if (parentId && this.isLocalParent(parentId, live, buffer)) {
            const intervals = this.childIntervals.get(parentId) ?? [];
            intervals.push({
                startNs: hrTimeToBigIntNanos(span.startTime),
                endNs: hrTimeToBigIntNanos(span.endTime),
            });
            this.childIntervals.set(parentId, intervals);
        }

        buffer.push(span);
        this.buffers.set(traceId, buffer);

        if (live) {
            live.delete(spanId);
            if (live.size === 0) {
                this.liveParents.delete(traceId);
            }
        }

        if (buffer.length > MAX_SELF_DURATION_SPANS) {
            this.enterPassthrough(traceId, buffer);
            return;
        }

        const stillLive = this.liveParents.get(traceId);
        if (stillLive && stillLive.size > 0) {
            // Nested local txn finished while an outer ancestor is still live:
            // apply the same completion holdback so fire-and-forget children
            // started from that nested root can join the batch.
            this.scheduleNestedCompletion(traceId);
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

    /** Explicit API: force this span to be a transaction root with a fixed name. */
    startNewTransaction(span: Span, name: string): void {
        this.membership.startNewTransaction(span, name);
    }

    private async doShutdown(): Promise<void> {
        this.stopped = true;
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
                this.membership.clearTrace(traceId);
                continue;
            }
            const batches = this.extractCompleted(traceId, true);
            for (const batch of batches) {
                this.acceptCompleted(batch);
            }
            this.membership.clearTrace(traceId);
        }
        this.buffers.clear();
        this.liveParents.clear();
        this.passthroughTraces.clear();
        await this.awaitPendingExports();
        this.exporterShutdown = true;
        this.membership.clear();
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

    private cancelPendingNestedCompletion(traceId: string): void {
        const timer = this.pendingNestedCompletions.get(traceId);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.pendingNestedCompletions.delete(traceId);
        }
    }

    private cancelPassthroughCleanup(traceId: string): void {
        const timer = this.passthroughCleanup.get(traceId);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.passthroughCleanup.delete(traceId);
        }
    }

    private enterPassthrough(traceId: string, spans: ReadableSpan[]): void {
        this.cancelPendingCompletion(traceId);
        this.cancelPendingNestedCompletion(traceId);
        this.passthroughTraces.add(traceId);
        this.buffers.delete(traceId);
        this.membership.clearTrace(traceId);
        this.clearTransactionTags(spans);
        this.exportSpans(spans);
        for (const span of spans) this.childIntervals.delete(span.spanContext().spanId);
        if (!this.liveParents.has(traceId)) this.schedulePassthroughCleanup(traceId);
    }

    private finishPassthroughSpan(
        traceId: string,
        span: ReadableSpan,
        live: Map<string, string | undefined> | undefined,
    ): void {
        if (live) {
            live.delete(span.spanContext().spanId);
            if (live.size === 0) this.liveParents.delete(traceId);
        }
        this.clearTransactionTags([span]);
        this.exportSpans([span]);
        if (!this.liveParents.has(traceId)) this.schedulePassthroughCleanup(traceId);
    }

    private schedulePassthroughCleanup(traceId: string): void {
        this.cancelPassthroughCleanup(traceId);
        const cleanup = () => {
            this.passthroughCleanup.delete(traceId);
            if (!this.liveParents.has(traceId)) this.passthroughTraces.delete(traceId);
        };
        if (this.completionHoldbackMillis <= 0) {
            cleanup();
            return;
        }
        this.passthroughCleanup.set(traceId, setTimeout(cleanup, this.completionHoldbackMillis));
    }

    private isLocalParent(
        parentId: string,
        live: Map<string, string | undefined> | undefined,
        buffer: ReadableSpan[],
    ): boolean {
        if (live?.has(parentId)) {
            return true;
        }
        return buffer.some((s) => s.spanContext().spanId === parentId);
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

    private scheduleNestedCompletion(traceId: string): void {
        const buffer = this.buffers.get(traceId) ?? [];
        const live = this.liveParents.get(traceId) ?? new Map<string, string | undefined>();
        if (!hasExtractableNestedTransaction(buffer, live)) {
            this.cancelPendingNestedCompletion(traceId);
            return;
        }
        if (this.pendingNestedCompletions.has(traceId)) {
            // Already armed; do not reset on unrelated outer activity.
            return;
        }
        if (this.exporterShutdown) {
            return;
        }
        if (this.completionHoldbackMillis <= 0) {
            this.finalizeNestedCompleted(traceId);
            return;
        }
        const timer = setTimeout(() => {
            if (this.exporterShutdown) {
                return;
            }
            if (this.pendingNestedCompletions.get(traceId) !== timer) {
                return;
            }
            this.pendingNestedCompletions.delete(traceId);
            this.finalizeNestedCompleted(traceId);
            // Timer may have fired while a late child was still live under the nested
            // root; re-arm once that subtree is idle again.
            const buf = this.buffers.get(traceId) ?? [];
            const liveAfter = this.liveParents.get(traceId) ?? new Map<string, string | undefined>();
            if (hasExtractableNestedTransaction(buf, liveAfter)) {
                this.scheduleNestedCompletion(traceId);
            }
        }, this.completionHoldbackMillis);
        this.pendingNestedCompletions.set(traceId, timer);
    }

    private finalizeNestedCompleted(traceId: string): void {
        if (this.exporterShutdown) {
            return;
        }
        const live = this.liveParents.get(traceId);
        if (!live || live.size === 0) {
            // Whole trace idle — let the normal idle path own finalization.
            return;
        }
        const batches = this.extractCompleted(traceId);
        for (const batch of batches) {
            this.acceptCompleted(batch);
        }
    }

    private flushPendingCompletions(): void {
        for (const traceId of [...this.pendingCompletions.keys()]) {
            this.cancelPendingCompletion(traceId);
        }
        for (const traceId of [...this.pendingNestedCompletions.keys()]) {
            this.cancelPendingNestedCompletion(traceId);
        }
        for (const traceId of [...this.buffers.keys()]) {
            const live = this.liveParents.get(traceId);
            if (live && live.size > 0) {
                this.finalizeNestedCompleted(traceId);
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
        const batches = this.extractCompleted(traceId, true);
        for (const batch of batches) {
            this.acceptCompleted(batch);
        }
        this.liveParents.delete(traceId);
        this.membership.clearTrace(traceId);
    }

    private extractCompleted(traceId: string, flushLeftoverWhenIdle = false): ReadableSpan[][] {
        const buffer = this.buffers.get(traceId);
        if (!buffer || buffer.length === 0) {
            return [];
        }
        const live = this.liveParents.get(traceId) ?? new Map<string, string | undefined>();
        const {batches, remaining} = extractCompletedLocalTransactions(
            buffer,
            live,
            flushLeftoverWhenIdle,
        );
        if (remaining.length > 0) {
            this.buffers.set(traceId, remaining);
        } else {
            this.buffers.delete(traceId);
        }
        return batches;
    }

    private async waitForIdle(timeoutMs = DEFAULT_SHUTDOWN_IDLE_WAIT_MILLIS): Promise<void> {
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

    /**
     * Export finalize for one completed local transaction batch:
     * 1) enrich batches up to 256 spans with transaction names and self duration
     * 2) export every span; larger batches remain untouched
     */
    private acceptCompleted(spans: ReadableSpan[]): void {
        try {
            if (spans.length > MAX_SELF_DURATION_SPANS) {
                this.clearTransactionTags(spans);
                this.exportSpans(spans);
                return;
            }
            this.membership.finalizeBatchNames(spans);
            if (spans.length > 0) {
                const intervalSnapshot = new Map<string, Array<{startNs: bigint; endNs: bigint}>>();
                for (const span of spans) {
                    const spanId = span.spanContext().spanId;
                    const intervals = this.childIntervals.get(spanId);
                    if (intervals && intervals.length > 0) {
                        intervalSnapshot.set(spanId, intervals.slice());
                    }
                }
                stampSelfDurationAndMetrics(spans, intervalSnapshot, this.selfDurationHistogram);
            }
            this.exportSpans(spans);
        } finally {
            for (const span of spans) {
                this.childIntervals.delete(span.spanContext().spanId);
            }
        }
    }

    private clearTransactionTags(spans: ReadableSpan[]): void {
        for (const span of spans) {
            delete span.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER];
            delete span.attributes[CoralogixAttributes.TRANSACTION_ROOT];
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
}

const NANOS_PER_SECOND = BigInt(1_000_000_000);

function hrTimeToBigIntNanos(hrTime: readonly [number, number]): bigint {
    return BigInt(hrTime[0]) * NANOS_PER_SECOND + BigInt(hrTime[1]);
}
