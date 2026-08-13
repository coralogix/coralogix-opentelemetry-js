/**
 * Longest-duration node trim for transaction traces.
 * Keep at most `maxNodes` spans, preferring longer durations. Every
 * transaction root is always retained. Dropped parents are re-linked to the
 * nearest kept ancestor.
 *
 * Candidate selection uses a min-heap by duration: head = shortest / easiest
 * to displace when keeping the slowest N non-root spans.
 */

import {isSpanContextValid, SpanContext} from "@opentelemetry/api";
import {ReadableSpan} from "@opentelemetry/sdk-trace-base";
import {DEFAULT_MAX_TXN_TRACE_NODES} from "./defaults";
import {bubbleDown, bubbleUp} from "./min-heap";
import {ReparentedReadableSpan} from "./reparented-readable-span";

export {DEFAULT_MAX_TXN_TRACE_NODES} from "./defaults";

const ZERO = BigInt(0);

export function spanDurationNs(span: ReadableSpan): bigint {
    const start = hrTimeToBigIntNanos(span.startTime);
    const end = hrTimeToBigIntNanos(span.endTime);
    return end > start ? end - start : ZERO;
}

export function selectSlowestSpans(
    spans: ReadableSpan[],
    maxNodes: number = DEFAULT_MAX_TXN_TRACE_NODES,
    rootSpanIds: readonly string[] = [],
): ReadableSpan[] {
    if (maxNodes <= 0 || spans.length <= maxNodes) {
        return spans.slice();
    }

    const protect = new Set(rootSpanIds);

    const roots: ReadableSpan[] = [];
    const others: ReadableSpan[] = [];
    for (const span of spans) {
        if (protect.has(span.spanContext().spanId)) {
            roots.push(span);
        } else {
            others.push(span);
        }
    }

    const slots = Math.max(0, maxNodes - roots.length);
    if (slots === 0) {
        const keptIds = new Set(roots.map((span) => span.spanContext().spanId));
        const ordered = spans.filter((span) => keptIds.has(span.spanContext().spanId));
        return reparentToKeptAncestors(ordered, spans);
    }

    type HeapItem = {duration: bigint; index: number; span: ReadableSpan};
    const heap: HeapItem[] = [];

    const less = (a: HeapItem, b: HeapItem): boolean => {
        if (a.duration !== b.duration) {
            return a.duration < b.duration;
        }
        return a.index < b.index;
    };

    for (let index = 0; index < others.length; index++) {
        const span = others[index]!;
        const duration = spanDurationNs(span);
        const item: HeapItem = {duration, index, span};
        if (heap.length < slots) {
            heap.push(item);
            bubbleUp(heap, heap.length - 1, less);
            continue;
        }
        const head = heap[0];
        if (head !== undefined && duration > head.duration) {
            heap[0] = item;
            bubbleDown(heap, 0, less);
        }
    }

    const kept = heap.map((item) => item.span);
    kept.push(...roots);

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
            // Parent is outside this local batch (e.g. remote). Preserve it.
            return parent;
        }
        parent = ancestor.parentSpanContext;
    }
    return undefined;
}

const NANOS_PER_SECOND = BigInt(1_000_000_000);

function hrTimeToBigIntNanos(hrTime: readonly [number, number]): bigint {
    return BigInt(hrTime[0]) * NANOS_PER_SECOND + BigInt(hrTime[1]);
}
