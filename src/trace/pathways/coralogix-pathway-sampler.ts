import {Attributes, Context, createTraceState, diag, Link, SpanContext, SpanKind, trace, TraceState} from "@opentelemetry/api";
import {AlwaysOnSampler, ParentBasedSampler, Sampler, SamplingResult} from "@opentelemetry/sdk-trace-base";
import {CoralogixAttributes} from "../common";
import {PathwayAttributes, PathwayTraceState, UNKNOWN_CALLER} from "./pathway-attributes";
import {pathwayId} from "./pathway-hash";

export const DEFAULT_MAX_PATHWAY_DEPTH = 10;
const MAX_TRACE_STATE_VALUE_LENGTH = 256;

export interface CoralogixPathwaySamplerOptions {
    serviceName?: string;
    delegate?: Sampler;
    maxDepth?: number;
}

interface InheritedPathway {
    rootService: string;
    rootTransaction: string;
    caller: string;
    id: string;
    depth: number;
}

export class CoralogixPathwaySampler implements Sampler {
    private readonly serviceName: string;
    private readonly delegate: Sampler;
    private readonly maxDepth: number;

    constructor(options: CoralogixPathwaySamplerOptions = {}) {
        this.serviceName = options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'unknown_service';
        this.delegate = options.delegate ?? new ParentBasedSampler({root: new AlwaysOnSampler()});
        this.maxDepth = options.maxDepth ?? DEFAULT_MAX_PATHWAY_DEPTH;
    }

    shouldSample(context: Context, traceId: string, spanName: string, spanKind: SpanKind, attributes: Attributes, links: Link[]): SamplingResult {
        const result = this.delegate.shouldSample(context, traceId, spanName, spanKind, attributes, links);
        try {
            const parent = trace.getSpanContext(context);
            const merged = mergeTraceState(parent?.traceState, result.traceState);
            const isEntry = parent === undefined || parent.isRemote === true;
            if (isEntry) {
                return this.entryResult(result, parent, merged, spanName);
            }
            return this.localResult(result, merged, spanKind);
        } catch (error) {
            diag.debug('CoralogixPathwaySampler failed, returning delegate result', error);
            return result;
        }
    }

    toString(): string {
        return `CoralogixPathwaySampler{${this.delegate.toString()}}`;
    }

    private entryResult(result: SamplingResult, parent: SpanContext | undefined, traceState: TraceState, spanName: string): SamplingResult {
        const inherited = readInheritedPathway(parent?.traceState);
        const reentry = inherited !== undefined && inherited.caller === this.serviceName;
        const atMaxDepth = inherited !== undefined && inherited.depth >= this.maxDepth;

        const rootService = inherited?.rootService ?? this.serviceName;
        const rootTransaction = inherited?.rootTransaction ?? transactionName(result.attributes, spanName);
        const keepsParentNode = inherited !== undefined && (reentry || atMaxDepth);
        const id = keepsParentNode ? inherited.id : pathwayId(this.serviceName, inherited?.id);
        const depth = inherited === undefined ? 0 : keepsParentNode ? inherited.depth : inherited.depth + 1;

        const nextTraceState = traceState
            .set(PathwayTraceState.ROOT_SERVICE, sanitize(rootService))
            .set(PathwayTraceState.ROOT_TRANSACTION, sanitize(rootTransaction))
            .set(PathwayTraceState.CALLER, sanitize(this.serviceName))
            .set(PathwayTraceState.ID, id)
            .set(PathwayTraceState.DEPTH, String(depth));

        const pathwayAttributes: Attributes = {
            [PathwayAttributes.ENTRY]: !keepsParentNode,
            [PathwayAttributes.ROOT]: inherited === undefined,
            [PathwayAttributes.ROOT_SERVICE]: rootService,
            [PathwayAttributes.ROOT_TRANSACTION]: rootTransaction,
            [PathwayAttributes.ID]: id,
            [PathwayAttributes.DEPTH]: depth,
        };
        if (parent !== undefined) {
            pathwayAttributes[PathwayAttributes.CALLER] = inherited?.caller ?? UNKNOWN_CALLER;
        }
        if (inherited !== undefined && !keepsParentNode) {
            pathwayAttributes[PathwayAttributes.PARENT_ID] = inherited.id;
        }

        return {
            decision: result.decision,
            attributes: {...(result.attributes ?? {}), ...pathwayAttributes},
            traceState: nextTraceState,
        };
    }

    private localResult(result: SamplingResult, traceState: TraceState, spanKind: SpanKind): SamplingResult {
        const local = readInheritedPathway(traceState);
        if (local === undefined || (spanKind !== SpanKind.CLIENT && spanKind !== SpanKind.PRODUCER)) {
            return {...result, traceState};
        }
        return {
            decision: result.decision,
            attributes: {
                ...(result.attributes ?? {}),
                [PathwayAttributes.ROOT_SERVICE]: local.rootService,
                [PathwayAttributes.ROOT_TRANSACTION]: local.rootTransaction,
                [PathwayAttributes.ID]: local.id,
                [PathwayAttributes.DEPTH]: local.depth,
            },
            traceState,
        };
    }
}

function readInheritedPathway(traceState: TraceState | undefined): InheritedPathway | undefined {
    const id = traceState?.get(PathwayTraceState.ID);
    if (traceState === undefined || id === undefined) {
        return undefined;
    }
    const depth = Number(traceState.get(PathwayTraceState.DEPTH));
    return {
        rootService: traceState.get(PathwayTraceState.ROOT_SERVICE) ?? UNKNOWN_CALLER,
        rootTransaction: traceState.get(PathwayTraceState.ROOT_TRANSACTION) ?? UNKNOWN_CALLER,
        caller: traceState.get(PathwayTraceState.CALLER) ?? UNKNOWN_CALLER,
        id,
        depth: Number.isInteger(depth) && depth >= 0 ? depth : 0,
    };
}

function transactionName(attributes: Attributes | undefined, spanName: string): string {
    const fromTransactionSampler = attributes?.[CoralogixAttributes.TRANSACTION_IDENTIFIER];
    return typeof fromTransactionSampler === 'string' ? fromTransactionSampler : spanName;
}

function mergeTraceState(parent: TraceState | undefined, overlay: TraceState | undefined): TraceState {
    if (overlay === undefined) {
        return parent ?? createTraceState();
    }
    if (parent === undefined) {
        return overlay;
    }
    return overlay
        .serialize()
        .split(',')
        .map((member) => member.split('='))
        .reverse()
        .reduce((state, [key, value]) => (key && value !== undefined ? state.set(key.trim(), value.trim()) : state), parent);
}

function sanitize(value: string): string {
    const printable = value.replace(/[^\x20-\x7e]|[,=]/g, '_').slice(0, MAX_TRACE_STATE_VALUE_LENGTH).trimEnd();
    return printable.length > 0 ? printable : UNKNOWN_CALLER;
}
