import {AlwaysOnSampler, ParentBasedSampler, Sampler, SamplingResult} from "@opentelemetry/sdk-trace-base";
import {Attributes, Context, createTraceState, diag, Link, SpanKind} from "@opentelemetry/api";
import * as opentelemetry from "@opentelemetry/api";
import {CoralogixAttributes, CoralogixTraceState} from "../common";
import type express from 'express';
import {ILayer} from "express-serve-static-core";
import {ATTR_URL_PATH} from "@opentelemetry/semantic-conventions";

// `http.target` is the legacy (pre-stability) HTTP attribute. It was removed from the stable
// semantic-conventions entry point in favour of `url.path`, but instrumentations that have not
// opted into stable HTTP semconv (OTEL_SEMCONV_STABILITY_OPT_IN) still emit it. Read the stable
// `url.path` first and fall back to the legacy attribute so route resolution works in every mode.
const ATTR_HTTP_TARGET_LEGACY = "http.target";

export interface RouteMapping {
    matches: (path: string) => boolean,
    path: string,
}

interface Stack {
    route: { path: string },
    regexp?: RegExp,
    match?: (path: string) => boolean,
}

interface Handle {
    stack?: Stack[],
    __original?: { stack: Stack[] },
}

interface Handler {
    handle: Handle,
    name?: string,
}

interface RouterLike {
    stack: (Handler | ILayer)[],
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
        const pathname = path.replace(/[?#].*$/, '');
        return this.routes.find(route => route.matches(pathname))?.path;
    }

    // Express 4 layers have `regexp`; Express 5 (router@2.x) replaced it with `match(path)`.
    private _buildMatcher(layer: { regexp?: RegExp, match?: (path: string) => boolean }): (path: string) => boolean {
        if (layer.regexp) return (p) => layer.regexp!.test(p);
        if (layer.match) return layer.match.bind(layer);
        return () => false;
    }

    private _buildTransactionNameFromExpressPath(path: string, spanName: string): string {
        return `${spanName} ${path}`;
    }

    private _isMiddlewareILayer(middleware: Handler | ILayer): middleware is ILayer {
        return "route" in middleware && !!middleware?.route;
    }

    private _isMiddlewareHandler(middleware: ILayer | Handler): middleware is Handler {
        return middleware?.name === 'router';
    }

    setExpressApp(app: express.Application): void {
        const routes: RouteMapping[] = [];

        // @types/express v4 types app.router as a deprecated string; cast to reach both v4/v5 shapes.
        // Read `_router` first: on Express 4 it holds the router stack, while `app.router`
        // is a getter that THROWS ("'app.router' is deprecated!"). On Express 5 `_router`
        // is undefined, so we fall back to the public `app.router` getter.
        const compat = app as unknown as { router?: RouterLike; _router?: RouterLike };
        const expressRouter = compat._router ?? compat.router;
        if (!expressRouter?.stack) {
            diag.warn('CoralogixTransactionSampler.setExpressApp: could not find the Express router stack, route templates will not be resolved');
            return;
        }

        expressRouter.stack.forEach((middleware: Handler | ILayer) => {
            if (this._isMiddlewareILayer(middleware)) {
                // routes registered directly on the app
                if (middleware.route?.path)
                    routes.push({
                        path: middleware.route.path,
                        matches: this._buildMatcher(middleware),
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
                            matches: this._buildMatcher(handler),
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

            const httpTarget = (attributes?.[ATTR_URL_PATH] ?? attributes?.[ATTR_HTTP_TARGET_LEGACY])?.toString();
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
