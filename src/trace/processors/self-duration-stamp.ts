import {Histogram} from "@opentelemetry/api";
import {ReadableSpan} from "@opentelemetry/sdk-trace-base";
import {CoralogixAttributes} from "../common";
import {selfDurationNsBySpanId, SpanTimingRow} from "./self-duration";

const METRIC_ATTR_SPAN_NAME = "span.name";
const NANOS_PER_SECOND = BigInt(1_000_000_000);

/**
 * Stamp exclusive self duration on each span and record the histogram.
 * Call after transaction names are finalized so metric attrs include
 * `cgx.transaction`.
 */
export function stampSelfDurationAndMetrics(
    spans: ReadableSpan[],
    childIntervalSnapshot: Map<string, Array<{startNs: bigint; endNs: bigint}>>,
    histogram: Histogram,
): void {
    const rows: SpanTimingRow[] = [];
    for (const span of spans) {
        const spanId = span.spanContext().spanId;
        const startNs = hrTimeToBigIntNanos(span.startTime);
        const endNs = hrTimeToBigIntNanos(span.endTime);
        rows.push({
            spanId,
            parentSpanId: span.parentSpanContext?.spanId,
            startNs,
            endNs,
        });
        const priorIntervals = childIntervalSnapshot.get(spanId) ?? [];
        for (let index = 0; index < priorIntervals.length; index++) {
            const {startNs: priorStart, endNs: priorEnd} = priorIntervals[index]!;
            const duplicateInBatch = spans.some((other) => {
                const otherParentId = other.parentSpanContext?.spanId;
                if (otherParentId !== spanId) {
                    return false;
                }
                return hrTimeToBigIntNanos(other.startTime) === priorStart
                    && hrTimeToBigIntNanos(other.endTime) === priorEnd;
            });
            if (duplicateInBatch) {
                continue;
            }
            rows.push({
                spanId: `${spanId}:prior:${index}`,
                parentSpanId: spanId,
                startNs: priorStart,
                endNs: priorEnd,
            });
        }
    }
    const selfDurations = selfDurationNsBySpanId(rows);

    for (const span of spans) {
        const selfDurationNs = selfDurations.get(span.spanContext().spanId);
        if (selfDurationNs === undefined) {
            continue;
        }
        const selfDurationSec = Number(selfDurationNs) / 1_000_000_000;
        span.attributes[CoralogixAttributes.SELF_DURATION] = selfDurationSec;
        recordSelfDurationMetric(histogram, span, selfDurationSec);
    }
}

function recordSelfDurationMetric(
    histogram: Histogram,
    span: ReadableSpan,
    selfDurationSec: number,
): void {
    const attributes = span.attributes;
    const metricAttributes: Record<string, string | boolean> = {
        [METRIC_ATTR_SPAN_NAME]: span.name,
    };
    const transaction = attributes[CoralogixAttributes.TRANSACTION_IDENTIFIER];
    if (transaction !== undefined) {
        metricAttributes[CoralogixAttributes.TRANSACTION_IDENTIFIER] = String(transaction);
    }
    if (attributes[CoralogixAttributes.TRANSACTION_ROOT] === true) {
        metricAttributes[CoralogixAttributes.TRANSACTION_ROOT] = true;
    }
    histogram.record(selfDurationSec, metricAttributes);
}

function hrTimeToBigIntNanos(hrTime: readonly [number, number]): bigint {
    return BigInt(hrTime[0]) * NANOS_PER_SECOND + BigInt(hrTime[1]);
}
