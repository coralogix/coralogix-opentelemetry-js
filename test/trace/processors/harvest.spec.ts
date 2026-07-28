import {describe, it} from "node:test";
import assert from "node:assert";
import {HrTime, SpanContext, SpanKind, SpanStatusCode, TraceFlags} from "@opentelemetry/api";
import {ReadableSpan} from "@opentelemetry/sdk-trace-base";
import {resourceFromAttributes} from "@opentelemetry/resources";
import {
    HarvestTrace,
    RegularTraceHeap,
    rootDurationNs,
} from "../../../src/trace/processors/harvest";

function hr(nanos: number): HrTime {
    return [Math.floor(nanos / 1e9), nanos % 1e9];
}

function makeSpan(name: string, spanId: string, startNs: number, endNs: number, root = false): ReadableSpan {
    const ctx: SpanContext = {
        traceId: "00000000000000000000000000000001",
        spanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: false,
    };
    return {
        name,
        kind: SpanKind.SERVER,
        spanContext: () => ctx,
        parentSpanContext: undefined,
        startTime: hr(startNs),
        endTime: hr(endNs),
        status: {code: SpanStatusCode.UNSET},
        attributes: root ? {"cgx.transaction.root": true} : {},
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

export default describe("RegularTraceHeap", () => {
    it("keeps only the slowest when capacity is one", () => {
        const heap = new RegularTraceHeap(1);
        const fast: HarvestTrace = {
            durationNs: BigInt(100),
            spans: [makeSpan("fast", "1", 0, 100, true)],
        };
        const mid: HarvestTrace = {
            durationNs: BigInt(200),
            spans: [makeSpan("mid", "3", 0, 200, true)],
        };
        const slow: HarvestTrace = {
            durationNs: BigInt(500),
            spans: [makeSpan("slow", "2", 0, 500, true)],
        };
        assert.strictEqual(heap.witness(fast), true);
        assert.strictEqual(heap.witness(mid), true);
        assert.strictEqual(heap.witness(slow), true);
        const winners = heap.drain();
        assert.strictEqual(winners.length, 1);
        assert.strictEqual(winners[0]!.durationNs, BigInt(500));
        assert.strictEqual(winners[0]!.spans[0]!.name, "slow");
    });

    it("rejects faster than the current winner", () => {
        const heap = new RegularTraceHeap(1);
        assert.strictEqual(
            heap.witness({durationNs: BigInt(500), spans: [makeSpan("slow", "1", 0, 500, true)]}),
            true,
        );
        assert.strictEqual(
            heap.witness({durationNs: BigInt(50), spans: [makeSpan("fast", "2", 0, 50, true)]}),
            false,
        );
        assert.strictEqual(heap.drain()[0]!.spans[0]!.name, "slow");
    });

    it("rootDurationNs prefers the transaction root", () => {
        const spans = [
            makeSpan("child", "2", 0, 999),
            makeSpan("root", "1", 0, 100, true),
        ];
        assert.strictEqual(rootDurationNs(spans), BigInt(100));
    });

    it("rootDurationNs uses max among multiple roots", () => {
        const spans = [
            makeSpan("long", "1", 0, 200, true),
            makeSpan("short", "2", 0, 50, true),
        ];
        assert.strictEqual(rootDurationNs(spans), BigInt(200));
    });
});
