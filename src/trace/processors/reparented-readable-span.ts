import {SpanContext} from "@opentelemetry/api";
import {ReadableSpan} from "@opentelemetry/sdk-trace-base";

/** Thin wrapper that overrides parentSpanContext after node trim. */
export class ReparentedReadableSpan implements ReadableSpan {
    constructor(
        private readonly inner: ReadableSpan,
        private readonly overriddenParent: SpanContext | undefined,
    ) {}

    get name(): ReadableSpan["name"] {
        return this.inner.name;
    }

    get kind(): ReadableSpan["kind"] {
        return this.inner.kind;
    }

    spanContext(): ReturnType<ReadableSpan["spanContext"]> {
        return this.inner.spanContext();
    }

    get parentSpanContext(): ReadableSpan["parentSpanContext"] {
        return this.overriddenParent;
    }

    get startTime(): ReadableSpan["startTime"] {
        return this.inner.startTime;
    }

    get endTime(): ReadableSpan["endTime"] {
        return this.inner.endTime;
    }

    get status(): ReadableSpan["status"] {
        return this.inner.status;
    }

    get attributes(): ReadableSpan["attributes"] {
        return this.inner.attributes;
    }

    get links(): ReadableSpan["links"] {
        return this.inner.links;
    }

    get events(): ReadableSpan["events"] {
        return this.inner.events;
    }

    get duration(): ReadableSpan["duration"] {
        return this.inner.duration;
    }

    get ended(): ReadableSpan["ended"] {
        return this.inner.ended;
    }

    get resource(): ReadableSpan["resource"] {
        return this.inner.resource;
    }

    get instrumentationScope(): ReadableSpan["instrumentationScope"] {
        return this.inner.instrumentationScope;
    }

    get droppedAttributesCount(): ReadableSpan["droppedAttributesCount"] {
        return this.inner.droppedAttributesCount;
    }

    get droppedEventsCount(): ReadableSpan["droppedEventsCount"] {
        return this.inner.droppedEventsCount;
    }

    get droppedLinksCount(): ReadableSpan["droppedLinksCount"] {
        return this.inner.droppedLinksCount;
    }
}
