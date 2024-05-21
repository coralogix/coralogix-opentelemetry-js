import {AlwaysOnSampler, ParentBasedSampler, Sampler, SamplingResult} from "@opentelemetry/sdk-trace-base";
import {Attributes, Context, createTraceState, diag, Link, SpanKind} from "@opentelemetry/api";
import * as opentelemetry from "@opentelemetry/api";
import {CoralogixAttributes, CoralogixTraceState} from "../common";
import { getRPCMetadata, RPCType } from '@opentelemetry/core';

export class CoralogixTransactionSampler implements Sampler {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    private readonly baseSampler: Sampler;

    constructor(baseSampler?: Sampler) {
        if (baseSampler) {
            this.baseSampler = baseSampler;
        } else {
            diag.debug(`CoralogixTransactionSampler: no base sampler specified, defaulting to parent base always on sampler`);
            this.baseSampler = new ParentBasedSampler({
                root: new AlwaysOnSampler(),
            });
        }
    }

    shouldSample(context: Context, traceId: string, spanName: string, spanKind: SpanKind, attributes: Attributes, links: Link[]): SamplingResult {
        const result = this.baseSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
        try {
            const spanContext = opentelemetry.trace.getSpanContext(context);

            // if distributed transaction exists, use it, if not this is the first span and thus the root of the distributed transaction
            const distributedTransaction = spanContext?.traceState?.get(CoralogixTraceState.DISTRIBUTED_TRANSACTION_IDENTIFIER) ?? spanName;

            const existingTransaction = spanContext?.traceState?.get(CoralogixTraceState.TRANSACTION_IDENTIFIER);

            // if span is remote, then start a new transaction, else try to use existing transaction
            const startsTransaction = existingTransaction === undefined || spanContext?.isRemote;

            let transaction = startsTransaction ? spanName : existingTransaction;
            const rpcMeta = getRPCMetadata(context);
            if(rpcMeta?.route && rpcMeta?.route !== '/' && rpcMeta?.type === RPCType.HTTP) {
                const parentSpan = rpcMeta.span;
                transaction = `${existingTransaction ?? 'GET'} ${rpcMeta?.route}`;
                parentSpan.setAttribute(CoralogixTraceState.TRANSACTION_IDENTIFIER, transaction)
            }

            let {attributes: resultAttributes, traceState} = result;
            const {decision} = result;

            traceState = (traceState ?? createTraceState())
                .set(CoralogixTraceState.TRANSACTION_IDENTIFIER, transaction)
                .set(CoralogixTraceState.DISTRIBUTED_TRANSACTION_IDENTIFIER, distributedTransaction);

            resultAttributes = {
                ...(resultAttributes ?? {}),
                [CoralogixAttributes.TRANSACTION_IDENTIFIER]: transaction,
                [CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER]: distributedTransaction,
                [CoralogixAttributes.TRANSACTION_ROOT]: startsTransaction ?? undefined
            }

            return {
                decision,
                attributes: resultAttributes,
                traceState
            }
        } catch (error) {
            diag.debug('CoralogixTransactionSampler failed, returning original sampler result', error);
            return result;
        }
    }

}