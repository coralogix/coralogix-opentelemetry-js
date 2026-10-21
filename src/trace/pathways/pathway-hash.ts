const FNV_OFFSET_BASIS_64 = BigInt('0xcbf29ce484222325');
const FNV_PRIME_64 = BigInt('0x100000001b3');
const MASK_64 = BigInt('0xffffffffffffffff');

export function fnv1a64(input: string): string {
    let hash = FNV_OFFSET_BASIS_64;
    for (const byte of Buffer.from(input, 'utf8')) {
        hash ^= BigInt(byte);
        hash = (hash * FNV_PRIME_64) & MASK_64;
    }
    return hash.toString(16).padStart(16, '0');
}

export function pathwayId(node: string, parentPathwayId: string | undefined): string {
    return fnv1a64(`${parentPathwayId ?? ''}|${node}`);
}
