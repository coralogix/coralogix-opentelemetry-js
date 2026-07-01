import {AlwaysOnSampler, ParentBasedSampler, Sampler, SamplingResult} from "@opentelemetry/sdk-trace-base";
import {Attributes, Context, createTraceState, diag, Link, SpanKind} from "@opentelemetry/api";
import * as opentelemetry from "@opentelemetry/api";
import {CoralogixAttributes, CoralogixTraceState} from "../common";
import type express from 'express';
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

interface RegExpLike extends RegExp {
    fast_slash?: boolean;
}

interface PathMatch {
    path: string;
    params?: Record<string, unknown>;
}

interface Layer {
    name?: string;
    route?: { path: string };
    handle?: Handle;
    regexp?: RegExpLike;
    keys?: { name: string | number }[];
    matchers?: ((path: string) => PathMatch | false)[];
    match?: (path: string) => unknown;
    slash?: boolean;
}

interface Handle {
    stack?: Layer[];
    __original?: { stack: Layer[] };
}

interface RouterLike {
    stack: Layer[];
}

interface RouteChain {
    mounts: Layer[];
    leaf: Layer;
    leafPath: string;
}

export class CoralogixTransactionSampler implements Sampler {
    private readonly baseSampler: Sampler;
    private routeChains: RouteChain[] = [];

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
        for (const chain of this.routeChains) {
            const resolved = this._resolveChain(chain, pathname);
            if (resolved !== undefined) return resolved;
        }
        return undefined;
    }

    // Express 4 layers have `regexp`; Express 5 (router@2.x) replaced it with `match(path)`
    // which returns a match object (or false) rather than a boolean.
    private _buildMatcher(layer: Layer): (path: string) => boolean {
        if (layer.regexp) return (p) => layer.regexp!.test(p);
        if (layer.match) {
            const match = layer.match.bind(layer);
            return (p) => !!match(p);
        }
        return () => false;
    }

    private _buildTransactionNameFromExpressPath(path: string, spanName: string): string {
        return `${spanName} ${path}`;
    }

    private _isRouterLayer(layer: Layer): boolean {
        return layer.name === 'router' && !!(layer.handle?.stack ?? layer.handle?.__original?.stack);
    }

    private _collectChains(stack: Layer[], mounts: Layer[], out: RouteChain[]): void {
        for (const layer of stack) {
            if (layer.route?.path !== undefined) {
                out.push({mounts: mounts.slice(), leaf: layer, leafPath: layer.route.path});
            } else if (this._isRouterLayer(layer)) {
                const inner = layer.handle?.stack ?? layer.handle?.__original?.stack;
                if (inner) this._collectChains(inner, mounts.concat(layer), out);
            }
        }
    }

    // Rebuild a route template segment by substituting concrete param values back to `:name`,
    // e.g. matched `/v/2` with params {ver: '2'} becomes `/v/:ver`.
    private _templatizeParams(matchedPath: string, params?: Record<string, unknown>): string {
        let template = matchedPath;
        for (const [name, value] of Object.entries(params ?? {})) {
            if (typeof value === 'string' && value.length > 0) {
                template = template.replace(`/${value}`, `/:${name}`);
            }
        }
        return template;
    }

    // Consume the portion of `path` matched by a mount layer, returning the prefix template
    // (params reverse-substituted) and the remaining path for deeper layers.
    private _peelMount(layer: Layer, path: string): { template: string, remainder: string } | undefined {
        // Path-less mount (`app.use(router)`): contributes no prefix, path passes through.
        if (layer.slash === true || layer.regexp?.fast_slash === true) {
            return {template: '', remainder: path};
        }
        // Express 5: matchers return the matched concrete prefix and params.
        if (layer.matchers) {
            for (const matcher of layer.matchers) {
                const result = matcher(path);
                if (result) {
                    const rest = path.slice(result.path.length);
                    return {
                        template: this._templatizeParams(result.path, result.params),
                        remainder: rest.length > 0 ? rest : '/',
                    };
                }
            }
            return undefined;
        }
        // Express 4: the mount regexp matches the prefix; keys name the capture groups.
        if (layer.regexp) {
            const match = layer.regexp.exec(path);
            if (!match) return undefined;
            const matched = (match[0] ?? '').replace(/\/$/, '');
            const params: Record<string, unknown> = {};
            (layer.keys ?? []).forEach((key, index) => {
                params[String(key.name)] = match[index + 1];
            });
            const rest = path.slice(matched.length);
            return {
                template: this._templatizeParams(matched, params),
                remainder: rest.length > 0 ? rest : '/',
            };
        }
        return undefined;
    }

    private _resolveChain(chain: RouteChain, fullPath: string): string | undefined {
        let remainder = fullPath;
        let prefix = '';
        for (const mount of chain.mounts) {
            const peeled = this._peelMount(mount, remainder);
            if (!peeled) return undefined;
            prefix += peeled.template;
            remainder = peeled.remainder;
        }
        return this._buildMatcher(chain.leaf)(remainder) ? prefix + chain.leafPath : undefined;
    }

    setExpressApp(app: express.Application): void {
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

        const chains: RouteChain[] = [];
        this._collectChains(expressRouter.stack, [], chains);
        this.routeChains = [...this.routeChains, ...chains];
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
