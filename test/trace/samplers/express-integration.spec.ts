import {describe, it} from "node:test";
import assert from "node:assert";
import {Attributes, SpanKind, ROOT_CONTEXT} from "@opentelemetry/api";
import {ATTR_URL_PATH} from "@opentelemetry/semantic-conventions";
import express from "express";
import express4 from "express4";
import {CoralogixTransactionSampler} from "../../../src/trace/samplers";
import {CoralogixAttributes} from "../../../src/trace/common";

const TRANSACTION = CoralogixAttributes.TRANSACTION_IDENTIFIER;

function resolveTransaction(sampler: CoralogixTransactionSampler, path: string): unknown {
    const attributes: Attributes = {[ATTR_URL_PATH]: path};
    const result = sampler.shouldSample(ROOT_CONTEXT, 'trace-id', 'GET', SpanKind.SERVER, attributes, []);
    return result.attributes?.[TRANSACTION];
}

// noop handler used purely to register routes; params are unused.
function noop(_req: express.Request, res: express.Response): void {
    res.end();
}

function buildApp(factory: typeof express): express.Application {
    const app = factory();

    // Root-mounted router (no prefix) — currently-working case, must not regress.
    const rootRouter = factory.Router();
    rootRouter.get('/users/:id', noop);
    app.use(rootRouter);

    // Nested routers with static prefixes.
    const inner = factory.Router();
    inner.get('/orders/:oid', noop);
    const mid = factory.Router();
    mid.use('/deep', inner);
    app.use('/api', mid);

    // App-level route.
    app.get('/health', noop);

    return app;
}

const factories: [string, typeof express][] = [['express5', express], ['express4', express4]];

export default describe('CoralogixTransactionSampler#setExpressApp (integration)', () => {
    for (const [name, factory] of factories) {
        describe(name, () => {
            it('resolves an app-level route', () => {
                const sampler = new CoralogixTransactionSampler();
                sampler.setExpressApp(buildApp(factory));
                assert.strictEqual(resolveTransaction(sampler, '/health'), 'GET /health');
            });

            it('resolves a root-mounted router route (regression)', () => {
                const sampler = new CoralogixTransactionSampler();
                sampler.setExpressApp(buildApp(factory));
                assert.strictEqual(resolveTransaction(sampler, '/users/123'), 'GET /users/:id');
            });

            it('resolves a nested prefixed router route with the full prefix', () => {
                const sampler = new CoralogixTransactionSampler();
                sampler.setExpressApp(buildApp(factory));
                assert.strictEqual(resolveTransaction(sampler, '/api/deep/orders/9'), 'GET /api/deep/orders/:oid');
            });

            it('falls back to the span name when nothing matches', () => {
                const sampler = new CoralogixTransactionSampler();
                sampler.setExpressApp(buildApp(factory));
                assert.strictEqual(resolveTransaction(sampler, '/nope'), 'GET');
            });

            it('handles a param in the mount prefix (templatized on both v4 and v5)', () => {
                const app = factory();
                const verRouter = factory.Router();
                verRouter.get('/things/:t', noop);
                app.use('/v/:ver', verRouter);

                const sampler = new CoralogixTransactionSampler();
                sampler.setExpressApp(app);

                assert.strictEqual(resolveTransaction(sampler, '/v/2/things/abc'), 'GET /v/:ver/things/:t');
            });
        });
    }
});
