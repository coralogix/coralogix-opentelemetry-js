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
    // Express 4: per-layer cache of the mount regexp recompiled with the `d` (hasIndices) flag,
    // used to locate capture groups by position rather than by value.
    private readonly indexedRegexpCache = new WeakMap<Layer, RegExp>();
    // Express 5: per-layer cache mapping each prefix segment index to the param name it carries
    // (absent = static segment). Keyed alongside the segment count so a differently-shaped match
    // (e.g. a wildcard mount) recomputes instead of reusing a stale plan.
    private readonly express5PlanCache = new WeakMap<Layer, { segmentCount: number, plan: Map<number, string> }>();

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

    // Reverse-substitute an Express 4 mount prefix to its template using capture-group positions.
    // The compiled mount regexp is anchored at `^`, so capture-group offsets map directly onto the
    // matched prefix. Positional substitution (rather than `String.replace` by value) is required
    // because a param value can equal an earlier static segment (e.g. `/v/:ver` matching `/v/v`).
    private _templatizeExpress4(layer: Layer, path: string, rawMatched: string): string {
        const keys = layer.keys ?? [];
        if (keys.length === 0 || !layer.regexp) return rawMatched.replace(/\/$/, '');

        let indexedRegexp = this.indexedRegexpCache.get(layer);
        if (!indexedRegexp) {
            const {source, flags} = layer.regexp;
            indexedRegexp = new RegExp(source, flags.includes('d') ? flags : `${flags}d`);
            this.indexedRegexpCache.set(layer, indexedRegexp);
        }

        const match = indexedRegexp.exec(path) as (RegExpExecArray & { indices?: Array<[number, number] | undefined> }) | null;
        const indices = match?.indices;
        if (!indices) return rawMatched.replace(/\/$/, '');

        // Substitute from right to left so earlier offsets stay valid as the string is spliced.
        const spans = keys
            .map((key, index) => ({span: indices[index + 1], name: String(key.name)}))
            .filter((entry): entry is { span: [number, number], name: string } => entry.span !== undefined)
            .sort((a, b) => b.span[0] - a.span[0]);

        let template = rawMatched;
        for (const {span, name} of spans) {
            template = `${template.slice(0, span[0])}:${name}${template.slice(span[1])}`;
        }
        return template.replace(/\/$/, '');
    }

    // Reverse-substitute an Express 5 mount prefix to its template. Express 5 layers expose only a
    // matcher function (no regexp/keys), so param positions are discovered by probing: replacing one
    // prefix segment at a time with a sentinel and checking which param the matcher reports it as.
    // The resulting segment->param plan is cached per layer since the mount template is invariant.
    private _templatizeExpress5(layer: Layer, matcher: (path: string) => PathMatch | false, fullPath: string, result: PathMatch): string {
        const {path: matchedPath, params} = result;
        if (!params || Object.keys(params).length === 0) return matchedPath;

        const segments = matchedPath.split('/');
        let cached = this.express5PlanCache.get(layer);
        if (!cached || cached.segmentCount !== segments.length) {
            cached = {segmentCount: segments.length, plan: this._computeExpress5Plan(matcher, fullPath, matchedPath)};
            this.express5PlanCache.set(layer, cached);
        }

        return segments
            .map((segment, index) => {
                const name = cached!.plan.get(index);
                return name !== undefined ? `:${name}` : segment;
            })
            .join('/');
    }

    private _computeExpress5Plan(matcher: (path: string) => PathMatch | false, fullPath: string, matchedPath: string): Map<number, string> {
        const remainder = fullPath.slice(matchedPath.length);
        const segments = matchedPath.split('/');
        const plan = new Map<number, string>();
        for (let index = 0; index < segments.length; index++) {
            if (segments[index] === '') continue;
            const sentinel = `cgxprobe${index}`;
            const probeSegments = segments.slice();
            probeSegments[index] = sentinel;
            const probe = matcher(probeSegments.join('/') + remainder);
            if (probe && probe.params) {
                const hit = Object.entries(probe.params).find(([, value]) => value === sentinel);
                if (hit) plan.set(index, hit[0]);
            }
        }
        return plan;
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
                        template: this._templatizeExpress5(layer, matcher, path, result),
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
            const rawMatched = match[0] ?? '';
            const consumedLength = rawMatched.replace(/\/$/, '').length;
            const rest = path.slice(consumedLength);
            return {
                template: this._templatizeExpress4(layer, path, rawMatched),
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
