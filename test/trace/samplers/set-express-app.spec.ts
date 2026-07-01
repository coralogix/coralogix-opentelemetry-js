import {describe, it} from "node:test";
import assert from "node:assert";
import {Attributes, SpanKind, ROOT_CONTEXT} from "@opentelemetry/api";
import {ATTR_URL_PATH} from "@opentelemetry/semantic-conventions";
import {CoralogixTransactionSampler} from "../../../src/trace/samplers";
import {CoralogixAttributes} from "../../../src/trace/common";

const TRANSACTION = CoralogixAttributes.TRANSACTION_IDENTIFIER;
// Legacy pre-stability HTTP attribute, still emitted by instrumentations that have not opted into
// stable HTTP semconv. Kept here as a literal so the test does not depend on a deprecated export.
const ATTR_HTTP_TARGET_LEGACY = "http.target";

function resolveTransaction(sampler: CoralogixTransactionSampler, attributes: Attributes): unknown {
    const result = sampler.shouldSample(ROOT_CONTEXT, 'trace-id', 'GET', SpanKind.SERVER, attributes, []);
    return result.attributes?.[TRANSACTION];
}

// Stable HTTP semconv: the path arrives under `url.path` without a query string.
const urlPath = (path: string): Attributes => ({[ATTR_URL_PATH]: path});
// Legacy semconv: the path arrives under `http.target`, query string included.
const httpTarget = (target: string): Attributes => ({[ATTR_HTTP_TARGET_LEGACY]: target});

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

        assert.strictEqual(resolveTransaction(sampler, httpTarget('/users/123')), 'GET /users/:id');
    });

    it('does not throw when Express 5 has no _router', () => {
        const sampler = new CoralogixTransactionSampler();

        assert.doesNotThrow(() => sampler.setExpressApp(express5App() as never));
    });

    it('resolves the route template on Express 5', () => {
        const sampler = new CoralogixTransactionSampler();
        sampler.setExpressApp(express5App() as never);

        assert.strictEqual(resolveTransaction(sampler, httpTarget('/users/123')), 'GET /users/:id');
    });

    it('resolves the route template from the legacy http.target with a query string', () => {
        const sampler = new CoralogixTransactionSampler();
        sampler.setExpressApp(express5App() as never);

        assert.strictEqual(resolveTransaction(sampler, httpTarget('/users/123?expand=true')), 'GET /users/:id');
    });

    it('resolves the route template from the stable url.path attribute', () => {
        const sampler = new CoralogixTransactionSampler();
        sampler.setExpressApp(express5App() as never);

        assert.strictEqual(resolveTransaction(sampler, urlPath('/users/123')), 'GET /users/:id');
    });

    it('prefers url.path over http.target when both are present (dup mode)', () => {
        const sampler = new CoralogixTransactionSampler();
        sampler.setExpressApp(express5App() as never);

        assert.strictEqual(resolveTransaction(sampler, {
            [ATTR_URL_PATH]: '/users/123',
            [ATTR_HTTP_TARGET_LEGACY]: '/unknown/path',
        }), 'GET /users/:id');
    });

    it('falls back to the span name when no route matches', () => {
        const sampler = new CoralogixTransactionSampler();
        sampler.setExpressApp(express5App() as never);

        assert.strictEqual(resolveTransaction(sampler, urlPath('/unknown/path')), 'GET');
    });
});
