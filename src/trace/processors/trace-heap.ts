/**
 * Longest-duration node trim for transaction traces.
 * Keep at most `maxNodes` spans, preferring longer durations. The transaction
 * root is always retained. Dropped parents are re-linked to the nearest kept
 * ancestor.
 */

import {isSpanContextValid, SpanContext} from "@opentelemetry/api";
import {ReadableSpan} from "@opentelemetry/sdk-trace-base";

/** Default max spans kept in one local transaction waterfall. */
export const DEFAULT_MAX_TXN_TRACE_NODES = 256;

const ZERO = BigInt(0);

export function spanDurationNs(span: ReadableSpan): bigint {
    const start = hrTimeToBigIntNanos(span.startTime);
    const end = hrTimeToBigIntNanos(span.endTime);
    return end > start ? end - start : ZERO;
}

export function selectSlowestSpans(
    spans: ReadableSpan[],
    maxNodes: number = DEFAULT_MAX_TXN_TRACE_NODES,
    rootSpanId?: string,
): ReadableSpan[] {
    if (maxNodes <= 0 || spans.length <= maxNodes) {
        return spans.slice();
    }

    let root: ReadableSpan | undefined;
    const others: ReadableSpan[] = [];
    for (const span of spans) {
        if (rootSpanId !== undefined && span.spanContext().spanId === rootSpanId) {
            root = span;
        } else {
            others.push(span);
        }
    }

    const slots = root === undefined ? maxNodes : maxNodes - 1;
    if (slots <= 0) {
        return root !== undefined ? [root] : [];
    }

    type HeapItem = {duration: bigint; index: number; span: ReadableSpan};
    const heap: HeapItem[] = [];

    const less = (a: HeapItem, b: HeapItem): boolean => {
        if (a.duration !== b.duration) {
            return a.duration < b.duration;
        }
        return a.index < b.index;
    };
    const siftUp = (i: number): void => {
        let cur = i;
        while (cur > 0) {
            const p = (cur - 1) >> 1;
            const child = heap[cur];
            const parent = heap[p];
            if (child === undefined || parent === undefined || !less(child, parent)) {
                break;
            }
            heap[cur] = parent;
            heap[p] = child;
            cur = p;
        }
    };
    const siftDown = (i: number): void => {
        let cur = i;
        for (;;) {
            let smallest = cur;
            const l = cur * 2 + 1;
            const r = l + 1;
            const curItem = heap[cur];
            const left = heap[l];
            const right = heap[r];
            if (left !== undefined && curItem !== undefined && less(left, heap[smallest]!)) {
                smallest = l;
            }
            if (right !== undefined && less(right, heap[smallest]!)) {
                smallest = r;
            }
            if (smallest === cur) {
                break;
            }
            const a = heap[cur]!;
            const b = heap[smallest]!;
            heap[cur] = b;
            heap[smallest] = a;
            cur = smallest;
        }
    };

    for (let index = 0; index < others.length; index++) {
        const span = others[index]!;
        const duration = spanDurationNs(span);
        const item: HeapItem = {duration, index, span};
        if (heap.length < slots) {
            heap.push(item);
            siftUp(heap.length - 1);
            continue;
        }
        const head = heap[0];
        if (head !== undefined && duration > head.duration) {
            heap[0] = item;
            siftDown(0);
        }
    }

    const kept = heap.map((item) => item.span);
    if (root !== undefined) {
        kept.push(root);
    }

    const keptIds = new Set(kept.map((span) => span.spanContext().spanId));
    const ordered = spans.filter((span) => keptIds.has(span.spanContext().spanId));
    return reparentToKeptAncestors(ordered, spans);
}

export function reparentToKeptAncestors(
    kept: ReadableSpan[],
    allSpans: ReadableSpan[],
): ReadableSpan[] {
    const byId = new Map<string, ReadableSpan>();
    for (const span of allSpans) {
        byId.set(span.spanContext().spanId, span);
    }
    const keptIds = new Set(kept.map((span) => span.spanContext().spanId));

    return kept.map((span) => {
        const newParent = nearestKeptParent(span, byId, keptIds);
        const currentParentId = span.parentSpanContext?.spanId;
        const newParentId = newParent?.spanId;
        if (currentParentId === newParentId) {
            return span;
        }
        return new ReparentedReadableSpan(span, newParent);
    });
}

function nearestKeptParent(
    span: ReadableSpan,
    byId: Map<string, ReadableSpan>,
    keptIds: Set<string>,
): SpanContext | undefined {
    let parent = span.parentSpanContext;
    while (parent && isSpanContextValid(parent)) {
        if (keptIds.has(parent.spanId)) {
            const keptParent = byId.get(parent.spanId);
            return keptParent !== undefined ? keptParent.spanContext() : parent;
        }
        const ancestor = byId.get(parent.spanId);
        if (ancestor === undefined) {
            break;
        }
        parent = ancestor.parentSpanContext;
    }
    return undefined;
}

/** Thin wrapper that overrides parentSpanContext after node trim. */
class ReparentedReadableSpan implements ReadableSpan {
    constructor(
        private readonly inner: ReadableSpan,
        private readonly overriddenParent: SpanContext | undefined,
    ) {}

    get name(): string {
        return this.inner.name;
    }

    get kind() {
        return this.inner.kind;
    }

    spanContext() {
        return this.inner.spanContext();
    }

    get parentSpanContext(): SpanContext | undefined {
        return this.overriddenParent;
    }

    get startTime() {
        return this.inner.startTime;
    }

    get endTime() {
        return this.inner.endTime;
    }

    get status() {
        return this.inner.status;
    }

    get attributes() {
        return this.inner.attributes;
    }

    get links() {
        return this.inner.links;
    }

    get events() {
        return this.inner.events;
    }

    get duration() {
        return this.inner.duration;
    }

    get ended() {
        return this.inner.ended;
    }

    get resource() {
        return this.inner.resource;
    }

    get instrumentationScope() {
        return this.inner.instrumentationScope;
    }

    get droppedAttributesCount() {
        return this.inner.droppedAttributesCount;
    }

    get droppedEventsCount() {
        return this.inner.droppedEventsCount;
    }

    get droppedLinksCount() {
        return this.inner.droppedLinksCount;
    }
}

const NANOS_PER_SECOND = BigInt(1_000_000_000);

function hrTimeToBigIntNanos(hrTime: readonly [number, number]): bigint {
    return BigInt(hrTime[0]) * NANOS_PER_SECOND + BigInt(hrTime[1]);
}
