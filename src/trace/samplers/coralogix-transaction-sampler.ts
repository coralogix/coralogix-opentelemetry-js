import { AlwaysOnSampler, ParentBasedSampler, Sampler, SamplingResult } from "@opentelemetry/sdk-trace-base";
import { Attributes, Context, createTraceState, diag, Link, SpanKind } from "@opentelemetry/api";
import * as opentelemetry from "@opentelemetry/api";
import {CoralogixAttributes, CoralogixTraceState} from "../common";
import type express from 'express';

export interface RouteMapping {
    regex: RegExp,
    path: string,
}

export class CoralogixTransactionSampler implements Sampler {
    private readonly baseSampler: Sampler;
    private routes: RouteMapping[] = [];

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



    private _getPathFromRoutes(path: string): string | undefined {
        return this.routes.find(route => route.regex.test(path))?.path;
    }

    private _buildTransactionNameFromExpressPath(path: string, spanName: string): string {
        return `${spanName} ${path}`;
    }



    setExpressApp(app: express.Application): void{
        const routes: any[] = [];

        app._router.stack.forEach((middleware: any) => {
            if (middleware.route) {
                // routes registered directly on the app
                routes.push({
                    path: middleware.route.path,
                    regex: middleware.regexp,
                });
            } else if (middleware.name === 'router') {
                // router middleware
                const stack = middleware?.handle?.stack ?? middleware?.handle?.__original?.stack;
                stack.forEach((handler: any) => {
                    const route = handler.route;
                    if (route) {
                        routes.push({
                            path: route.path,
                            regex: handler.regexp,
                        });
                    }
                });
            }
        });

        this.routes = [...this.routes, ...routes];
    }

    shouldSample(context: Context, traceId: string, spanName: string, spanKind: SpanKind, attributes: Attributes, links: Link[]): SamplingResult {
        const result = this.baseSampler.shouldSample(context, traceId, spanName, spanKind, attributes, links);
        try {
            const spanContext = opentelemetry.trace.getSpanContext(context);

            const httpTarget = attributes?.['http.target']?.toString();
            const path = this._getPathFromRoutes(httpTarget ?? '');

            const transactionName = path ? this._buildTransactionNameFromExpressPath(path, spanName) : spanName;

            const distributedTransaction = spanContext?.traceState?.get(CoralogixTraceState.DISTRIBUTED_TRANSACTION_IDENTIFIER) ?? transactionName;

            const existingTransaction = spanContext?.traceState?.get(CoralogixTraceState.TRANSACTION_IDENTIFIER);

            const startsTransaction = existingTransaction === undefined || spanContext?.isRemote;

            const transaction = startsTransaction ? transactionName : existingTransaction;

            let { attributes: resultAttributes, traceState } = result;
            const { decision } = result;

            traceState = (traceState ?? createTraceState())
                .set(CoralogixTraceState.TRANSACTION_IDENTIFIER, transaction)
                .set(CoralogixTraceState.DISTRIBUTED_TRANSACTION_IDENTIFIER, distributedTransaction);

            resultAttributes = {
                ...(resultAttributes ?? {}),
                [CoralogixAttributes.TRANSACTION_IDENTIFIER]: transaction,
                [CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER]: distributedTransaction,
                [CoralogixAttributes.TRANSACTION_ROOT]: startsTransaction ?? undefined
            };

            return {
                decision,
                attributes: resultAttributes,
                traceState
            };
        } catch (error) {
            diag.debug('CoralogixTransactionSampler failed, returning original sampler result', error);
            return result;
        }
    }
}
