# coralogix-opentelemetry-js

[![npm version](https://img.shields.io/npm/v/@coralogix/opentelemetry.svg)](https://www.npmjs.com/package/@coralogix/opentelemetry)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

Coralogix extensions for the [OpenTelemetry Node SDK](https://github.com/open-telemetry/opentelemetry-js). This package adds Coralogix-specific behavior on top of a standard OpenTelemetry tracing setup — most notably a sampler that defines and propagates Coralogix [transactions](https://coralogix.com/docs/user-guides/apm/features/transactions/) for APM.

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
