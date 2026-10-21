import {describe, it} from "node:test";
import assert from "node:assert";
import {
    Attributes,
    Context,
    createTraceState,
    defaultTextMapGetter,
    defaultTextMapSetter,
    ROOT_CONTEXT,
    Span,
    SpanKind,
    SpanStatusCode,
    trace,
} from "@opentelemetry/api";
import {W3CTraceContextPropagator} from "@opentelemetry/core";
import {resourceFromAttributes} from "@opentelemetry/resources";
import {BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor} from "@opentelemetry/sdk-trace-base";
import {DataPointType, MeterProvider, MetricReader} from "@opentelemetry/sdk-metrics";
import {
    CoralogixPathwaySampler,
    CoralogixTransactionSampler,
    OVERFLOW_PATHWAY_ID,
    PathwayAttributes,
    PathwayMetricAttributes,
    PathwayMetrics,
    PathwayMetricsSpanProcessor,
    pathwayId,
    PathwayTraceState,
} from "../../../src";

class TestMetricReader extends MetricReader {
    protected async onForceFlush(): Promise<void> {
        return;
    }

    protected async onShutdown(): Promise<void> {
        return;
    }
}

interface Point {
    attributes: Attributes;
    value: number;
    count?: number;
}

const propagator = new W3CTraceContextPropagator();

function createMesh(options: {maxPathwaysPerRoot?: number, maxDepth?: number} = {}) {
    const reader = new TestMetricReader();
    const meterProvider = new MeterProvider({readers: [reader]});
    const exporter = new InMemorySpanExporter();
    const services = new Map<string, ReturnType<BasicTracerProvider['getTracer']>>();

    function tracer(serviceName: string) {
        let existing = services.get(serviceName);
        if (existing === undefined) {
            const provider = new BasicTracerProvider({
                resource: resourceFromAttributes({'service.name': serviceName}),
                sampler: new CoralogixPathwaySampler({serviceName, maxDepth: options.maxDepth}),
                spanProcessors: [
                    new SimpleSpanProcessor(exporter),
                    new PathwayMetricsSpanProcessor({meterProvider, maxPathwaysPerRoot: options.maxPathwaysPerRoot}),
                ],
            });
            existing = provider.getTracer('test');
            services.set(serviceName, existing);
        }
        return existing;
    }

    function serve(serviceName: string, carrier: Record<string, string> | undefined, name: string, handler: (ctx: Context) => void, kind = SpanKind.SERVER): Span {
        const parentContext = carrier === undefined ? ROOT_CONTEXT : propagator.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);
        const span = tracer(serviceName).startSpan(name, {kind}, parentContext);
        handler(trace.setSpan(parentContext, span));
        span.end();
        return span;
    }

    function call(serviceName: string, ctx: Context, target: string, handler: (ctx: Context) => void): void {
        const client = tracer(serviceName).startSpan(`call ${target}`, {kind: SpanKind.CLIENT, attributes: {'server.address': target}}, ctx);
        const carrier: Record<string, string> = {};
        propagator.inject(trace.setSpan(ctx, client), carrier, defaultTextMapSetter);
        serve(target, carrier, `handle ${target}`, handler);
        client.end();
    }

    function query(serviceName: string, ctx: Context, attributes: Attributes, status = SpanStatusCode.UNSET): void {
        const span = tracer(serviceName).startSpan('query', {kind: SpanKind.CLIENT, attributes}, ctx);
        span.setStatus({code: status});
        span.end();
    }

    async function points(metricName: string): Promise<Point[]> {
        const {resourceMetrics} = await reader.collect();
        const metric = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).find((m) => m.descriptor.name === metricName);
        if (metric === undefined) {
            return [];
        }
        return metric.dataPoints.map((point) => {
            if (metric.dataPointType === DataPointType.HISTOGRAM) {
                const histogram = point.value as {count: number, sum?: number};
                return {attributes: point.attributes, value: histogram.sum ?? 0, count: histogram.count};
            }
            return {attributes: point.attributes, value: point.value as number};
        });
    }

    return {tracer, serve, call, query, points, exporter};
}

const FRONTEND = pathwayId('frontend', undefined);
const FRONTEND_CHECKOUT = pathwayId('checkout', FRONTEND);
const FRONTEND_CHECKOUT_PAYMENT = pathwayId('payment', FRONTEND_CHECKOUT);

function find(points: Point[], match: Record<string, string | number | boolean>): Point[] {
    return points.filter((point) => Object.entries(match).every(([key, value]) => point.attributes[key] === value));
}

function rebuildChain(info: Point[], id: string): string[] {
    const byId = new Map(info.map((point) => [point.attributes[PathwayMetricAttributes.ID], point.attributes]));
    const chain: string[] = [];
    let current = byId.get(id);
    while (current !== undefined) {
        chain.unshift(String(current[PathwayMetricAttributes.SERVICE]));
        current = byId.get(current[PathwayMetricAttributes.PARENT_ID]);
    }
    return chain;
}

export default describe('Pathways', () => {
    it('labels every hop with the root service, the exact caller and a chain-specific pathway id', async () => {
        const mesh = createMesh();
        mesh.serve('frontend', undefined, 'GET /checkout', (frontendCtx) => {
            mesh.call('frontend', frontendCtx, 'checkout', (checkoutCtx) => {
                mesh.call('checkout', checkoutCtx, 'payment', (paymentCtx) => {
                    mesh.query('payment', paymentCtx, {'db.system.name': 'postgresql', 'db.namespace': 'orders'});
                });
                mesh.query('checkout', checkoutCtx, {'db.system.name': 'redis'});
            });
        });

        const hops = await mesh.points(PathwayMetrics.HOP_DURATION);
        assert.strictEqual(hops.length, 3);

        const [payment] = find(hops, {[PathwayMetricAttributes.SERVICE]: 'payment'});
        assert.ok(payment);
        assert.strictEqual(payment.attributes[PathwayMetricAttributes.ROOT_SERVICE], 'frontend');
        assert.strictEqual(payment.attributes[PathwayMetricAttributes.ROOT_TRANSACTION], 'GET /checkout');
        assert.strictEqual(payment.attributes[PathwayMetricAttributes.CALLER], 'checkout');
        assert.strictEqual(payment.attributes[PathwayMetricAttributes.ID], FRONTEND_CHECKOUT_PAYMENT);
        assert.strictEqual(payment.attributes[PathwayMetricAttributes.PARENT_ID], FRONTEND_CHECKOUT);
        assert.strictEqual(payment.attributes[PathwayMetricAttributes.DEPTH], 2);

        const [frontend] = find(hops, {[PathwayMetricAttributes.SERVICE]: 'frontend'});
        assert.strictEqual(frontend?.attributes[PathwayMetricAttributes.CALLER], 'none');
        assert.strictEqual(frontend?.attributes[PathwayMetricAttributes.PARENT_ID], 'none');
    });

    it('records end-to-end duration only on the pathway root', async () => {
        const mesh = createMesh();
        mesh.serve('frontend', undefined, 'GET /checkout', (frontendCtx) => {
            mesh.call('frontend', frontendCtx, 'checkout', () => undefined);
        });

        const e2e = await mesh.points(PathwayMetrics.DURATION);
        assert.strictEqual(e2e.length, 1);
        assert.strictEqual(e2e[0]?.attributes[PathwayMetricAttributes.ROOT_SERVICE], 'frontend');
        assert.strictEqual(e2e[0]?.count, 1);
    });

    it('records outbound calls with a classified destination and the caller pathway id', async () => {
        const mesh = createMesh();
        mesh.serve('frontend', undefined, 'GET /checkout', (frontendCtx) => {
            mesh.call('frontend', frontendCtx, 'checkout', (checkoutCtx) => {
                mesh.call('checkout', checkoutCtx, 'payment', (paymentCtx) => {
                    mesh.query('payment', paymentCtx, {'db.system.name': 'postgresql', 'db.namespace': 'orders'}, SpanStatusCode.ERROR);
                });
                mesh.query('checkout', checkoutCtx, {'messaging.system': 'kafka', 'messaging.destination.name': 'orders'});
            });
        });

        const outbound = await mesh.points(PathwayMetrics.OUTBOUND_DURATION);
        const [database] = find(outbound, {[PathwayMetricAttributes.DESTINATION]: 'postgresql:orders'});
        assert.strictEqual(database?.attributes[PathwayMetricAttributes.DESTINATION_TYPE], 'database');
        assert.strictEqual(database?.attributes[PathwayMetricAttributes.ID], FRONTEND_CHECKOUT_PAYMENT);
        assert.strictEqual(database?.attributes[PathwayMetricAttributes.ERROR], true);

        const [queue] = find(outbound, {[PathwayMetricAttributes.DESTINATION]: 'kafka:orders'});
        assert.strictEqual(queue?.attributes[PathwayMetricAttributes.DESTINATION_TYPE], 'messaging');
        assert.strictEqual(queue?.attributes[PathwayMetricAttributes.ID], FRONTEND_CHECKOUT);

        const [remote] = find(outbound, {[PathwayMetricAttributes.DESTINATION]: 'payment'});
        assert.strictEqual(remote?.attributes[PathwayMetricAttributes.DESTINATION_TYPE], 'remote');
        assert.strictEqual(remote?.attributes[PathwayMetricAttributes.SERVICE], 'checkout');
    });

    it('separates the same service under different upstream chains', async () => {
        const mesh = createMesh();
        mesh.serve('frontend', undefined, 'GET /checkout', (frontendCtx) => {
            mesh.call('frontend', frontendCtx, 'checkout', (checkoutCtx) => {
                mesh.call('checkout', checkoutCtx, 'payment', () => undefined);
            });
            mesh.call('frontend', frontendCtx, 'payment', () => undefined);
        });
        mesh.serve('checkout', undefined, 'POST /retry', (checkoutCtx) => {
            mesh.call('checkout', checkoutCtx, 'payment', () => undefined);
        });

        const payments = find(await mesh.points(PathwayMetrics.HOP_DURATION), {[PathwayMetricAttributes.SERVICE]: 'payment'});
        const routes = payments.map((point) => [
            point.attributes[PathwayMetricAttributes.ROOT_SERVICE],
            point.attributes[PathwayMetricAttributes.CALLER],
            point.attributes[PathwayMetricAttributes.ID],
        ]);
        assert.deepStrictEqual(new Set(routes.map((route) => route[2])).size, 3);
        assert.ok(routes.some(([root, caller]) => root === 'frontend' && caller === 'checkout'));
        assert.ok(routes.some(([root, caller]) => root === 'frontend' && caller === 'frontend'));
        assert.ok(routes.some(([root, caller]) => root === 'checkout' && caller === 'checkout'));
    });

    it('publishes an info series that rebuilds the readable chain from pathway ids', async () => {
        const mesh = createMesh();
        mesh.serve('frontend', undefined, 'GET /checkout', (frontendCtx) => {
            mesh.call('frontend', frontendCtx, 'checkout', (checkoutCtx) => {
                mesh.call('checkout', checkoutCtx, 'payment', () => undefined);
            });
        });

        const info = await mesh.points(PathwayMetrics.INFO);
        assert.deepStrictEqual(rebuildChain(info, FRONTEND_CHECKOUT_PAYMENT), ['frontend', 'checkout', 'payment']);
    });

    it('does not create a new node when a service calls itself', async () => {
        const mesh = createMesh();
        mesh.serve('frontend', undefined, 'GET /checkout', (frontendCtx) => {
            mesh.call('frontend', frontendCtx, 'checkout', (checkoutCtx) => {
                mesh.call('checkout', checkoutCtx, 'checkout', (innerCtx) => {
                    mesh.call('checkout', innerCtx, 'payment', () => undefined);
                });
            });
        });

        const hops = await mesh.points(PathwayMetrics.HOP_DURATION);
        assert.strictEqual(find(hops, {[PathwayMetricAttributes.SERVICE]: 'checkout'}).length, 1);
        const [payment] = find(hops, {[PathwayMetricAttributes.SERVICE]: 'payment'});
        assert.strictEqual(payment?.attributes[PathwayMetricAttributes.ID], FRONTEND_CHECKOUT_PAYMENT);
    });

    it('starts a new pathway with an unknown caller when the upstream carries no pathway state', async () => {
        const mesh = createMesh();
        const carrier = {traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'};
        mesh.serve('checkout', carrier, 'POST /orders', () => undefined);

        const [hop] = await mesh.points(PathwayMetrics.HOP_DURATION);
        assert.strictEqual(hop?.attributes[PathwayMetricAttributes.CALLER], 'unknown');
        assert.strictEqual(hop?.attributes[PathwayMetricAttributes.ROOT_SERVICE], 'checkout');
        assert.strictEqual((await mesh.points(PathwayMetrics.DURATION)).length, 1);
    });

    it('folds hops beyond the max depth into the last kept node', async () => {
        const mesh = createMesh({maxDepth: 1});
        mesh.serve('frontend', undefined, 'GET /checkout', (frontendCtx) => {
            mesh.call('frontend', frontendCtx, 'checkout', (checkoutCtx) => {
                mesh.call('checkout', checkoutCtx, 'payment', () => undefined);
            });
        });

        const hops = await mesh.points(PathwayMetrics.HOP_DURATION);
        assert.strictEqual(find(hops, {[PathwayMetricAttributes.SERVICE]: 'payment'}).length, 0);
        const [deep] = find(await mesh.points(PathwayMetrics.OUTBOUND_DURATION), {[PathwayMetricAttributes.DESTINATION]: 'payment'});
        assert.strictEqual(deep?.attributes[PathwayMetricAttributes.ID], FRONTEND_CHECKOUT);
    });

    it('routes pathways beyond the per-root cap of a process to the overflow id without losing counts', async () => {
        const mesh = createMesh({maxPathwaysPerRoot: 2});
        mesh.serve('frontend', undefined, 'GET /checkout', (frontendCtx) => {
            for (const middle of ['a', 'b', 'c', 'd']) {
                mesh.call('frontend', frontendCtx, middle, (middleCtx) => {
                    mesh.call(middle, middleCtx, 'payment', () => undefined);
                });
            }
        });

        const payments = find(await mesh.points(PathwayMetrics.HOP_DURATION), {[PathwayMetricAttributes.SERVICE]: 'payment'});
        const total = (points: Point[]) => points.reduce((sum, point) => sum + (point.count ?? 0), 0);
        assert.strictEqual(total(payments), 4);
        assert.strictEqual(total(find(payments, {[PathwayMetricAttributes.ID]: OVERFLOW_PATHWAY_ID})), 2);
    });

    it('keeps foreign tracestate entries and composes with the transaction sampler', () => {
        const exporter = new InMemorySpanExporter();
        const provider = new BasicTracerProvider({
            sampler: new CoralogixPathwaySampler({serviceName: 'checkout', delegate: new CoralogixTransactionSampler()}),
            spanProcessors: [new SimpleSpanProcessor(exporter)],
        });
        const parent = trace.setSpanContext(ROOT_CONTEXT, {
            traceId: '0af7651916cd43dd8448eb211c80319c',
            spanId: 'b7ad6b7169203331',
            traceFlags: 1,
            isRemote: true,
            traceState: createTraceState(`vendor=keep,${PathwayTraceState.ID}=${FRONTEND},${PathwayTraceState.ROOT_SERVICE}=frontend,${PathwayTraceState.CALLER}=frontend,${PathwayTraceState.DEPTH}=0`),
        });
        const span = provider.getTracer('test').startSpan('POST /orders', {kind: SpanKind.SERVER}, parent);
        const child = provider.getTracer('test').startSpan('call payment', {kind: SpanKind.CLIENT}, trace.setSpan(parent, span));
        child.end();
        span.end();

        const state = child.spanContext().traceState;
        assert.strictEqual(state?.get('vendor'), 'keep');
        assert.strictEqual(state?.get(PathwayTraceState.ID), FRONTEND_CHECKOUT);
        assert.strictEqual(state?.get(PathwayTraceState.CALLER), 'checkout');
        assert.strictEqual(state?.get('cgx_transaction'), 'POST /orders');

        const exported = exporter.getFinishedSpans().find((s) => s.name === 'POST /orders');
        assert.strictEqual(exported?.attributes[PathwayAttributes.CALLER], 'frontend');
        assert.strictEqual(exported?.attributes['cgx.transaction'], 'POST /orders');
    });
});
