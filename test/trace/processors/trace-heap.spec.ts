import {describe, it} from "node:test";
import assert from "node:assert";
import {HrTime, SpanContext, SpanKind, SpanStatusCode, TraceFlags} from "@opentelemetry/api";
import {ReadableSpan} from "@opentelemetry/sdk-trace-base";
import {resourceFromAttributes} from "@opentelemetry/resources";
import {selectSlowestSpans} from "../../../src/trace/processors/trace-heap";

function hr(nanos: number): HrTime {
    return [Math.floor(nanos / 1e9), nanos % 1e9];
}

function makeSpan(opts: {
    name: string;
    spanId: string;
    startNs: number;
    endNs: number;
    parentSpanId?: string;
    root?: boolean;
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
    return {
        name: opts.name,
        kind: SpanKind.INTERNAL,
        spanContext: () => ctx,
        parentSpanContext,
        startTime: hr(opts.startNs),
        endTime: hr(opts.endNs),
        status: {code: SpanStatusCode.UNSET},
        attributes: opts.root ? {"cgx.transaction.root": true} : {},
        links: [],
        events: [],
        duration: hr(opts.endNs - opts.startNs),
        ended: true,
        resource: resourceFromAttributes({}),
        instrumentationScope: {name: "test"},
        droppedAttributesCount: 0,
        droppedEventsCount: 0,
        droppedLinksCount: 0,
    };
}

export default describe("selectSlowestSpans", () => {
    const ROOT = "0000000000000001";
    const MID = "0000000000000002";
    const DB = "0000000000000003";
    const A = "000000000000000a";
    const AUTH = "0000000000000002";
    const CACHE = "0000000000000003";
    const DB_LONG = "0000000000000004";
    const HTTP = "0000000000000005";
    const RENDER = "0000000000000006";

    it("keeps all when under maxNodes", () => {
        const spans = [
            makeSpan({name: "root", spanId: ROOT, startNs: 0, endNs: 100, root: true}),
            makeSpan({name: "a", spanId: A, startNs: 10, endNs: 20, parentSpanId: ROOT}),
        ];
        assert.strictEqual(selectSlowestSpans(spans, 256, [ROOT]).length, 2);
    });

    it("keeps longest and always keeps root", () => {
        const spans = [
            makeSpan({name: "root", spanId: ROOT, startNs: 0, endNs: 200, root: true}),
            makeSpan({name: "auth", spanId: AUTH, startNs: 1, endNs: 6, parentSpanId: ROOT}),
            makeSpan({name: "cache", spanId: CACHE, startNs: 10, endNs: 12, parentSpanId: ROOT}),
            makeSpan({name: "db", spanId: DB_LONG, startNs: 20, endNs: 60, parentSpanId: ROOT}),
            makeSpan({name: "http", spanId: HTTP, startNs: 70, endNs: 150, parentSpanId: ROOT}),
            makeSpan({name: "render", spanId: RENDER, startNs: 160, endNs: 170, parentSpanId: ROOT}),
        ];
        const kept = selectSlowestSpans(spans, 3, [ROOT]);
        assert.deepStrictEqual(new Set(kept.map((s) => s.name)), new Set(["root", "db", "http"]));
    });

    it("reparents when middle parent is dropped", () => {
        const spans = [
            makeSpan({name: "root", spanId: ROOT, startNs: 0, endNs: 100, root: true}),
            makeSpan({name: "middleware", spanId: MID, startNs: 1, endNs: 2, parentSpanId: ROOT}),
            makeSpan({name: "db", spanId: DB, startNs: 5, endNs: 90, parentSpanId: MID}),
        ];
        const kept = selectSlowestSpans(spans, 2, [ROOT]);
        assert.deepStrictEqual(new Set(kept.map((s) => s.name)), new Set(["root", "db"]));
        const db = kept.find((s) => s.name === "db")!;
        assert.strictEqual(db.parentSpanContext?.spanId, ROOT);
    });

    it("preserves remote / external parent on a kept root while trimming", () => {
        const remoteParentId = "ffffffffffffffff";
        const spans = [
            makeSpan({
                name: "root",
                spanId: ROOT,
                startNs: 0,
                endNs: 200,
                parentSpanId: remoteParentId,
                root: true,
            }),
            makeSpan({name: "auth", spanId: AUTH, startNs: 1, endNs: 6, parentSpanId: ROOT}),
            makeSpan({name: "cache", spanId: CACHE, startNs: 10, endNs: 12, parentSpanId: ROOT}),
            makeSpan({name: "db", spanId: DB_LONG, startNs: 20, endNs: 60, parentSpanId: ROOT}),
            makeSpan({name: "http", spanId: HTTP, startNs: 70, endNs: 150, parentSpanId: ROOT}),
            makeSpan({name: "render", spanId: RENDER, startNs: 160, endNs: 170, parentSpanId: ROOT}),
        ];
        // Mark root's parent as remote-style: parent exists in parentSpanContext but not in allSpans.
        const kept = selectSlowestSpans(spans, 3, [ROOT]);
        const root = kept.find((s) => s.name === "root")!;
        assert.strictEqual(
            root.parentSpanContext?.spanId,
            remoteParentId,
            "trimmed export must keep the external parent link",
        );
    });

    it("protects every transaction root when maxNodes is tight", () => {
        const rootA = "0000000000000001";
        const rootB = "0000000000000002";
        const slow = "0000000000000003";
        const spans = [
            makeSpan({name: "root-a", spanId: rootA, startNs: 0, endNs: 1, root: true}),
            makeSpan({name: "root-b", spanId: rootB, startNs: 0, endNs: 1, parentSpanId: rootA, root: true}),
            makeSpan({name: "slow", spanId: slow, startNs: 0, endNs: 100, parentSpanId: rootA}),
        ];
        const kept = selectSlowestSpans(spans, 2, [rootA, rootB]);
        assert.deepStrictEqual(new Set(kept.map((s) => s.name)), new Set(["root-a", "root-b"]));
    });
});
