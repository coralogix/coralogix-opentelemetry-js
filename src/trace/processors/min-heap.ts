/**
 * Binary min-heap helpers.
 *
 * Used by node-trim to keep a bounded set of larger values:
 * the heap head is the smallest (shortest duration) and is the easiest to
 * displace when a longer candidate arrives.
 */

/** Bubble the element at `index` up toward the root while it is smaller than its parent. */
export function bubbleUp<T>(
    heap: T[],
    index: number,
    less: (a: T, b: T) => boolean,
): void {
    let cur = index;
    while (cur > 0) {
        const parentIndex = (cur - 1) >> 1;
        const child = heap[cur];
        const parent = heap[parentIndex];
        if (child === undefined || parent === undefined || !less(child, parent)) {
            break;
        }
        heap[cur] = parent;
        heap[parentIndex] = child;
        cur = parentIndex;
    }
}

/** Bubble the element at `index` down while a child is smaller. */
export function bubbleDown<T>(
    heap: T[],
    index: number,
    less: (a: T, b: T) => boolean,
): void {
    let cur = index;
    for (;;) {
        let smallest = cur;
        const leftIndex = cur * 2 + 1;
        const rightIndex = leftIndex + 1;
        const left = heap[leftIndex];
        const right = heap[rightIndex];
        if (left !== undefined && less(left, heap[smallest]!)) {
            smallest = leftIndex;
        }
        if (right !== undefined && less(right, heap[smallest]!)) {
            smallest = rightIndex;
        }
        if (smallest === cur) {
            break;
        }
        const a = heap[cur]!;
        const b = heap[smallest]!;
        heap[cur] = b;
        heap[smallest] = a;
        cur = smallest;
    }
}
