import {describe, it} from "node:test";
import assert from "node:assert";
import {SpanKind, ROOT_CONTEXT} from "@opentelemetry/api";
import {SEMATTRS_HTTP_TARGET} from "@opentelemetry/semantic-conventions";
import {CoralogixTransactionSampler} from "../../../src/trace/samplers";
import {CoralogixAttributes} from "../../../src/trace/common";

const TRANSACTION = CoralogixAttributes.TRANSACTION_IDENTIFIER;

function resolveTransaction(sampler: CoralogixTransactionSampler, target: string): unknown {
    const result = sampler.shouldSample(ROOT_CONTEXT, 'trace-id', 'GET', SpanKind.SERVER, {
        [SEMATTRS_HTTP_TARGET]: target,
    }, []);
    return result.attributes?.[TRANSACTION];
}

function express4App() {
    const routeLayer = {
        name: 'bound dispatch',
        route: {path: '/users/:id'},
        regexp: /^\/users\/(?:([^/]+?))\/?$/i,
    };
    return {_router: {stack: [routeLayer]}};
}

function express5App() {
    const routeLayer = {
        name: 'bound dispatch',
        route: {path: '/users/:id'},
        match(path: string): boolean {
            return /^\/users\/[^/]+$/.test(path);
        },
    };
    return {router: {stack: [routeLayer]}};
}

export default describe('CoralogixTransactionSampler#setExpressApp', () => {
    it('resolves the route template on Express 4 (regression)', () => {
        const sampler = new CoralogixTransactionSampler();
        sampler.setExpressApp(express4App() as never);

        assert.strictEqual(resolveTransaction(sampler, '/users/123'), 'GET /users/:id');
    });

    it('does not throw when Express 5 has no _router', () => {
        const sampler = new CoralogixTransactionSampler();

        assert.doesNotThrow(() => sampler.setExpressApp(express5App() as never));
    });

    it('resolves the route template on Express 5', () => {
        const sampler = new CoralogixTransactionSampler();
        sampler.setExpressApp(express5App() as never);

        assert.strictEqual(resolveTransaction(sampler, '/users/123'), 'GET /users/:id');
    });

    it('resolves the route template when the target carries a query string', () => {
        const sampler = new CoralogixTransactionSampler();
        sampler.setExpressApp(express5App() as never);

        assert.strictEqual(resolveTransaction(sampler, '/users/123?expand=true'), 'GET /users/:id');
    });

    it('falls back to the span name when no route matches', () => {
        const sampler = new CoralogixTransactionSampler();
        sampler.setExpressApp(express5App() as never);

        assert.strictEqual(resolveTransaction(sampler, '/unknown/path'), 'GET');
    });
});
