import {describe, it} from "node:test";
import assert from "node:assert";
import {setTimeout as sleep} from "node:timers/promises";
import * as opentelemetry from "@opentelemetry/api";
import {Context, ROOT_CONTEXT, SpanContext, SpanKind} from "@opentelemetry/api";
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    ReadableSpan,
    SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {ExportResultCode} from "@opentelemetry/core";
import {MeterProvider, MetricReader} from "@opentelemetry/sdk-metrics";
import {CoralogixAttributes, CoralogixTraceState, METRIC_SELF_DURATION} from "../../../src/trace/common";
import {TransactionSpanProcessor} from "../../../src/trace/processors";
import {createTraceState} from "@opentelemetry/api";

// Minimal MetricReader that just exposes `collect()` synchronously for assertions, without any
// push/pull export loop of its own.
class TestMetricReader extends MetricReader {
    protected async onForceFlush(): Promise<void> {
        return Promise.resolve();
    }

    protected async onShutdown(): Promise<void> {
        return Promise.resolve();
    }
}

/** Keeps spans across exporter.shutdown() (InMemorySpanExporter clears). */
class StickySpanExporter implements SpanExporter {
    private spans: ReadableSpan[] = [];
    private shut = false;

    export(spans: ReadableSpan[], resultCallback: (result: {code: ExportResultCode}) => void): void {
        if (this.shut) {
            resultCallback({code: ExportResultCode.FAILED});
            return;
        }
        this.spans.push(...spans);
        resultCallback({code: ExportResultCode.SUCCESS});
    }

    async shutdown(): Promise<void> {
        this.shut = true;
    }

    getFinishedSpans(): ReadableSpan[] {
        return this.spans.slice();
    }
}

// `TransactionSpanProcessor` now owns all transaction tagging logic, so it's used here with no
// sampler at all (a plain `BasicTracerProvider` default-samples everything).
function buildProvider() {
    const exporter = new InMemorySpanExporter();
    const reader = new TestMetricReader();
    const meterProvider = new MeterProvider({readers: [reader]});
    const provider = new BasicTracerProvider({
        spanProcessors: [new TransactionSpanProcessor(exporter, {
            meterProvider,
        })],
    });
    return {provider, tracer: provider.getTracer('test'), exporter, reader, meterProvider};
}

export default describe('TransactionSpanProcessor', () => {
    it('stamps self_duration on completed spans and tags the transaction attributes itself', async () => {
        const {provider, tracer, exporter, meterProvider} = buildProvider();
        let context: Context = ROOT_CONTEXT;

        const root = tracer.startSpan('GET /orders', {kind: SpanKind.SERVER}, context);
        context = opentelemetry.trace.setSpan(context, root);
        const child = tracer.startSpan('db', {}, context);
        await sleep(10);
        child.end();
        root.end();

        await provider.forceFlush();
        await meterProvider.forceFlush();

        const spans = exporter.getFinishedSpans();
        const rootSpan = spans.find((s) => s.name === 'GET /orders');
        const childSpan = spans.find((s) => s.name === 'db');
        assert.ok(rootSpan, 'root span must have been exported');
        assert.ok(childSpan, 'child span must have been exported');

        assert.strictEqual(rootSpan!.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'GET /orders',
            'processor-assigned transaction attribute must be set');
        assert.strictEqual(rootSpan!.attributes[CoralogixAttributes.TRANSACTION_ROOT], true,
            'processor-assigned transaction root attribute must be set');
        assert.strictEqual(childSpan!.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'GET /orders',
            'child span must inherit the transaction attribute from its parent');
        assert.ok(!(CoralogixAttributes.TRANSACTION_ROOT in childSpan!.attributes),
            'child span must not have a transaction root attribute');

        assert.ok(CoralogixAttributes.SELF_DURATION in rootSpan!.attributes,
            'root span must have a self_duration attribute');
        assert.ok(CoralogixAttributes.SELF_DURATION in childSpan!.attributes,
            'child span must have a self_duration attribute');
        assert.ok((childSpan!.attributes[CoralogixAttributes.SELF_DURATION] as number) >= 0,
            'child self-duration must not be negative');

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('computes exact self-duration for a parent fully covered by one child (parent 0-100, child 20-80 -> 40/60)', async () => {
        const {provider, tracer, exporter, meterProvider} = buildProvider();
        let context: Context = ROOT_CONTEXT;

        // hrtime is [seconds, nanoseconds]; use explicit start/end times so the exact durations
        // (in nanoseconds) are deterministic instead of depending on real elapsed wall-clock time.
        const root = tracer.startSpan('parent', {startTime: [0, 0]}, context);
        context = opentelemetry.trace.setSpan(context, root);
        const child = tracer.startSpan('child', {startTime: [0, 20]}, context);
        child.end([0, 80]);
        root.end([0, 100]);

        await provider.forceFlush();

        const spans = exporter.getFinishedSpans();
        const rootSpan = spans.find((s) => s.name === 'parent');
        const childSpan = spans.find((s) => s.name === 'child');

        assert.strictEqual(rootSpan!.attributes[CoralogixAttributes.SELF_DURATION], 40 / 1e9);
        assert.strictEqual(childSpan!.attributes[CoralogixAttributes.SELF_DURATION], 60 / 1e9);

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('does not export a completed span until all of its local trace siblings have ended', async () => {
        const {provider, tracer, exporter, meterProvider} = buildProvider();
        let context: Context = ROOT_CONTEXT;

        const root = tracer.startSpan('root', {}, context);
        context = opentelemetry.trace.setSpan(context, root);
        const child = tracer.startSpan('child', {}, context);

        child.end();
        assert.strictEqual(exporter.getFinishedSpans().length, 0,
            'child must be buffered, not exported, while its parent is still live');

        await provider.forceFlush();
        assert.strictEqual(exporter.getFinishedSpans().length, 0,
            'ForceFlush must not finalize incomplete local traces');

        root.end();
        await provider.forceFlush();
        assert.strictEqual(exporter.getFinishedSpans().length, 2,
            'both spans must be exported once the whole local trace has ended');

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('always records the cgx.transaction.self_duration histogram', async () => {
        const {provider, tracer, reader, meterProvider} = buildProvider();
        let context: Context = ROOT_CONTEXT;

        const root = tracer.startSpan('GET /orders', {kind: SpanKind.SERVER}, context);
        context = opentelemetry.trace.setSpan(context, root);
        const child = tracer.startSpan('db', {}, context);
        child.end();
        root.end();

        await provider.forceFlush();
        await meterProvider.forceFlush();

        const {resourceMetrics} = await reader.collect();
        const metricNames = resourceMetrics.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.descriptor.name));
        assert.ok(metricNames.includes(METRIC_SELF_DURATION), `expected ${METRIC_SELF_DURATION} metric to have been recorded`);

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('a SERVER span under a local (non-remote) parent still starts its own new transaction', async () => {
        const {provider, tracer, exporter, meterProvider} = buildProvider();
        let context: Context = ROOT_CONTEXT;

        const outer = tracer.startSpan('worker.run', {}, context);
        context = opentelemetry.trace.setSpan(context, outer);
        // In-process SERVER span (e.g. an inbound request handled on a worker thread that was
        // itself started locally) — no remote hop happened, but SERVER always starts a fresh
        // transaction per the Go sampler rule.
        const inboundServer = tracer.startSpan('POST /webhook', {kind: SpanKind.SERVER}, context);
        context = opentelemetry.trace.setSpan(context, inboundServer);
        const handler = tracer.startSpan('handle', {}, context);

        handler.end();
        inboundServer.end();
        outer.end();

        await provider.forceFlush();
        await meterProvider.forceFlush();

        const spans = exporter.getFinishedSpans();
        const outerSpan = spans.find((s) => s.name === 'worker.run')!;
        const serverSpan = spans.find((s) => s.name === 'POST /webhook')!;
        const handlerSpan = spans.find((s) => s.name === 'handle')!;

        assert.strictEqual(outerSpan.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'worker.run');
        assert.strictEqual(outerSpan.attributes[CoralogixAttributes.TRANSACTION_ROOT], true);

        assert.strictEqual(serverSpan.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'POST /webhook',
            'SERVER span must start its own local transaction even under a local (non-remote) parent');
        assert.strictEqual(serverSpan.attributes[CoralogixAttributes.TRANSACTION_ROOT], true);
        assert.ok(!(CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER in serverSpan.attributes));

        assert.strictEqual(handlerSpan.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'POST /webhook',
            'handler span must inherit the new transaction started by the SERVER span');
        assert.ok(!(CoralogixAttributes.TRANSACTION_ROOT in handlerSpan.attributes));

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('a CONSUMER span under a local parent also starts its own new transaction', async () => {
        const {provider, tracer, exporter, meterProvider} = buildProvider();
        let context: Context = ROOT_CONTEXT;

        const outer = tracer.startSpan('queue.poll', {}, context);
        context = opentelemetry.trace.setSpan(context, outer);
        const consumer = tracer.startSpan('process message', {kind: SpanKind.CONSUMER}, context);

        consumer.end();
        outer.end();

        await provider.forceFlush();
        await meterProvider.forceFlush();

        const spans = exporter.getFinishedSpans();
        const consumerSpan = spans.find((s) => s.name === 'process message')!;

        assert.strictEqual(consumerSpan.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'process message');
        assert.strictEqual(consumerSpan.attributes[CoralogixAttributes.TRANSACTION_ROOT], true);
        assert.ok(!(CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER in consumerSpan.attributes));

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('integration: remote parent starts a new local transaction, annotated with self-duration', async () => {
        const {provider, tracer, exporter, meterProvider} = buildProvider();
        let context: Context = ROOT_CONTEXT;

        const upstream = tracer.startSpan('POST /checkout', {kind: SpanKind.SERVER}, context);
        context = opentelemetry.trace.setSpan(context, upstream);
        const upstreamSpanContext = opentelemetry.trace.getSpanContext(context)!;
        const remoteContext = opentelemetry.trace.setSpanContext(ROOT_CONTEXT, {
            ...upstreamSpanContext,
            isRemote: true,
        });

        const downstreamRoot = tracer.startSpan('POST /charge', {kind: SpanKind.SERVER}, remoteContext);
        const downstreamContext = opentelemetry.trace.setSpan(remoteContext, downstreamRoot);
        const downstreamChild = tracer.startSpan('db.charge', {}, downstreamContext);
        await sleep(5);
        downstreamChild.end();
        downstreamRoot.end();
        upstream.end();

        await provider.forceFlush();
        await meterProvider.forceFlush();

        const spans = exporter.getFinishedSpans();
        const upstreamSpan = spans.find((s) => s.name === 'POST /checkout')!;
        const downstreamRootSpan = spans.find((s) => s.name === 'POST /charge')!;
        const downstreamChildSpan = spans.find((s) => s.name === 'db.charge')!;

        assert.strictEqual(upstreamSpan.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'POST /checkout');
        assert.ok(!(CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER in upstreamSpan.attributes));

        assert.strictEqual(downstreamRootSpan.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'POST /charge',
            'downstream SERVER span must start its own local transaction');
        assert.strictEqual(downstreamRootSpan.attributes[CoralogixAttributes.TRANSACTION_ROOT], true);
        assert.ok(!(CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER in downstreamRootSpan.attributes));

        assert.strictEqual(downstreamChildSpan.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'POST /charge');
        assert.ok(CoralogixAttributes.SELF_DURATION in upstreamSpan.attributes);
        assert.ok(CoralogixAttributes.SELF_DURATION in downstreamRootSpan.attributes);
        assert.ok(CoralogixAttributes.SELF_DURATION in downstreamChildSpan.attributes);
        assert.ok((upstreamSpan.attributes[CoralogixAttributes.SELF_DURATION] as number) >= 0);
        assert.ok((downstreamRootSpan.attributes[CoralogixAttributes.SELF_DURATION] as number) >= 0);
        assert.ok((downstreamChildSpan.attributes[CoralogixAttributes.SELF_DURATION] as number) >= 0);

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('preserves a pre-set cgx.transaction name (e.g. sampler Express template)', async () => {
        const {provider, tracer, exporter, meterProvider} = buildProvider();

        const root = tracer.startSpan('GET /users/123', {
            kind: SpanKind.SERVER,
            attributes: {[CoralogixAttributes.TRANSACTION_IDENTIFIER]: 'GET /users/:id'},
        });
        root.end();

        await provider.forceFlush();
        const spans = exporter.getFinishedSpans();
        assert.strictEqual(spans.length, 1);
        assert.strictEqual(
            spans[0]!.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER],
            'GET /users/:id',
        );
        assert.strictEqual(spans[0]!.attributes[CoralogixAttributes.TRANSACTION_ROOT], true);

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('shutdown drops incomplete local traces instead of partially finalizing them', async () => {
        const exporter = new StickySpanExporter();
        const reader = new TestMetricReader();
        const meterProvider = new MeterProvider({readers: [reader]});
        const processor = new TransactionSpanProcessor(exporter, {
            meterProvider,
            shutdownIdleWaitMillis: 20,
        });
        const provider = new BasicTracerProvider({spanProcessors: [processor]});
        const tracer = provider.getTracer('test');

        const root = tracer.startSpan('parent', {kind: SpanKind.SERVER, startTime: [0, 0]});
        const rootCtx = opentelemetry.trace.setSpan(ROOT_CONTEXT, root);
        const child = tracer.startSpan('child', {startTime: [0, 10]}, rootCtx);
        child.end([0, 30]);

        await provider.shutdown();
        assert.strictEqual(
            exporter.getFinishedSpans().length,
            0,
            'incomplete local trace must not be partially finalized on shutdown timeout',
        );

        root.end([0, 50]);
        assert.strictEqual(
            exporter.getFinishedSpans().length,
            0,
            'late end after exporter shutdown must not export',
        );

        await meterProvider.shutdown();
    });

    it('tracks post-shutdown children of in-flight traces so parents are not finalized early', async () => {
        const exporter = new StickySpanExporter();
        const reader = new TestMetricReader();
        const meterProvider = new MeterProvider({readers: [reader]});
        const processor = new TransactionSpanProcessor(exporter, {
            meterProvider,
            shutdownIdleWaitMillis: 500,
        });
        const provider = new BasicTracerProvider({spanProcessors: [processor]});
        const tracer = provider.getTracer('test');

        const root = tracer.startSpan('parent', {kind: SpanKind.SERVER, startTime: [0, 0]});
        const rootCtx = opentelemetry.trace.setSpan(ROOT_CONTEXT, root);

        const shutdownPromise = provider.shutdown();
        await sleep(10);

        const child = tracer.startSpan('late-child', {startTime: [0, 20]}, rootCtx);
        root.end([0, 40]);
        await sleep(20);
        assert.strictEqual(
            exporter.getFinishedSpans().length,
            0,
            'parent must not export while post-stop child is still live',
        );

        child.end([0, 80]);
        await shutdownPromise;

        const spans = exporter.getFinishedSpans();
        assert.strictEqual(spans.length, 2);
        assert.ok(spans.some((s) => s.name === 'parent'));
        assert.ok(spans.some((s) => s.name === 'late-child'));

        await meterProvider.shutdown();
    });

    it('inherits cgx.transaction from parent TraceState when parent span has no attributes', async () => {
        const {provider, tracer, exporter, meterProvider} = buildProvider();

        const parentTraceState = createTraceState().set(
            CoralogixTraceState.TRANSACTION_IDENTIFIER,
            'from-tracestate',
        );
        const parentCtx = opentelemetry.trace.setSpanContext(ROOT_CONTEXT, {
            traceId: '00000000000000000000000000000001',
            spanId: '0000000000000001',
            traceFlags: 1,
            isRemote: false,
            traceState: parentTraceState,
        });

        const child = tracer.startSpan('internal-child', {kind: SpanKind.INTERNAL}, parentCtx);
        child.end();

        await provider.forceFlush();
        const spans = exporter.getFinishedSpans();
        assert.strictEqual(spans.length, 1);
        assert.strictEqual(
            spans[0]!.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER],
            'from-tracestate',
        );
        assert.ok(
            !(CoralogixAttributes.TRANSACTION_ROOT in spans[0]!.attributes),
            'INTERNAL child under local parent must not become a new transaction root',
        );

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('exports nested SERVER transaction before outer ancestor ends', async () => {
        const exporter = new StickySpanExporter();
        const reader = new TestMetricReader();
        const meterProvider = new MeterProvider({readers: [reader]});
        const processor = new TransactionSpanProcessor(exporter, {
            meterProvider,
            completionHoldbackMillis: 0,
        });
        const provider = new BasicTracerProvider({spanProcessors: [processor]});
        const tracer = provider.getTracer('test');

        let context: Context = ROOT_CONTEXT;
        const outer = tracer.startSpan('worker.run', {startTime: [0, 0]}, context);
        context = opentelemetry.trace.setSpan(context, outer);
        const inboundServer = tracer.startSpan('POST /webhook', {
            kind: SpanKind.SERVER,
            startTime: [0, 10],
        }, context);
        context = opentelemetry.trace.setSpan(context, inboundServer);
        const handler = tracer.startSpan('handle', {startTime: [0, 20]}, context);

        handler.end([0, 80]);
        inboundServer.end([0, 90]);

        await provider.forceFlush();
        let spans = exporter.getFinishedSpans();
        assert.strictEqual(spans.length, 2, 'inner txn must export while outer is still live');
        assert.ok(spans.some((s) => s.name === 'POST /webhook'));
        assert.ok(spans.some((s) => s.name === 'handle'));
        assert.ok(!spans.some((s) => s.name === 'worker.run'), 'outer must stay buffered until it ends');

        outer.end([0, 100]);
        await provider.forceFlush();
        spans = exporter.getFinishedSpans();
        assert.strictEqual(spans.length, 3, 'outer exports after it ends');
        const outerSpan = spans.find((s) => s.name === 'worker.run')!;
        assert.ok(CoralogixAttributes.SELF_DURATION in outerSpan.attributes);

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('holdback keeps fire-and-forget children on the same local trace', async () => {
        const exporter = new StickySpanExporter();
        const reader = new TestMetricReader();
        const meterProvider = new MeterProvider({readers: [reader]});
        const processor = new TransactionSpanProcessor(exporter, {
            meterProvider,
            completionHoldbackMillis: 50,
        });
        const provider = new BasicTracerProvider({spanProcessors: [processor]});
        const tracer = provider.getTracer('test');

        const root = tracer.startSpan('parent', {kind: SpanKind.SERVER, startTime: [0, 0]});
        const rootCtx = opentelemetry.trace.setSpan(ROOT_CONTEXT, root);
        root.end([0, 40]);

        // Child starts after parent ended (same traceId via parent context).
        await sleep(5);
        assert.strictEqual(
            exporter.getFinishedSpans().length,
            0,
            'must not finalize immediately while holdback is open',
        );

        const child = tracer.startSpan('async-child', {startTime: [0, 50]}, rootCtx);
        child.end([0, 80]);

        await provider.forceFlush();
        const spans = exporter.getFinishedSpans();
        assert.strictEqual(spans.length, 2, 'parent and late child must export together');
        assert.ok(spans.some((s) => s.name === 'parent'));
        assert.ok(spans.some((s) => s.name === 'async-child'));
        const parentSpan = spans.find((s) => s.name === 'parent')!;
        // parent [0,40], child [50,80] does not overlap parent → self-duration = full 40ns... 
        // wait times are [sec, ns] - [0,40] means 40 nanoseconds
        assert.ok(CoralogixAttributes.SELF_DURATION in parentSpan.attributes);

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('nested holdback keeps fire-and-forget children under nested SERVER', async () => {
        const exporter = new StickySpanExporter();
        const reader = new TestMetricReader();
        const meterProvider = new MeterProvider({readers: [reader]});
        const processor = new TransactionSpanProcessor(exporter, {
            meterProvider,
            completionHoldbackMillis: 50,
        });
        const provider = new BasicTracerProvider({spanProcessors: [processor]});
        const tracer = provider.getTracer('test');

        let context: Context = ROOT_CONTEXT;
        const outer = tracer.startSpan('worker.run', {startTime: [0, 0]}, context);
        context = opentelemetry.trace.setSpan(context, outer);
        const nested = tracer.startSpan('POST /webhook', {
            kind: SpanKind.SERVER,
            startTime: [0, 10],
        }, context);
        const nestedCtx = opentelemetry.trace.setSpan(context, nested);
        nested.end([0, 40]);

        await sleep(5);
        assert.strictEqual(
            exporter.getFinishedSpans().length,
            0,
            'nested must wait for holdback while outer is live',
        );

        const late = tracer.startSpan('async-nested-child', {startTime: [0, 50]}, nestedCtx);
        late.end([0, 80]);

        await sleep(60);
        let spans = exporter.getFinishedSpans();
        assert.ok(spans.some((s) => s.name === 'POST /webhook'));
        assert.ok(
            spans.some((s) => s.name === 'async-nested-child'),
            'late child under nested root must join the nested batch',
        );
        assert.ok(!spans.some((s) => s.name === 'worker.run'), 'outer must stay buffered');

        outer.end([0, 100]);
        await provider.forceFlush();
        spans = exporter.getFinishedSpans();
        assert.ok(spans.some((s) => s.name === 'worker.run'));

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('integration: remote parent does not leak childIntervals', async () => {
        const exporter = new StickySpanExporter();
        const reader = new TestMetricReader();
        const meterProvider = new MeterProvider({readers: [reader]});
        const processor = new TransactionSpanProcessor(exporter, {
            meterProvider,
            completionHoldbackMillis: 0,
        });
        const provider = new BasicTracerProvider({spanProcessors: [processor]});
        const tracer = provider.getTracer('test');

        const remoteParent: SpanContext = {
            traceId: '00000000000000000000000000000001',
            spanId: 'ffffffffffffffff',
            traceFlags: 1,
            isRemote: true,
        };
        const remoteContext = opentelemetry.trace.setSpanContext(ROOT_CONTEXT, remoteParent);

        for (let i = 0; i < 5; i++) {
            const root = tracer.startSpan(`GET /item/${i}`, {
                kind: SpanKind.SERVER,
                startTime: [0, i * 100],
            }, remoteContext);
            root.end([0, i * 100 + 50]);
        }
        await provider.forceFlush();
        assert.strictEqual(exporter.getFinishedSpans().length, 5);

        // Peek private map via acceptCompleted cleanup: another local child under a
        // local parent should still record intervals; remote parents must not accumulate.
        const intervals = (processor as unknown as {
            childIntervals: Map<string, unknown[]>;
        }).childIntervals;
        assert.strictEqual(
            intervals.has('ffffffffffffffff'),
            false,
            'remote parent span id must not retain childIntervals',
        );
        assert.strictEqual(intervals.size, 0, 'acceptCompleted must clear local interval keys');

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('outer ending before nested still finalizes nested and outer as separate txns', async () => {
        // Outer ends while nested is live, so outer sits earlier in the buffer.
        // On nested end (TraceID idle), extraction must process deepest-first:
        // nested first, then outer without re-absorbing nested spans.
        const exporter = new StickySpanExporter();
        const reader = new TestMetricReader();
        const meterProvider = new MeterProvider({readers: [reader]});
        const processor = new TransactionSpanProcessor(exporter, {
            meterProvider,
            completionHoldbackMillis: 0,
        });
        const provider = new BasicTracerProvider({spanProcessors: [processor]});
        const tracer = provider.getTracer('test');

        let context: Context = ROOT_CONTEXT;
        const outer = tracer.startSpan('outer', {
            kind: SpanKind.SERVER,
            startTime: [0, 0],
        }, context);
        context = opentelemetry.trace.setSpan(context, outer);
        const nested = tracer.startSpan('nested', {
            kind: SpanKind.SERVER,
            startTime: [0, 10],
        }, context);
        context = opentelemetry.trace.setSpan(context, nested);
        const nestedChild = tracer.startSpan('nested-child', {startTime: [0, 20]}, context);

        outer.end([0, 40]);
        assert.strictEqual(
            exporter.getFinishedSpans().length,
            0,
            'outer must stay buffered while nested subtree is still live',
        );

        nestedChild.end([0, 50]);
        nested.end([0, 60]);
        await provider.forceFlush();

        const spans = exporter.getFinishedSpans();
        assert.strictEqual(spans.length, 3, 'nested + outer must export as separate batches');
        assert.ok(spans.some((s) => s.name === 'nested'));
        assert.ok(spans.some((s) => s.name === 'nested-child'));
        assert.ok(spans.some((s) => s.name === 'outer'));

        const nestedRoot = spans.find((s) => s.name === 'nested')!;
        const outerRoot = spans.find((s) => s.name === 'outer')!;
        assert.strictEqual(nestedRoot.attributes[CoralogixAttributes.TRANSACTION_ROOT], true);
        assert.strictEqual(outerRoot.attributes[CoralogixAttributes.TRANSACTION_ROOT], true);
        assert.strictEqual(
            nestedRoot.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER],
            'nested',
        );
        assert.strictEqual(
            outerRoot.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER],
            'outer',
        );

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('shutdown exports completed traces immediately', async () => {
        const exporter = new StickySpanExporter();
        const reader = new TestMetricReader();
        const meterProvider = new MeterProvider({readers: [reader]});
        const processor = new TransactionSpanProcessor(exporter, {
            meterProvider,
            completionHoldbackMillis: 0,
            shutdownIdleWaitMillis: 500,
        });
        const provider = new BasicTracerProvider({spanProcessors: [processor]});
        const tracer = provider.getTracer('test');

        const root = tracer.startSpan('late', {
            kind: SpanKind.SERVER,
            startTime: [0, 0],
        });

        const shutdownPromise = provider.shutdown();
        await sleep(20);
        root.end([0, 100_000_000]);
        await shutdownPromise;

        const spans = exporter.getFinishedSpans();
        assert.strictEqual(
            spans.length,
            1,
            'completed trace during shutdown must export',
        );
        assert.strictEqual(spans[0]!.name, 'late');

        await meterProvider.shutdown();
    });

    it('forceFlush finalizes idle buffered traces without a holdback timer', async () => {
        // Nested extracts while outer is live; outer then ends with holdback=0
        // (no timer). forceFlush must still scan idle buffers and finalize outer.
        const exporter = new StickySpanExporter();
        const reader = new TestMetricReader();
        const meterProvider = new MeterProvider({readers: [reader]});
        const processor = new TransactionSpanProcessor(exporter, {
            meterProvider,
            completionHoldbackMillis: 0,
        });
        const provider = new BasicTracerProvider({spanProcessors: [processor]});
        const tracer = provider.getTracer('test');

        let context: Context = ROOT_CONTEXT;
        const outer = tracer.startSpan('worker', {startTime: [0, 0]}, context);
        context = opentelemetry.trace.setSpan(context, outer);
        const nested = tracer.startSpan('POST /hook', {
            kind: SpanKind.SERVER,
            startTime: [0, 10],
        }, context);
        nested.end([0, 50]);

        await provider.forceFlush();
        assert.strictEqual(
            exporter.getFinishedSpans().length,
            1,
            'nested SERVER must export while outer is still live',
        );
        assert.strictEqual(exporter.getFinishedSpans()[0]!.name, 'POST /hook');

        outer.end([0, 80]);
        await provider.forceFlush();
        const spans = exporter.getFinishedSpans();
        assert.strictEqual(spans.length, 2, 'forceFlush must finalize idle outer buffer');
        assert.ok(spans.some((s) => s.name === 'worker'));

        await provider.shutdown();
        await meterProvider.shutdown();
    });

    it('holdback callback no-ops after exporter shutdown', async () => {
        const exporter = new StickySpanExporter();
        const reader = new TestMetricReader();
        const meterProvider = new MeterProvider({readers: [reader]});
        const processor = new TransactionSpanProcessor(exporter, {
            meterProvider,
            completionHoldbackMillis: 80,
            shutdownIdleWaitMillis: 10,
        });
        const provider = new BasicTracerProvider({spanProcessors: [processor]});
        const tracer = provider.getTracer('test');

        // Incomplete trace: child ended, parent still live → dropped on shutdown.
        const root = tracer.startSpan('parent', {kind: SpanKind.SERVER, startTime: [0, 0]});
        const rootCtx = opentelemetry.trace.setSpan(ROOT_CONTEXT, root);
        const child = tracer.startSpan('child', {startTime: [0, 10]}, rootCtx);
        child.end([0, 30]);

        await provider.shutdown();
        assert.strictEqual(exporter.getFinishedSpans().length, 0);

        // Late end after exporter shutdown must not export (holdback must no-op).
        root.end([0, 50]);
        await sleep(120);
        assert.strictEqual(
            exporter.getFinishedSpans().length,
            0,
            'holdback after exporterShutdown must not export',
        );

        await meterProvider.shutdown();
    });

    it('stamps cgx.transaction from final root name after updateName (Express-style)', async () => {
        const {provider, tracer, exporter, meterProvider} = buildProvider();
        let context: Context = ROOT_CONTEXT;

        // Express HTTP instrumentation often starts the span as "GET", then
        // middleware renames it to "GET /myroute" before end.
        const root = tracer.startSpan('GET', {kind: SpanKind.SERVER}, context);
        root.updateName('GET /myroute');
        context = opentelemetry.trace.setSpan(context, root);
        const child = tracer.startSpan('db', {}, context);
        child.end();
        root.end();

        await provider.forceFlush();
        const spans = exporter.getFinishedSpans();
        const rootSpan = spans.find((s) => s.name === 'GET /myroute');
        const childSpan = spans.find((s) => s.name === 'db');
        assert.ok(rootSpan, 'renamed root must be exported');
        assert.ok(childSpan, 'child must be exported');

        assert.strictEqual(
            rootSpan!.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER],
            'GET /myroute',
            'transaction name must use final root span name, not the start name',
        );
        assert.strictEqual(
            childSpan!.attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER],
            'GET /myroute',
            'children must receive the finalized root transaction name',
        );
        assert.strictEqual(rootSpan!.attributes[CoralogixAttributes.TRANSACTION_ROOT], true);

        await provider.shutdown();
        await meterProvider.shutdown();
    });
});
