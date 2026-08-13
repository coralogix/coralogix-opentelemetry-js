import {ReadableSpan} from "@opentelemetry/sdk-trace-base";

/**
 * Filter ended spans whose ancestor chain still has a live span
 * (used by unit tests for holdback / partial-export logic).
 */
export function safeEndedSpans(
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
