// The `express4` alias resolves to express@4 at runtime. Reuse the installed Express
// type definitions so integration tests are fully typed and lint-clean (no `any`).
declare module 'express4' {
    import express from 'express';
    export = express;
}
