import {
    AttributeValue,
    Attributes,
    Context,
    isSpanContextValid,
    SpanKind,
    trace,
} from "@opentelemetry/api";
import {ReadableSpan, Span} from "@opentelemetry/sdk-trace-base";
import {CoralogixAttributes, CoralogixTraceState} from "../common";

/**
 * Per-span transaction membership tracked at start; final `cgx.transaction`
 * name is stamped only at export finalize (after Express-style rename).
 */
export interface SpanMembership {
    rootSpanId: string;
    isRoot: boolean;
    /** Sampler / startNewTransaction / user override; wins over root span.name. */
    overrideName?: string;
    /**
     * Concrete name when inheriting from TraceState / remote attrs without a
     * locally tracked transaction root in this process.
     */
    inheritedName?: string;
}

/**
 * Start-time tracking for Coralogix transactions.
 *
 * onStart: decide new vs inherit, set `cgx.transaction.root` for new txns,
 * record membership. Do NOT freeze `cgx.transaction` from the early span name
 * (Express middleware may `updateName` later).
 *
 * export finalize: resolve `overrideName ?? rootSpan.name` and stamp
 * `cgx.transaction` on every span in the completed batch.
 */
export class TransactionMembershipTracker {
    private readonly bySpan = new Map<string, SpanMembership>();

    get(traceId: string, spanId: string): SpanMembership | undefined {
        return this.bySpan.get(spanKey(traceId, spanId));
    }

    clearTrace(traceId: string): void {
        const prefix = `${traceId}:`;
        for (const key of this.bySpan.keys()) {
            if (key.startsWith(prefix)) {
                this.bySpan.delete(key);
            }
        }
    }

    clear(): void {
        this.bySpan.clear();
    }

    /**
     * Decide new vs inherit and record membership. Sets `cgx.transaction.root`
     * for new transactions only. Leaves `cgx.transaction` unset unless the
     * sampler/user already set it (stored as overrideName).
     */
    trackOnStart(span: Span, parentContext: Context): void {
        const {traceId, spanId} = span.spanContext();
        if (!isSpanContextValid(span.spanContext())) {
            return;
        }

        const parentSpanContext = trace.getSpanContext(parentContext);
        const parentInfo = this.resolveParentInfo(traceId, parentContext, parentSpanContext);

        const startsNewTransaction = !parentInfo.hasTransaction
            || parentSpanContext?.isRemote === true
            || span.kind === SpanKind.SERVER
            || span.kind === SpanKind.CONSUMER;

        const existingName = asString(span.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER]);

        if (startsNewTransaction) {
            let overrideName: string | undefined;
            if (
                existingName !== undefined
                && existingName !== parentInfo.name
            ) {
                overrideName = existingName;
            }
            this.bySpan.set(spanKey(traceId, spanId), {
                rootSpanId: spanId,
                isRoot: true,
                overrideName,
            });
            span.setAttribute(CoralogixAttributes.TRANSACTION_ROOT, true);
            // Do not set cgx.transaction from span.name — finalize stamps it.
            return;
        }

        // Inherit: join parent's transaction. Name comes from root at finalize
        // (or inheritedName when there is no local root membership).
        const rootSpanId = parentInfo.rootSpanId ?? parentSpanContext?.spanId ?? spanId;
        const membership: SpanMembership = {
            rootSpanId,
            isRoot: false,
        };
        if (parentInfo.name !== undefined && parentInfo.rootSpanId === undefined) {
            membership.inheritedName = parentInfo.name;
        }
        this.bySpan.set(spanKey(traceId, spanId), membership);
    }

    /** Explicit API: force this span to be a transaction root with a fixed name. */
    startNewTransaction(span: Span, name: string): void {
        const {traceId, spanId} = span.spanContext();
        span.setAttributes({
            [CoralogixAttributes.TRANSACTION_IDENTIFIER]: name,
            [CoralogixAttributes.TRANSACTION_ROOT]: true,
        });
        if (!isSpanContextValid(span.spanContext())) {
            return;
        }
        this.bySpan.set(spanKey(traceId, spanId), {
            rootSpanId: spanId,
            isRoot: true,
            overrideName: name,
        });
    }

    /**
     * Stamp final `cgx.transaction` on every span in a completed local batch.
     * Root name = overrideName ?? rootSpan.name. Ensures root has
     * `cgx.transaction.root`.
     */
    finalizeBatchNames(spans: ReadableSpan[]): void {
        if (spans.length === 0) {
            return;
        }
        const traceId = spans[0]!.spanContext().traceId;
        const name = this.resolveBatchTransactionName(spans, traceId);
        for (const span of spans) {
            const spanId = span.spanContext().spanId;
            const membership = this.bySpan.get(spanKey(traceId, spanId));
            span.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER] = name;
            if (
                membership?.isRoot === true
                || span.attributes[CoralogixAttributes.TRANSACTION_ROOT] === true
            ) {
                span.attributes[CoralogixAttributes.TRANSACTION_ROOT] = true;
            }
        }
    }

    private resolveBatchTransactionName(spans: ReadableSpan[], traceId: string): string {
        const root = spans.find(
            (span) => span.attributes[CoralogixAttributes.TRANSACTION_ROOT] === true,
        );
        if (root) {
            const membership = this.bySpan.get(spanKey(traceId, root.spanContext().spanId));
            return membership?.overrideName ?? root.name;
        }

        for (const span of spans) {
            const membership = this.bySpan.get(spanKey(traceId, span.spanContext().spanId));
            if (membership?.overrideName) {
                return membership.overrideName;
            }
            if (membership?.inheritedName) {
                return membership.inheritedName;
            }
        }
        return spans[0]!.name;
    }

    private resolveParentInfo(
        traceId: string,
        parentContext: Context,
        parentSpanContext: ReturnType<typeof trace.getSpanContext>,
    ): {hasTransaction: boolean; name?: string; rootSpanId?: string} {
        const fromAttrs = asString(
            getAttributesOf(trace.getSpan(parentContext))?.[CoralogixAttributes.TRANSACTION_IDENTIFIER],
        );
        if (fromAttrs !== undefined) {
            const parentId = parentSpanContext?.spanId;
            const membership = parentId
                ? this.bySpan.get(spanKey(traceId, parentId))
                : undefined;
            return {
                hasTransaction: true,
                name: fromAttrs,
                rootSpanId: membership?.rootSpanId,
            };
        }

        if (parentSpanContext && isSpanContextValid(parentSpanContext) && !parentSpanContext.isRemote) {
            const membership = this.bySpan.get(spanKey(traceId, parentSpanContext.spanId));
            if (membership) {
                return {
                    hasTransaction: true,
                    name: membership.overrideName ?? membership.inheritedName,
                    rootSpanId: membership.rootSpanId,
                };
            }
            const fromTraceState = parentSpanContext.traceState?.get(
                CoralogixTraceState.TRANSACTION_IDENTIFIER,
            );
            if (fromTraceState) {
                return {hasTransaction: true, name: fromTraceState};
            }
            // Parent is local but not yet tagged as a transaction member.
            return {hasTransaction: false};
        }

        if (parentSpanContext?.isRemote === true) {
            const fromTraceState = parentSpanContext.traceState?.get(
                CoralogixTraceState.TRANSACTION_IDENTIFIER,
            );
            if (fromTraceState) {
                return {hasTransaction: true, name: fromTraceState};
            }
        }

        return {hasTransaction: false};
    }
}

function getAttributesOf(span: unknown): Attributes | undefined {
    if (!span || typeof span !== "object") {
        return undefined;
    }
    return (span as {attributes?: Attributes}).attributes;
}

function asString(value: AttributeValue | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function spanKey(traceId: string, spanId: string): string {
    return `${traceId}:${spanId}`;
}
