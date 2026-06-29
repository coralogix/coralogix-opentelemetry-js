import {beforeEach, describe, it, mock} from "node:test";
import {CoralogixTransactionSampler} from "../../../src/trace/samplers";
import * as opentelemetry from "@opentelemetry/api";
import {Attributes, Context, createTraceState, Link, ROOT_CONTEXT, SpanKind, TraceState} from "@opentelemetry/api";
import assert from "node:assert"
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    Sampler,
    SamplingDecision,
    SamplingResult,
    SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {CoralogixAttributes} from "../../../src/trace/common";
import {isMatch} from 'lodash';

const NON_SAMPLED_ATTRIBUTE_NAME = 'non_sampled';

// Builds a tracer whose spans are collected through the real SDK export pipeline. This lets the
// tests assert on a span's recorded attributes via the public `ReadableSpan` contract
// (`InMemorySpanExporter.getFinishedSpans()`) instead of reaching into the span implementation.
function createTestTracer(sampler: Sampler = new CoralogixTransactionSampler()) {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
        sampler,
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    return {tracer: provider.getTracer('default'), exporter};
}

// Resolves the exported span that corresponds to `span` and returns its recorded attributes.
// Only sampled spans are exported, which is exactly the set of spans these tests inspect.
function exportedAttributes(exporter: InMemorySpanExporter, span: opentelemetry.Span): Attributes {
    const {spanId} = span.spanContext();
    const finished = exporter.getFinishedSpans().find(s => s.spanContext().spanId === spanId);
    assert.ok(finished, `expected span ${spanId} to have been exported`);
    return finished.attributes;
}

export default describe('CoralogixTransactionSampler', () => {
    let context: Context = ROOT_CONTEXT;

    beforeEach(() => {
        context = ROOT_CONTEXT;
    });

    describe('respect base sampler results', () => {
        const args: Parameters<CoralogixTransactionSampler['shouldSample']> = [ROOT_CONTEXT, 'trace-id', 'span-name', SpanKind.SERVER, {}, []];
        Object.values(SamplingDecision).map((decision) => {
            if (typeof decision === 'string') {
                return
            }
            it(`have same decision as base sampler - ${SamplingDecision[decision]}`, () => {
                const internalSampler = new TestAttributeSamplingSampler();
                const method = mock.method(internalSampler, 'shouldSample', () => ({
                    decision
                }));
                const sampler = new CoralogixTransactionSampler(internalSampler);
                const result = sampler.shouldSample(...args);
                assert.strictEqual(method.mock.callCount(), 1, 'internal sampler should have been called once');
                assert.deepStrictEqual(method.mock.calls?.[0]?.arguments, args, 'internal sampler should have been called with same args as CoralogixAttributeSampler');
                assert.strictEqual(result.decision, decision, `decision from CoralogixTransactionProcessor should be the same as internal sampler`);
            })
        })

        it(`have all attributes from base sampler results`, () => {
            const attributes: Attributes = {
                'string-attribute': 'string-value',
                'number-attribute': 123,
                'boolean-attribute': true,
            }
            const internalSampler = new TestAttributeSamplingSampler();
            const method = mock.method(internalSampler, 'shouldSample', () => ({
                decision: SamplingDecision.RECORD,
                attributes
            }));
            const sampler = new CoralogixTransactionSampler(internalSampler);
            const result = sampler.shouldSample(...args);
            assert.strictEqual(method.mock.callCount(), 1, 'internal sampler should have been called once');
            assert.deepStrictEqual(method.mock.calls?.[0]?.arguments, args, 'internal sampler should have been called with same args as CoralogixAttributeSampler');
            assert.ok(isMatch(result.attributes ?? {}, attributes), `result attributes must contain all attributes from internal sampler`);
        })

        it(`have all traceState attributes from base sampler results`, () => {
            const traceStateProps = {
                key1: 'value1',
                key2: 'value2',
            }
            const traceState: TraceState = Object.entries(traceStateProps)
                .reduce((traceState, [key, value]) =>
                        traceState.set(key, value),
                    createTraceState());
            const internalSampler = new TestAttributeSamplingSampler();
            const method = mock.method(internalSampler, 'shouldSample', () => ({
                decision: SamplingDecision.RECORD,
                traceState
            }));
            const sampler = new CoralogixTransactionSampler(internalSampler);
            const result = sampler.shouldSample(...args);
            assert.strictEqual(method.mock.callCount(), 1, 'internal sampler should have been called once');
            assert.deepStrictEqual(method.mock.calls?.[0]?.arguments, args, 'internal sampler should have been called with same args as CoralogixAttributeSampler');
            assert.ok(result.traceState, 'result trace state must not be empty');
            Object.entries(traceStateProps).forEach(([key, value]) => {
                assert.strictEqual(result.traceState!.get(key), value, `trace state must contain ${key}=${value}`);
            })
        })
    })

    describe('transaction attribute', () => {
        it('propagate transaction through spans', () => {
            const {tracer, exporter} = createTestTracer();

            const span1 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);

            span3.end();
            span2.end();
            span1.end();

            assert.strictEqual(exportedAttributes(exporter, span1)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'one',
                'span1 must create a transaction attribute');
            assert.strictEqual(exportedAttributes(exporter, span2)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'one',
                'span2 must have transaction attribute from parent');
            assert.strictEqual(exportedAttributes(exporter, span3)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'one',
                'span3 must have transaction attribute from parent');
        });

        it('propagate transaction attribute even if father is non recording', () => {
            const {tracer, exporter} = createTestTracer(new CoralogixTransactionSampler(new TestAttributeSamplingSampler()));

            const span1 = tracer.startSpan('one', {attributes: {[NON_SAMPLED_ATTRIBUTE_NAME]: 'true'}}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {attributes: {[NON_SAMPLED_ATTRIBUTE_NAME]: 'true'}}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);

            span3.end();
            span2.end();
            span1.end();

            assert.ok(!span1.isRecording(), 'span1 must not be recording');
            assert.ok(!span2.isRecording(), 'span2 must not be recording');
            assert.strictEqual(exportedAttributes(exporter, span3)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'one',
                'span3 must have transaction attribute from parent');
        });

        it('create new transaction after remote span is initiated', () => {
            const {tracer, exporter} = createTestTracer();

            const span1 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            context = getRemoteContext(context);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);
            const span4 = tracer.startSpan('four', {}, context);
            context = opentelemetry.trace.setSpan(context, span4);

            span4.end();
            span3.end();
            span2.end();
            span1.end();

            assert.strictEqual(exportedAttributes(exporter, span1)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'one',
                'span1 must create a transaction attribute');
            assert.strictEqual(exportedAttributes(exporter, span2)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'one',
                'span2 must have transaction attribute from parent');
            assert.strictEqual(exportedAttributes(exporter, span3)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'three',
                'span3 must create a new transaction attribute after the remote span');
            assert.strictEqual(exportedAttributes(exporter, span4)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'three',
                'span4 must have transaction attribute from parent');
        });
    })

    describe('distributed transaction attribute', () => {
        it('propagate distributed transaction through spans', () => {
            const {tracer, exporter} = createTestTracer();

            const span1 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);

            span3.end();
            span2.end();
            span1.end();

            assert.strictEqual(exportedAttributes(exporter, span1)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                'span1 must create a distributed transaction attribute');
            assert.strictEqual(exportedAttributes(exporter, span2)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                'span2 must have distributed transaction attribute from parent');
            assert.strictEqual(exportedAttributes(exporter, span3)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                'span3 must have distributed transaction attribute from parent');
        });

        it('propagate distributed transaction attribute even if father is non recording', () => {
            const {tracer, exporter} = createTestTracer(new CoralogixTransactionSampler(new TestAttributeSamplingSampler()));

            const span1 = tracer.startSpan('one', {attributes: {[NON_SAMPLED_ATTRIBUTE_NAME]: 'true'}}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {attributes: {[NON_SAMPLED_ATTRIBUTE_NAME]: 'true'}}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);

            span3.end();
            span2.end();
            span1.end();

            assert.ok(!span1.isRecording(), 'span1 must not be recording');
            assert.ok(!span2.isRecording(), 'span2 must not be recording');
            assert.strictEqual(exportedAttributes(exporter, span3)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                'span3 must have distributed transaction attribute from parent');
        });

        it('propagate distributed transaction through remote spans', () => {
            const {tracer, exporter} = createTestTracer();

            const span1 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            context = getRemoteContext(context);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);
            const span4 = tracer.startSpan('four', {}, context);
            context = opentelemetry.trace.setSpan(context, span4);

            span4.end();
            span3.end();
            span2.end();
            span1.end();

            assert.strictEqual(exportedAttributes(exporter, span1)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                'span1 must create a distributed transaction attribute');
            assert.strictEqual(exportedAttributes(exporter, span2)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                'span2 must have distributed transaction attribute from parent');
            assert.strictEqual(exportedAttributes(exporter, span3)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                'span3 must keep the distributed transaction attribute across the remote span');
            assert.strictEqual(exportedAttributes(exporter, span4)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                'span4 must have distributed transaction attribute from parent');
        });
    })

    describe('transaction root attribute', () => {
        it('add transaction root attribute to creator of transaction', () => {
            const {tracer, exporter} = createTestTracer();

            const span1 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);

            span3.end();
            span2.end();
            span1.end();

            assert.strictEqual(exportedAttributes(exporter, span1)[CoralogixAttributes.TRANSACTION_ROOT], true,
                'span1 must have transaction root');
            assert.ok(!(CoralogixAttributes.TRANSACTION_ROOT in exportedAttributes(exporter, span2)),
                'span2 must not have transaction root');
            assert.ok(!(CoralogixAttributes.TRANSACTION_ROOT in exportedAttributes(exporter, span3)),
                'span3 must not have transaction root');
        });

        it('add transaction root attribute span after remote', () => {
            const {tracer, exporter} = createTestTracer();

            const span1 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            context = getRemoteContext(context);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);
            const span4 = tracer.startSpan('four', {}, context);
            context = opentelemetry.trace.setSpan(context, span4);

            span4.end();
            span3.end();
            span2.end();
            span1.end();

            assert.strictEqual(exportedAttributes(exporter, span1)[CoralogixAttributes.TRANSACTION_ROOT], true,
                'span1 must have transaction root');
            assert.ok(!(CoralogixAttributes.TRANSACTION_ROOT in exportedAttributes(exporter, span2)),
                'span2 must not have transaction root');
            assert.strictEqual(exportedAttributes(exporter, span3)[CoralogixAttributes.TRANSACTION_ROOT], true,
                'span3 must have transaction root');
            assert.ok(!(CoralogixAttributes.TRANSACTION_ROOT in exportedAttributes(exporter, span4)),
                'span4 must not have transaction root');
        });

        it('span with same name as transaction span should not be root transaction', () => {
            const {tracer, exporter} = createTestTracer();

            const span1 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span2);

            span2.end();
            span1.end();

            assert.strictEqual(exportedAttributes(exporter, span1)[CoralogixAttributes.TRANSACTION_ROOT], true,
                'span1 must have transaction root');
            assert.ok(!(CoralogixAttributes.TRANSACTION_ROOT in exportedAttributes(exporter, span2)),
                'span2 must not have transaction root');
        });
    })

    class TestAttributeSamplingSampler implements Sampler {

        shouldSample(context: Context, traceId: string, spanName: string, spanKind: SpanKind, attributes: Attributes, _links: Link[]): SamplingResult {
            return {
                decision: attributes[NON_SAMPLED_ATTRIBUTE_NAME] ? SamplingDecision.NOT_RECORD : SamplingDecision.RECORD_AND_SAMPLED,
            };
        }

    }

    function getRemoteContext(context: Context): Context {
        const spanContext = opentelemetry.trace.getSpanContext(context);
        if (!spanContext) {
            return context;
        }
        const newSpanContext = {
            ...spanContext,
            isRemote: true,
        };
        return opentelemetry.trace.setSpanContext(context, newSpanContext);
    }

})
