import {AlwaysOnSampler, ParentBasedSampler, Sampler, SamplingResult} from "@opentelemetry/sdk-trace-base";
import {Attributes, Context, createTraceState, diag, Link, SpanKind} from "@opentelemetry/api";
import * as opentelemetry from "@opentelemetry/api";
import {CoralogixAttributes, CoralogixTraceState} from "../common";
import type express from 'express';
import {ILayer} from "express-serve-static-core";
import {SEMATTRS_HTTP_TARGET} from "@opentelemetry/semantic-conventions";

export interface RouteMapping {
    regex: RegExp,
    path: string,
}

interface Stack {
    route: { path: string },
    regexp: RegExp
}

interface Handle {
    stack?: Stack[],
    __original?: { stack: Stack[] },
}

interface Handler {
    handle: Handle,
    name?: string,
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

    private _isMiddlewareILayer(middleware: Handler | ILayer): middleware is ILayer {
        return "route" in middleware ? middleware?.route !== undefined : false;
    }


    private _isMiddlewareHandler(middleware: ILayer | Handler): middleware is Handler {
        return middleware?.name === 'router';
    }

    setExpressApp(app: express.Application): void {
        const routes: RouteMapping[] = [];

        app._router.stack.forEach((middleware: Handler | ILayer) => {
            if (this._isMiddlewareILayer(middleware)) {
                // routes registered directly on the app
                if (middleware.route?.path)
                    routes.push({
                        path: middleware.route.path,
                        regex: middleware.regexp,
                    });
            } else if (this._isMiddlewareHandler(middleware)) {
                // router middleware
                const handle = middleware?.handle;
                const stack = handle?.stack ?? handle?.__original?.stack;
                stack && stack.forEach((handler) => {
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

            const httpTarget = attributes?.[SEMATTRS_HTTP_TARGET]?.toString();
            const path = this._getPathFromRoutes(httpTarget ?? '');

            const transactionName = path ? this._buildTransactionNameFromExpressPath(path, spanName) : spanName;

            const distributedTransaction = spanContext?.traceState?.get(CoralogixTraceState.DISTRIBUTED_TRANSACTION_IDENTIFIER) ?? transactionName;

            const existingTransaction = spanContext?.traceState?.get(CoralogixTraceState.TRANSACTION_IDENTIFIER);

            const startsTransaction = existingTransaction === undefined || spanContext?.isRemote;

            const transaction = startsTransaction ? transactionName : existingTransaction;

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
