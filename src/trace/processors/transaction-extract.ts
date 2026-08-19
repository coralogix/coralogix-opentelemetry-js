import {ReadableSpan} from "@opentelemetry/sdk-trace-base";
import {CoralogixAttributes} from "../common";

/**
 * Extract completed local transaction subtrees from a per-trace buffer.
 * Nested extraction keys off `cgx.transaction.root` set at start.
 */
export function extractCompletedLocalTransactions(
    buffer: ReadableSpan[],
    live: Map<string, string | undefined>,
    flushLeftoverWhenIdle: boolean,
): {batches: ReadableSpan[][]; remaining: ReadableSpan[]} {
    if (buffer.length === 0) {
        return {batches: [], remaining: []};
    }

    const parentOf = buildParentOf(buffer, live);

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

    // Deepest roots first so nested txns extract before outer ancestors.
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

    let remaining = extracted.size > 0
        ? buffer.filter((span) => !extracted.has(span.spanContext().spanId))
        : buffer.slice();

    if (flushLeftoverWhenIdle && live.size === 0 && remaining.length > 0) {
        batches.push(remaining);
        remaining = [];
    }

    return {batches, remaining};
}

export function hasExtractableNestedTransaction(
    buffer: ReadableSpan[],
    live: Map<string, string | undefined>,
): boolean {
    if (buffer.length === 0 || live.size === 0) {
        return false;
    }
    const parentOf = buildParentOf(buffer, live);

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

    for (const span of buffer) {
        if (span.attributes[CoralogixAttributes.TRANSACTION_ROOT] !== true) {
            continue;
        }
        const rootId = span.spanContext().spanId;
        if (!hasLiveInSubtree(rootId)) {
            return true;
        }
    }
    return false;
}

function buildParentOf(
    buffer: ReadableSpan[],
    live: Map<string, string | undefined>,
): Map<string, string> {
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
    return parentOf;
}
