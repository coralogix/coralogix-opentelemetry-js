/**
 * Harvest heap: keep only the slowest completed local traces.
 * During a harvest window, completed local traces compete by root duration;
 * only winners are exported (default capacity 1).
 *
 * Backing structure is a min-heap by duration: head = shortest / easiest to
 * displace when a longer trace arrives.
 */

import {ReadableSpan} from "@opentelemetry/sdk-trace-base";
import {CoralogixAttributes} from "../common";
import {DEFAULT_MAX_REGULAR_TRACES} from "./defaults";
import {bubbleDown, bubbleUp} from "./min-heap";
import {spanDurationNs} from "./trace-heap";

export {DEFAULT_MAX_REGULAR_TRACES, DEFAULT_HARVEST_PERIOD_MILLIS} from "./defaults";

const ZERO = BigInt(0);

export interface HarvestTrace {
    durationNs: bigint;
    spans: ReadableSpan[];
}

export class RegularTraceHeap {
    private readonly maxTraces: number;
    private readonly heap: HarvestTrace[] = [];

    constructor(maxTraces: number = DEFAULT_MAX_REGULAR_TRACES) {
        if (maxTraces < 0) {
            throw new Error("maxTraces must be >= 0");
        }
        this.maxTraces = maxTraces;
    }

    get capacity(): number {
        return this.maxTraces;
    }

    get size(): number {
        return this.heap.length;
    }

    witness(trace: HarvestTrace): ReadableSpan[] {
        if (this.maxTraces <= 0) {
            return [];
        }
        if (this.heap.length < this.maxTraces) {
            this.heap.push(trace);
            // Min-heap by duration: shorter traces sit toward the head.
            bubbleUp(this.heap, this.heap.length - 1, durationLess);
            return [];
        }
        const head = this.heap[0];
        if (head === undefined || trace.durationNs <= head.durationNs) {
            return harvestStubSpans(trace.spans);
        }
        this.heap[0] = trace;
        bubbleDown(this.heap, 0, durationLess);
        return harvestStubSpans(head.spans);
    }

    drain(): HarvestTrace[] {
        const traces = this.heap.slice();
        this.heap.length = 0;
        return traces;
    }
}

function durationLess(a: HarvestTrace, b: HarvestTrace): boolean {
    return a.durationNs < b.durationNs;
}

/** Duration of the longest transaction root, else max span duration in the batch. */
export function rootDurationNs(spans: ReadableSpan[]): bigint {
    let maxRootDuration = ZERO;
    let foundRoot = false;
    let maxDuration = ZERO;
    for (const span of spans) {
        const duration = spanDurationNs(span);
        if (duration > maxDuration) {
            maxDuration = duration;
        }
        if (span.attributes[CoralogixAttributes.TRANSACTION_ROOT] === true) {
            foundRoot = true;
            if (duration > maxRootDuration) {
                maxRootDuration = duration;
            }
        }
    }
    if (foundRoot) {
        return maxRootDuration;
    }
    return maxDuration;
}

/** Root-only spans for APM presence when a completed tree loses harvest. */
export function harvestStubSpans(spans: ReadableSpan[]): ReadableSpan[] {
    if (spans.length === 0) {
        return [];
    }
    const stubs = spans.filter(
        (span) => span.attributes[CoralogixAttributes.TRANSACTION_ROOT] === true,
    );
    if (stubs.length > 0) {
        return stubs;
    }
    let best = spans[0]!;
    let bestDur = spanDurationNs(best);
    for (let i = 1; i < spans.length; i++) {
        const span = spans[i]!;
        const duration = spanDurationNs(span);
        if (duration > bestDur) {
            best = span;
            bestDur = duration;
        }
    }
    return [best];
}
