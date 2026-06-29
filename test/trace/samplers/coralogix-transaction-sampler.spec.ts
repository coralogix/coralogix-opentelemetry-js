import {beforeEach, describe, it, mock} from "node:test";
import {CoralogixTransactionSampler} from "../../../src/trace/samplers";
import * as opentelemetry from "@opentelemetry/api";
import {Attributes, Context, createTraceState, Link, ROOT_CONTEXT, SpanKind, TraceState} from "@opentelemetry/api";
import assert from "node:assert"
import {
    BasicTracerProvider,
    ReadableSpan,
    Sampler,
    SamplingDecision,
    SamplingResult,
} from "@opentelemetry/sdk-trace-base";
import {CoralogixAttributes} from "../../../src/trace/common";
import {isMatch} from 'lodash';

// OTel 2.x no longer exports a concrete `Span` class to `instanceof` against, and the api `Span`
// type does not expose `.attributes`. Recording spans returned by the SDK implement `ReadableSpan`,
// so we read their recorded attributes through that type.
const attributesOf = (span: opentelemetry.Span): ReadableSpan['attributes'] =>
    (span as unknown as ReadableSpan).attributes;

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
            const tracerProvider = new BasicTracerProvider({
                sampler: new CoralogixTransactionSampler()
            });
            const tracer = tracerProvider.getTracer('default');

            const span1 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);

            if (span1.isRecording() && span2.isRecording() && span3.isRecording()) {
                assert.strictEqual(attributesOf(span1)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'one',
                    'span1 must created a transaction attribute');
                assert.strictEqual(attributesOf(span1)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'one',
                    'span2 must have transaction attribute from parent');
                assert.strictEqual(attributesOf(span3)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'one',
                    'span3 must have transaction attribute from parent');
            } else {
                assert.ok(span1.isRecording(), 'span1 must be instance of Span');
                assert.ok(span2.isRecording(), 'span2 must be instance of Span');
                assert.ok(span3.isRecording(), 'span3 must be instance of Span');
            }
            span3.end();
            span2.end();
            span1.end();
        });

        it('propagate transaction attribute even if father is non recording', () => {
            const tracerProvider = new BasicTracerProvider({
                sampler: new CoralogixTransactionSampler(new TestAttributeSamplingSampler())
            });
            const tracer = tracerProvider.getTracer('default');

            const span1 = tracer.startSpan('one', {attributes: {[NON_SAMPLED_ATTRIBUTE_NAME]: 'true'}}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {attributes: {[NON_SAMPLED_ATTRIBUTE_NAME]: 'true'}}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);

            if (!span1.isRecording() && !span2.isRecording() && span3.isRecording()) {
                assert.strictEqual(attributesOf(span3)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'one',
                    'span3 must have transaction attribute from parent');
            } else {
                assert.ok(!span1.isRecording(), 'span1 must no be recording');
                assert.ok(!span2.isRecording(), 'span2 must no be recording');
                assert.ok(span3.isRecording(), 'span3 must be instance of Span');
            }
            span3.end();
            span2.end();
            span1.end();
        });

        it('create new transaction after remote span is initiated', () => {
            const tracerProvider = new BasicTracerProvider({
                sampler: new CoralogixTransactionSampler()
            });
            const tracer = tracerProvider.getTracer('default');

            const span1 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            context = getRemoteContext(context);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);
            const span4 = tracer.startSpan('four', {}, context);
            context = opentelemetry.trace.setSpan(context, span4);

            if (span1.isRecording() && span2.isRecording() && span3.isRecording() && span4.isRecording()) {
                assert.strictEqual(attributesOf(span1)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'one',
                    'span1 must created a transaction attribute');
                assert.strictEqual(attributesOf(span1)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'one',
                    'span2 must have transaction attribute from parent');
                assert.strictEqual(attributesOf(span3)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'three',
                    'span3 must created a transaction attribute');
                assert.strictEqual(attributesOf(span4)[CoralogixAttributes.TRANSACTION_IDENTIFIER], 'three',
                    'span4 must have transaction attribute from parent');
            } else {
                assert.ok(span1.isRecording(), 'span1 must be instance of Span');
                assert.ok(span2.isRecording(), 'span2 must be instance of Span');
                assert.ok(span3.isRecording(), 'span3 must be instance of Span');
                assert.ok(span4.isRecording(), 'span4 must be instance of Span');
            }
            span4.end();
            span3.end();
            span2.end();
            span1.end();
        });
    })

    describe('distributed transaction attribute', () => {
        it('propagate distributed transaction through spans', () => {
            const tracerProvider = new BasicTracerProvider({
                sampler: new CoralogixTransactionSampler()
            });
            const tracer = tracerProvider.getTracer('default');

            const span1 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);

            if (span1.isRecording() && span2.isRecording() && span3.isRecording()) {
                assert.strictEqual(attributesOf(span1)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                    'span1 must created a distributed transaction attribute');
                assert.strictEqual(attributesOf(span1)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                    'span2 must have distributed transaction attribute from parent');
                assert.strictEqual(attributesOf(span3)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                    'span3 must have distributed transaction attribute from parent');
            } else {
                assert.ok(span1.isRecording(), 'span1 must be instance of Span');
                assert.ok(span2.isRecording(), 'span2 must be instance of Span');
                assert.ok(span3.isRecording(), 'span3 must be instance of Span');
            }
            span3.end();
            span2.end();
            span1.end();
        });

        it('propagate distributed transaction attribute even if father is non recording', () => {
            const tracerProvider = new BasicTracerProvider({
                sampler: new CoralogixTransactionSampler(new TestAttributeSamplingSampler())
            });
            const tracer = tracerProvider.getTracer('default');

            const span1 = tracer.startSpan('one', {attributes: {[NON_SAMPLED_ATTRIBUTE_NAME]: 'true'}}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {attributes: {[NON_SAMPLED_ATTRIBUTE_NAME]: 'true'}}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);

            if (!span1.isRecording() && !span2.isRecording() && span3.isRecording()) {
                assert.strictEqual(attributesOf(span3)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                    'span3 must have distributed transaction attribute from parent');
            } else {
                assert.ok(!span1.isRecording(), 'span1 must no be recording');
                assert.ok(!span2.isRecording(), 'span2 must no be recording');
                assert.ok(span3.isRecording(), 'span3 must be instance of Span');
            }
            span3.end();
            span2.end();
            span1.end();

        });

        it('propagate distributed transaction through remote spans', () => {
            const tracerProvider = new BasicTracerProvider({
                sampler: new CoralogixTransactionSampler()
            });
            const tracer = tracerProvider.getTracer('default');

            const span1 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            context = getRemoteContext(context);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);
            const span4 = tracer.startSpan('four', {}, context);
            context = opentelemetry.trace.setSpan(context, span4);

            if (span1.isRecording() && span2.isRecording() && span3.isRecording() && span4.isRecording()) {
                assert.strictEqual(attributesOf(span1)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                    'span1 must created a transaction attribute');
                assert.strictEqual(attributesOf(span1)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                    'span2 must have distributed transaction attribute from parent');
                assert.strictEqual(attributesOf(span3)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                    'span2 must have distributed transaction attribute from parent');
                assert.strictEqual(attributesOf(span4)[CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER], 'one',
                    'span4 must have distributed transaction attribute from parent');
            } else {
                assert.ok(span1.isRecording(), 'span1 must be instance of Span');
                assert.ok(span2.isRecording(), 'span2 must be instance of Span');
                assert.ok(span3.isRecording(), 'span3 must be instance of Span');
                assert.ok(span4.isRecording(), 'span4 must be instance of Span');
            }
            span4.end();
            span3.end();
            span2.end();
            span1.end();
        });
    })

    describe('transaction root attribute', () => {
        it('add transaction root attribute to creator of transaction', () => {
            const tracerProvider = new BasicTracerProvider({
                sampler: new CoralogixTransactionSampler()
            });
            const tracer = tracerProvider.getTracer('default');

            const span1 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);

            if (span1.isRecording() && span2.isRecording() && span3.isRecording()) {
                assert.strictEqual(attributesOf(span1)[CoralogixAttributes.TRANSACTION_ROOT], true,
                    'span1 must have transaction root');
                assert.ok(!(CoralogixAttributes.TRANSACTION_ROOT in attributesOf(span2)),
                    'span2 must not have transaction root');
                assert.ok(!(CoralogixAttributes.TRANSACTION_ROOT in attributesOf(span3)),
                    'span3 must not have transaction root');
            } else {
                assert.ok(span1.isRecording(), 'span1 must be instance of Span');
                assert.ok(span2.isRecording(), 'span2 must be instance of Span');
                assert.ok(span3.isRecording(), 'span3 must be instance of Span');
            }
            span3.end();
            span2.end();
            span1.end();
        });

        it('add transaction root attribute span after remote', () => {
            const tracerProvider = new BasicTracerProvider({
                sampler: new CoralogixTransactionSampler()
            });
            const tracer = tracerProvider.getTracer('default');

            const span1 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('two', {}, context);
            context = opentelemetry.trace.setSpan(context, span2);
            context = getRemoteContext(context);
            const span3 = tracer.startSpan('three', {}, context);
            context = opentelemetry.trace.setSpan(context, span3);
            const span4 = tracer.startSpan('four', {}, context);
            context = opentelemetry.trace.setSpan(context, span4);

            if (span1.isRecording() && span2.isRecording() && span3.isRecording() && span4.isRecording()) {
                assert.strictEqual(attributesOf(span1)[CoralogixAttributes.TRANSACTION_ROOT], true,
                    'span1 must have transaction root');
                assert.ok(!(CoralogixAttributes.TRANSACTION_ROOT in attributesOf(span2)),
                    'span2 must not have transaction root');
                assert.strictEqual(attributesOf(span3)[CoralogixAttributes.TRANSACTION_ROOT], true,
                    'span3 must have transaction root');
                assert.ok(!(CoralogixAttributes.TRANSACTION_ROOT in attributesOf(span4)),
                    'span4 must not have transaction root');
            } else {
                assert.ok(span1.isRecording(), 'span1 must be instance of Span');
                assert.ok(span2.isRecording(), 'span2 must be instance of Span');
                assert.ok(span3.isRecording(), 'span3 must be instance of Span');
                assert.ok(span4.isRecording(), 'span4 must be instance of Span');
            }
            span4.end();
            span3.end();
            span2.end();
            span1.end();
        });

        it('span with same name as transaction span should not be root transaction', () => {
            const tracerProvider = new BasicTracerProvider({
                sampler: new CoralogixTransactionSampler()
            });
            const tracer = tracerProvider.getTracer('default');

            const span1 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span1);
            const span2 = tracer.startSpan('one', {}, context);
            context = opentelemetry.trace.setSpan(context, span2);

            if (span1.isRecording() && span2.isRecording()) {
                assert.strictEqual(attributesOf(span1)[CoralogixAttributes.TRANSACTION_ROOT], true,
                    'span1 must have transaction root');
                assert.ok(!(CoralogixAttributes.TRANSACTION_ROOT in attributesOf(span2)),
                    'span1 must not have transaction root');
            } else {
                assert.ok(span1.isRecording(), 'span1 must be instance of Span');
                assert.ok(span2.isRecording(), 'span2 must be instance of Span');
            }
            span2.end();
            span1.end();
        });
    })

    const NON_SAMPLED_ATTRIBUTE_NAME = 'non_sampled';

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