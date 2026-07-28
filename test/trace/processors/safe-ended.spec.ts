import {describe, it} from "node:test";
import assert from "node:assert";
import {HrTime, SpanContext, SpanKind, SpanStatusCode, TraceFlags} from "@opentelemetry/api";
import {ReadableSpan} from "@opentelemetry/sdk-trace-base";
import {resourceFromAttributes} from "@opentelemetry/resources";
import {_safeEndedSpansForTests as safeEndedSpans} from "../../../src/trace/processors/transaction-span-processor";

function hr(nanos: number): HrTime {
    return [Math.floor(nanos / 1e9), nanos % 1e9];
}

function makeSpan(opts: {
    spanId: string;
    parentSpanId?: string;
    startNs?: number;
    endNs?: number;
}): ReadableSpan {
    const ctx: SpanContext = {
        traceId: "00000000000000000000000000000001",
        spanId: opts.spanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: false,
    };
    const parentSpanContext = opts.parentSpanId
        ? {
            traceId: ctx.traceId,
            spanId: opts.parentSpanId,
            traceFlags: TraceFlags.SAMPLED,
            isRemote: false,
        }
        : undefined;
    const startNs = opts.startNs ?? 0;
    const endNs = opts.endNs ?? 100;
    return {
        name: opts.spanId,
        kind: SpanKind.INTERNAL,
        spanContext: () => ctx,
        parentSpanContext,
        startTime: hr(startNs),
        endTime: hr(endNs),
        status: {code: SpanStatusCode.UNSET},
        attributes: {},
        links: [],
        events: [],
        duration: hr(endNs - startNs),
        ended: true,
        resource: resourceFromAttributes({}),
        instrumentationScope: {name: "test"},
        droppedAttributesCount: 0,
        droppedEventsCount: 0,
        droppedLinksCount: 0,
    };
}

export default describe("safeEndedSpans", () => {
    it("blocks the full ancestor chain of a live span", () => {
        const a = "0000000000000001";
        const b = "0000000000000002";
        const c = "0000000000000003";
        const d = "0000000000000004";
        const spans = [
            makeSpan({spanId: a}),
            makeSpan({spanId: b, parentSpanId: a}),
            makeSpan({spanId: d, parentSpanId: a}),
        ];
        const liveParents = new Map<string, string | undefined>([[c, b]]);
        const out = safeEndedSpans(spans, liveParents);
        assert.deepStrictEqual(out.map((s) => s.spanContext().spanId), [d]);
    });
});
