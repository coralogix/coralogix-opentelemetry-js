import {Sampler, SamplingResult} from "@opentelemetry/sdk-trace-base";
import {buildSamplerFromEnv} from "@opentelemetry/sdk-trace-base/build/esnext/config";
import {Attributes, Context, createTraceState, Link, SpanKind} from "@opentelemetry/api";
import * as opentelemetry from "@opentelemetry/api";
import {CoralogixAttributes, CoralogixTraceState} from "../common";

export class CoralogixTransactionSampler implements Sampler {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    private readonly baseSampler: Sampler;

    constructor(baseSampler?: Sampler) {
        this.baseSampler = baseSampler ?? buildSamplerFromEnv();
    }

    shouldSample(context: Context, traceId: string, spanName: string, spanKind: SpanKind, attributes: Attributes, links: Link[]): SamplingResult {
        const result = this.baseSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
        const spanContext = opentelemetry.trace.getSpanContext(context);

        // if distributed transaction exists, use it, if not this is the first span and thus the root of the distributed transaction
        const distributedTransaction = spanContext?.traceState?.get(CoralogixTraceState.DISTRIBUTED_TRANSACTION_IDENTIFIER) ?? spanName;

        // if span is remote, then start a new transaction, else try to use existing transaction
        const transaction = spanContext?.isRemote ? spanName :
            (spanContext?.traceState?.get(CoralogixTraceState.TRANSACTION_IDENTIFIER) ?? spanName)

        let {attributes: resultAttributes, traceState} = result;
        const {decision} = result;

        traceState = (traceState ?? createTraceState())
            .set(CoralogixTraceState.TRANSACTION_IDENTIFIER, transaction)
            .set(CoralogixTraceState.DISTRIBUTED_TRANSACTION_IDENTIFIER, distributedTransaction);

        resultAttributes = {
            ...(resultAttributes ?? {}),
            [CoralogixAttributes.TRANSACTION_IDENTIFIER]: transaction,
            [CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER]: distributedTransaction
        }

        return {
            decision,
            attributes: resultAttributes,
            traceState
        }
    }

}