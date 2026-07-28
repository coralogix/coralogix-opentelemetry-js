/**
 * Harvest heap: keep only the slowest completed local traces.
 * During a harvest window, completed local traces compete by root duration;
 * only winners are exported (default capacity 1).
 */

import {ReadableSpan} from "@opentelemetry/sdk-trace-base";
import {CoralogixAttributes} from "../common";
import {spanDurationNs} from "./trace-heap";

/** Default harvest capacity and period. */
export const DEFAULT_MAX_REGULAR_TRACES = 1;
export const DEFAULT_HARVEST_PERIOD_MILLIS = 60_000;

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

    witness(trace: HarvestTrace): boolean {
        if (this.maxTraces <= 0) {
            return false;
        }
        if (this.heap.length < this.maxTraces) {
            this.heap.push(trace);
            this.siftUp(this.heap.length - 1);
            return true;
        }
        const head = this.heap[0];
        if (head === undefined || trace.durationNs <= head.durationNs) {
            return false;
        }
        this.heap[0] = trace;
        this.siftDown(0);
        return true;
    }

    drain(): HarvestTrace[] {
        const traces = this.heap.slice();
        this.heap.length = 0;
        return traces;
    }

    private siftUp(i: number): void {
        let cur = i;
        while (cur > 0) {
            const p = (cur - 1) >> 1;
            const child = this.heap[cur];
            const parent = this.heap[p];
            if (child === undefined || parent === undefined || child.durationNs >= parent.durationNs) {
                break;
            }
            this.heap[cur] = parent;
            this.heap[p] = child;
            cur = p;
        }
    }

    private siftDown(i: number): void {
        let cur = i;
        for (;;) {
            let smallest = cur;
            const l = cur * 2 + 1;
            const r = l + 1;
            const left = this.heap[l];
            const right = this.heap[r];
            const smallestItem = this.heap[smallest];
            if (left !== undefined && smallestItem !== undefined && left.durationNs < smallestItem.durationNs) {
                smallest = l;
            }
            const newSmallest = this.heap[smallest];
            if (right !== undefined && newSmallest !== undefined && right.durationNs < newSmallest.durationNs) {
                smallest = r;
            }
            if (smallest === cur) {
                break;
            }
            const a = this.heap[cur]!;
            const b = this.heap[smallest]!;
            this.heap[cur] = b;
            this.heap[smallest] = a;
            cur = smallest;
        }
    }
}

/** Duration of the transaction root, else max span duration in the batch. */
export function rootDurationNs(spans: ReadableSpan[]): bigint {
    let root: ReadableSpan | undefined;
    let maxDuration = ZERO;
    for (const span of spans) {
        const duration = spanDurationNs(span);
        if (duration > maxDuration) {
            maxDuration = duration;
        }
        if (span.attributes[CoralogixAttributes.TRANSACTION_ROOT] === true) {
            root = span;
        }
    }
    if (root !== undefined) {
        return spanDurationNs(root);
    }
    return maxDuration;
}
