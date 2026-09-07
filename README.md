# coralogix-opentelemetry-js

[![npm version](https://img.shields.io/npm/v/@coralogix/opentelemetry.svg)](https://www.npmjs.com/package/@coralogix/opentelemetry)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

Coralogix extensions for the [OpenTelemetry Node SDK](https://github.com/open-telemetry/opentelemetry-js). This package adds Coralogix-specific behavior on top of a standard OpenTelemetry tracing setup — transaction tagging via a sampler and/or a `SpanProcessor`, including exclusive self duration on the processor path.

```bash
npm install --save @coralogix/opentelemetry
```

## Requirements

This package relies on your application's existing OpenTelemetry setup. The following are `peerDependencies` and must be installed alongside it:

| Package | Version |
| --- | --- |
| `@opentelemetry/api` | `^1.7.0` |
| `@opentelemetry/sdk-trace-base` | `^2.8.0` |

The examples below also use `@opentelemetry/resources` and `@opentelemetry/semantic-conventions`, which are part of a typical OpenTelemetry Node setup.

> **Note:** This package targets OpenTelemetry JS SDK **2.x**. The resource/provider APIs shown below (`resourceFromAttributes`, `ATTR_SERVICE_NAME`) are the 2.x APIs; if you are still on SDK 1.x, adapt the setup accordingly (`new Resource(...)`, `SemanticResourceAttributes`).

## CoralogixTransactionSampler

`CoralogixTransactionSampler` wraps an existing OpenTelemetry sampler to define, report, and monitor Coralogix [transactions](https://coralogix.com/docs/user-guides/apm/features/transactions/). It sets Coralogix transaction attributes on sampled spans and propagates the transaction identity across the trace.

```js
import { CoralogixTransactionSampler } from "@coralogix/opentelemetry";
import { AlwaysOnSampler } from "@opentelemetry/sdk-trace-base";

// Wrap your existing sampler...
const sampler = new CoralogixTransactionSampler(new AlwaysOnSampler());

// ...or omit the argument to default to a ParentBased(AlwaysOn) sampler.
const defaultSampler = new CoralogixTransactionSampler();
```

Pass the sampler to your tracer provider like any other OpenTelemetry sampler:

```js
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const tracerProvider = new BasicTracerProvider({
    resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: "<your-service-name>",
    }),
    sampler: new CoralogixTransactionSampler(),
});
```

### Supported instrumentation

It works with [individual auto-instrumentation](https://coralogix.com/docs/opentelemetry/instrumentation-options/nodejs-opentelemetry-instrumentation/#individual-auto-instrumentation) and [manual instrumentation](https://coralogix.com/docs/opentelemetry/instrumentation-options/nodejs-opentelemetry-instrumentation/#manual-instrumentation). The bundled auto-instrumentation method is **not** supported.

### Emitted attributes

When a span starts a transaction, the sampler adds the following attributes:

| Attribute | Description |
| --- | --- |
| `cgx.transaction` | The transaction name (e.g. `GET /users/:id`). |
| `cgx.transaction.distributed` | The distributed transaction name propagated across services. |
| `cgx.transaction.root` | Whether this span is the root of the transaction. |

## TransactionSpanProcessor

`TransactionSpanProcessor` wraps a `SpanExporter` to tag Coralogix transactions, stamp exclusive self duration (`cgx.transaction.self_duration`, seconds) on completed local traces, and record the matching histogram (unit `s`). It works with any sampler.

### How naming works

Transaction **membership** (new vs inherit, and `cgx.transaction.root`) is decided on span start. The display name `cgx.transaction` is stamped only when a completed local trace is finalized for export, using `overrideName ?? rootSpan.name`. That matters for Express: the HTTP span often starts as `GET` and is later renamed to `GET /myroute` by middleware — the exported transaction name is the final root span name.

Every completed local trace is exported immediately. The processor buffers up
to `CORALOGIX_MAX_SPANS_PER_TRACE` completed spans for transaction enrichment
(default: 256), and up to `CORALOGIX_MAX_TRANSACTION_TRACES` transactions retained in memory at once (default: unlimited).
When a positive span limit is exceeded, it immediately exports that trace's buffer
and streams later spans unchanged. `CORALOGIX_MAX_SPANS_PER_TRACE=0` is unlimited.
When the trace limit is reached, later traces
stream unchanged. The trace limit applies only while transactions are retained in memory; `0` is unlimited, and once a buffered transaction finishes, capacity is available again. Those traces receive no processor transaction tags,
self-duration, or metrics.

```js
import { BasicTracerProvider, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { TransactionSpanProcessor } from "@coralogix/opentelemetry";

const tracerProvider = new BasicTracerProvider({
    spanProcessors: [
        new TransactionSpanProcessor(new ConsoleSpanExporter(), {
            // Optional MeterProvider for the self-duration histogram; defaults to the global one.
        }),
    ],
});
```

### Options

Constructor options win over environment variables. Invalid env values fall back to the default.

| Option | Type | Default | Env var | Meaning |
| --- | --- | --- | --- | --- |
| `completionHoldbackMillis` | `number` | `100` | `OTEL_CX_TRANSACTION_COMPLETION_HOLDBACK_MILLIS` | After the last live span ends, wait this long before finalize so late siblings can join. `0` = finalize immediately. |
| `shutdownIdleWaitMillis` | `number` | `30000` | — | How long shutdown waits for in-flight spans. |
| `meterProvider` | `MeterProvider` | global | — | MeterProvider for the self-duration histogram. |

## Benchmark

To help users estimate resource usage, we ran this benchmark. The first table processes 10,000 traces at each depth from 8 to 2,048 spans to show the impact of increasingly deep transactions. The second table processes traces with a depth of 1,000 spans at increasing trace counts to show the effect of transaction volume.

### 10000 traces by depth

| Depth | Traces | RSS base MiB | RSS peak MiB | RSS delta MiB | Spans/s |
|---:|---:|---:|---:|---:|---:|
|  8  |  10000  | 92.00 | 261.90 | 169.90 | 80796.10 |
|  16  |  10000  | 92.50 | 274.00 | 181.50 | 122777.50 |
|  32  |  10000  | 92.20 | 278.50 | 186.40 | 137156.90 |
|  64  |  10000  | 92.40 | 272.60 | 180.20 | 135673.80 |
|  128  |  10000  | 92.50 | 269.50 | 177.00 | 111464.50 |
|  256  |  10000  | 93.20 | 266.80 | 173.60 | 71862.90 |
|  512  |  10000  | 92.80 | 265.30 | 172.50 | 124391.00 |
|  1024  |  10000  | 92.50 | 267.90 | 175.40 | 132568.20 |
|  2048  |  10000  | 92.50 | 300.30 | 207.80 | 132028.60 |

### Depth 1000 by trace count

| Depth | Traces | RSS base MiB | RSS peak MiB | RSS delta MiB | Spans/s |
|---:|---:|---:|---:|---:|---:|
|  1000  |  100  | 92.30 | 215.00 | 122.70 | 124250.30 |
|  1000  |  1000  | 92.70 | 219.20 | 126.50 | 131300.10 |
|  1000  |  10000  | 92.10 | 277.30 | 185.10 | 131087.30 |
|  1000  |  100000  | 92.40 | 276.10 | 183.70 | 133746.70 |

## Transactions with Express

To resolve stable, low-cardinality transaction names for Express routes (e.g. `GET /users/:id` instead of a per-request path), call `setExpressApp` so the sampler can learn your app's routes and endpoints.

> **Important:** Call `setExpressApp` **after all routes and routers have been registered**. The sampler reads the Express router stack at the moment you call it, so any routes added afterwards will not be resolved.

```javascript
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { CoralogixTransactionSampler } from "@coralogix/opentelemetry";
import express from "express";
import router from "./router";

const sampler = new CoralogixTransactionSampler();

const tracerProvider = new BasicTracerProvider({
    resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: "<your-service-name>",
    }),
    sampler,
});

const app = express();
app.use("/", router);

// Register routes first, then hand the app to the sampler.
sampler.setExpressApp(app);

app.listen(3000, () => {
    console.log("Server is running");
});
```

### Prefixed and nested routers

`setExpressApp` resolves the **full** route template, including mount prefixes and arbitrarily nested routers. For example, given:

```javascript
const orders = express.Router();
orders.get("/orders/:oid", handler);

const api = express.Router();
api.use("/deep", orders);

app.use("/api", api);
```

a request to `/api/deep/orders/9` resolves to the transaction `GET /api/deep/orders/:oid`.

### Express version support

Both **Express 4** and **Express 5** are supported.

Parameters are templatized correctly on both versions, including a parameter used in a *mount prefix* (`app.use("/v/:ver", router)`): a request to `/v/2/things/abc` resolves to `GET /v/:ver/things/:t`.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes. Note that route-template resolution for prefixed and nested routers is a **breaking output change**: transaction names for affected apps change, so update any dashboards, alerts, or saved views keyed on the previous names.

## License

Licensed under the [Apache License 2.0](./LICENSE).
