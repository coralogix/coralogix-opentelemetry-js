import {describe, it} from "node:test";
import assert from "node:assert";
import {selfTimeNsBySpanId} from "../../../src/trace/processors/self-time";

export default describe('selfTimeNsBySpanId', () => {
    it('computes exclusive self-time for a parent fully covered by one child (parent 0-100, child 20-80 -> 40/60)', () => {
        const result = selfTimeNsBySpanId([
            {spanId: 'parent', parentSpanId: undefined, startNs: BigInt(0), endNs: BigInt(100)},
            {spanId: 'child', parentSpanId: 'parent', startNs: BigInt(20), endNs: BigInt(80)},
        ]);

        assert.strictEqual(result.get('parent'), BigInt(40), 'parent self-time = 100 - (80-20) = 40');
        assert.strictEqual(result.get('child'), BigInt(60), 'leaf child self-time = its own duration = 60');
    });

    it('a span with no children has self-time equal to its own duration', () => {
        const result = selfTimeNsBySpanId([
            {spanId: 'solo', parentSpanId: undefined, startNs: BigInt(10), endNs: BigInt(50)},
        ]);
        assert.strictEqual(result.get('solo'), BigInt(40));
    });

    it('merges overlapping/concurrent children so covered time is not double counted', () => {
        const result = selfTimeNsBySpanId([
            {spanId: 'parent', parentSpanId: undefined, startNs: BigInt(0), endNs: BigInt(100)},
            {spanId: 'childA', parentSpanId: 'parent', startNs: BigInt(10), endNs: BigInt(50)},
            {spanId: 'childB', parentSpanId: 'parent', startNs: BigInt(40), endNs: BigInt(60)},
        ]);
        // Merged coverage is [10,60) = 50, so self-time = 100 - 50 = 50.
        assert.strictEqual(result.get('parent'), BigInt(50));
    });

    it('clamps children that start before or end after the parent interval', () => {
        const result = selfTimeNsBySpanId([
            {spanId: 'parent', parentSpanId: undefined, startNs: BigInt(20), endNs: BigInt(80)},
            {spanId: 'child', parentSpanId: 'parent', startNs: BigInt(0), endNs: BigInt(200)},
        ]);
        // Child interval is clamped to the parent's own bounds: covered = 80-20 = 60.
        assert.strictEqual(result.get('parent'), BigInt(0));
    });

    it('never returns a negative self-time', () => {
        const result = selfTimeNsBySpanId([
            {spanId: 'parent', parentSpanId: undefined, startNs: BigInt(0), endNs: BigInt(10)},
            {spanId: 'childA', parentSpanId: 'parent', startNs: BigInt(0), endNs: BigInt(10)},
            {spanId: 'childB', parentSpanId: 'parent', startNs: BigInt(0), endNs: BigInt(10)},
        ]);
        assert.strictEqual(result.get('parent'), BigInt(0));
    });

    it('a child whose local parent is not present in the batch is treated as its own root', () => {
        const result = selfTimeNsBySpanId([
            {spanId: 'orphan', parentSpanId: 'not-in-batch', startNs: BigInt(0), endNs: BigInt(30)},
        ]);
        assert.strictEqual(result.get('orphan'), BigInt(30));
    });

    it('returns an empty map for an empty input', () => {
        const result = selfTimeNsBySpanId([]);
        assert.strictEqual(result.size, 0);
    });
});
