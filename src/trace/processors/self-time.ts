// Exclusive (self) wall-clock time for spans.
//
// Self-time is a span's own duration minus the time covered by its direct children (clamped to
// the parent's own interval, and merged so overlapping/concurrent children aren't double
// counted). Nanosecond math is done in `bigint` because absolute epoch nanoseconds overflow
// `Number.MAX_SAFE_INTEGER`; only the (small) resulting durations are ever converted back to
// `number`.

export interface SpanTimingRow {
    spanId: string;
    // Empty string (or absent) marks a span with no locally-known parent, i.e. a root of the
    // local subtree being analyzed (either an actual trace root, or the entry point of a
    // distributed trace segment whose remote parent isn't part of this batch).
    parentSpanId?: string;
    startNs: bigint;
    endNs: bigint;
}

interface SpanNode extends SpanTimingRow {
    children: SpanNode[];
}

export function selfTimeNsBySpanId(rows: SpanTimingRow[]): Map<string, bigint> {
    const byId = new Map<string, SpanNode>();
    for (const row of rows) {
        if (!byId.has(row.spanId)) {
            byId.set(row.spanId, {...row, children: []});
        }
    }
    for (const node of byId.values()) {
        const parent = node.parentSpanId ? byId.get(node.parentSpanId) : undefined;
        if (parent) {
            parent.children.push(node);
        }
    }
    const result = new Map<string, bigint>();
    for (const [spanId, node] of byId) {
        result.set(spanId, selfTime(node));
    }
    return result;
}

const ZERO = BigInt(0);

function selfTime(node: SpanNode): bigint {
    const duration = durationNs(node.startNs, node.endNs);
    if (duration === ZERO || node.children.length === 0) {
        return duration;
    }
    const intervals = node.children
        .filter((child) => child.endNs > child.startNs)
        .map((child): [bigint, bigint] => [child.startNs, child.endNs]);
    const covered = coveredDurationNs(node.startNs, node.endNs, intervals);
    const self = duration - covered;
    return self > ZERO ? self : ZERO;
}

function durationNs(startNs: bigint, endNs: bigint): bigint {
    return endNs > startNs ? endNs - startNs : ZERO;
}

function coveredDurationNs(parentStart: bigint, parentEnd: bigint, intervals: [bigint, bigint][]): bigint {
    const clamped: [bigint, bigint][] = [];
    for (const [start, end] of intervals) {
        const clippedStart = start > parentStart ? start : parentStart;
        const clippedEnd = end < parentEnd ? end : parentEnd;
        if (clippedEnd > clippedStart) {
            clamped.push([clippedStart, clippedEnd]);
        }
    }
    if (clamped.length === 0) {
        return ZERO;
    }
    clamped.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    let covered = ZERO;
    let [mergedStart, mergedEnd] = clamped[0]!;
    for (let i = 1; i < clamped.length; i++) {
        const [start, end] = clamped[i]!;
        if (start <= mergedEnd) {
            if (end > mergedEnd) mergedEnd = end;
            continue;
        }
        covered += mergedEnd - mergedStart;
        mergedStart = start;
        mergedEnd = end;
    }
    covered += mergedEnd - mergedStart;
    return covered;
}
