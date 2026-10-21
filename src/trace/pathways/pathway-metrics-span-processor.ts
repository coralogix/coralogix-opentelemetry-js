import {Attributes, AttributeValue, Context, Histogram, MeterProvider, metrics, ObservableResult, SpanKind, SpanStatusCode} from "@opentelemetry/api";
import {ReadableSpan, Span, SpanProcessor} from "@opentelemetry/sdk-trace-base";
import {ATTR_SERVICE_NAME} from "@opentelemetry/semantic-conventions";
import {
    OVERFLOW_PATHWAY_ID,
    PathwayAttributes,
    PathwayMetricAttributes,
    PathwayMetrics,
    UNKNOWN_CALLER,
} from "./pathway-attributes";

const INSTRUMENTATION_SCOPE_NAME = "coralogix.opentelemetry.pathway";
export const DEFAULT_MAX_PATHWAYS_PER_ROOT = 50;

export interface PathwayMetricsSpanProcessorOptions {
    meterProvider?: MeterProvider;
    maxPathwaysPerRoot?: number;
}

interface AdmittedPathway {
    parentId: string | undefined;
    service: string;
    depth: number;
}

interface Destination {
    name: string;
    type: 'database' | 'messaging' | 'remote';
}

export class PathwayMetricsSpanProcessor implements SpanProcessor {
    private readonly hopDuration: Histogram;
    private readonly outboundDuration: Histogram;
    private readonly pathwayDuration: Histogram;
    private readonly maxPathwaysPerRoot: number;
    private readonly admitted = new Map<string, Map<string, AdmittedPathway>>();

    constructor(options: PathwayMetricsSpanProcessorOptions = {}) {
        this.maxPathwaysPerRoot = options.maxPathwaysPerRoot ?? DEFAULT_MAX_PATHWAYS_PER_ROOT;
        const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(INSTRUMENTATION_SCOPE_NAME);
        this.hopDuration = meter.createHistogram(PathwayMetrics.HOP_DURATION, {
            unit: "s",
            description: "Server-side duration of each pathway hop, keyed by root, caller and pathway id",
        });
        this.outboundDuration = meter.createHistogram(PathwayMetrics.OUTBOUND_DURATION, {
            unit: "s",
            description: "Client-side duration of outbound calls made within a pathway",
        });
        this.pathwayDuration = meter.createHistogram(PathwayMetrics.DURATION, {
            unit: "s",
            description: "End-to-end duration of a pathway, measured on its root span",
        });
        meter
            .createObservableGauge(PathwayMetrics.INFO, {description: "Pathway id to parent id and service mapping"})
            .addCallback((observable) => this.observeInfo(observable));
    }

    onStart(span: Span, _parentContext: Context): void {
        const attributes = span.attributes;
        const id = stringAttribute(attributes[PathwayAttributes.ID]);
        const rootService = stringAttribute(attributes[PathwayAttributes.ROOT_SERVICE]);
        if (attributes[PathwayAttributes.ENTRY] !== true || id === undefined || rootService === undefined) {
            return;
        }
        this.admit(rootService, id, {
            parentId: stringAttribute(attributes[PathwayAttributes.PARENT_ID]),
            service: stringAttribute(span.resource.attributes[ATTR_SERVICE_NAME]) ?? UNKNOWN_CALLER,
            depth: Number(attributes[PathwayAttributes.DEPTH] ?? 0),
        });
    }

    onEnd(span: ReadableSpan): void {
        const attributes = span.attributes;
        const id = stringAttribute(attributes[PathwayAttributes.ID]);
        const rootService = stringAttribute(attributes[PathwayAttributes.ROOT_SERVICE]);
        if (id === undefined || rootService === undefined) {
            return;
        }
        const service = stringAttribute(span.resource.attributes[ATTR_SERVICE_NAME]) ?? UNKNOWN_CALLER;
        const rootTransaction = stringAttribute(attributes[PathwayAttributes.ROOT_TRANSACTION]) ?? UNKNOWN_CALLER;
        const depth = Number(attributes[PathwayAttributes.DEPTH] ?? 0);
        const error = span.status.code === SpanStatusCode.ERROR;
        const durationSeconds = span.duration[0] + span.duration[1] / 1e9;

        if (attributes[PathwayAttributes.ENTRY] === true) {
            const parentId = stringAttribute(attributes[PathwayAttributes.PARENT_ID]);
            const admittedId = this.isAdmitted(rootService, id) ? id : OVERFLOW_PATHWAY_ID;
            this.hopDuration.record(durationSeconds, {
                [PathwayMetricAttributes.ROOT_SERVICE]: rootService,
                [PathwayMetricAttributes.ROOT_TRANSACTION]: rootTransaction,
                [PathwayMetricAttributes.CALLER]: stringAttribute(attributes[PathwayAttributes.CALLER]) ?? 'none',
                [PathwayMetricAttributes.SERVICE]: service,
                [PathwayMetricAttributes.ID]: admittedId,
                [PathwayMetricAttributes.PARENT_ID]: admittedId === OVERFLOW_PATHWAY_ID ? OVERFLOW_PATHWAY_ID : parentId ?? 'none',
                [PathwayMetricAttributes.DEPTH]: depth,
                [PathwayMetricAttributes.ERROR]: error,
            });
        }

        if (attributes[PathwayAttributes.ROOT] === true) {
            this.pathwayDuration.record(durationSeconds, {
                [PathwayMetricAttributes.ROOT_SERVICE]: rootService,
                [PathwayMetricAttributes.ROOT_TRANSACTION]: rootTransaction,
                [PathwayMetricAttributes.ERROR]: error,
            });
        }

        if (span.kind === SpanKind.CLIENT || span.kind === SpanKind.PRODUCER) {
            const destination = resolveDestination(attributes);
            this.outboundDuration.record(durationSeconds, {
                [PathwayMetricAttributes.ROOT_SERVICE]: rootService,
                [PathwayMetricAttributes.ROOT_TRANSACTION]: rootTransaction,
                [PathwayMetricAttributes.SERVICE]: service,
                [PathwayMetricAttributes.DESTINATION]: destination.name,
                [PathwayMetricAttributes.DESTINATION_TYPE]: destination.type,
                [PathwayMetricAttributes.ID]: this.isAdmitted(rootService, id) ? id : OVERFLOW_PATHWAY_ID,
                [PathwayMetricAttributes.ERROR]: error,
            });
        }
    }

    async forceFlush(): Promise<void> {
        return;
    }

    async shutdown(): Promise<void> {
        this.admitted.clear();
    }

    private admit(rootService: string, id: string, pathway: AdmittedPathway): void {
        let byId = this.admitted.get(rootService);
        if (byId === undefined) {
            byId = new Map();
            this.admitted.set(rootService, byId);
        }
        if (!byId.has(id) && byId.size < this.maxPathwaysPerRoot) {
            byId.set(id, pathway);
        }
    }

    private isAdmitted(rootService: string, id: string): boolean {
        return this.admitted.get(rootService)?.has(id) === true;
    }

    private observeInfo(observable: ObservableResult): void {
        for (const [rootService, byId] of this.admitted) {
            for (const [id, pathway] of byId) {
                observable.observe(1, {
                    [PathwayMetricAttributes.ROOT_SERVICE]: rootService,
                    [PathwayMetricAttributes.ID]: id,
                    [PathwayMetricAttributes.PARENT_ID]: pathway.parentId ?? 'none',
                    [PathwayMetricAttributes.SERVICE]: pathway.service,
                    [PathwayMetricAttributes.DEPTH]: pathway.depth,
                });
            }
        }
    }
}

export function resolveDestination(attributes: Attributes): Destination {
    const dbSystem = stringAttribute(attributes['db.system.name']) ?? stringAttribute(attributes['db.system']);
    if (dbSystem !== undefined) {
        const target = stringAttribute(attributes['db.namespace']) ?? stringAttribute(attributes['db.name']) ?? stringAttribute(attributes['server.address']);
        return {name: target ? `${dbSystem}:${target}` : dbSystem, type: 'database'};
    }
    const messagingSystem = stringAttribute(attributes['messaging.system']);
    if (messagingSystem !== undefined) {
        const target = stringAttribute(attributes['messaging.destination.name']);
        return {name: target ? `${messagingSystem}:${target}` : messagingSystem, type: 'messaging'};
    }
    const peer = stringAttribute(attributes['service.peer.name'])
        ?? stringAttribute(attributes['peer.service'])
        ?? stringAttribute(attributes['server.address'])
        ?? stringAttribute(attributes['net.peer.name'])
        ?? hostFromUrl(stringAttribute(attributes['url.full']) ?? stringAttribute(attributes['http.url']));
    return {name: peer ?? UNKNOWN_CALLER, type: 'remote'};
}

function hostFromUrl(url: string | undefined): string | undefined {
    if (url === undefined) {
        return undefined;
    }
    try {
        return new URL(url).hostname;
    } catch {
        return undefined;
    }
}

function stringAttribute(value: AttributeValue | undefined): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
