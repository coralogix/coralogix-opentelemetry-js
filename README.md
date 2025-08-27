# coralogix-opentelemetry-js

Coralogix Node module which extends the existing functionality of [OpenTelemetry Node SDK](https://github.com/open-telemetry/opentelemetry-js).

```bash
npm install --save @coralogix/opentelemetry
```

## CoralogixTransactionSampler

This sampler extends the existing Node.js OpenTelemetry instrumentation setup in order to define, report, and monitor Coralogix [transactions](https://coralogix.com/docs/user-guides/apm/features/transactions/).

```js
import {CoralogixTransactionSampler} from "@coralogix/opentelemetry";
```

```js
sampler:  new CoralogixTransactionSampler(new AlwaysOnSampler()) // or your original sampler
```

It works with [individual auto-instrumentation](https://coralogix.com/docs/opentelemetry/instrumentation-options/nodejs-opentelemetry-instrumentation/#individual-auto-instrumentation) and [manual instrumentation](https://coralogix.com/docs/opentelemetry/instrumentation-options/nodejs-opentelemetry-instrumentation/#manual-instrumentation). The bundled auto-instrumentation method is **not** supported.

### Transactions With Express

To use Coralogix flows with express you must use the `setExpressApp` function to make sure that the `CoralogixTransactionSampler` understands your routes and endpoints.

Example:

```javascript
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { CoralogixTransactionSampler } from '@coralogix/opentelemetry';
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";

const sampler = new CoralogixTransactionSampler();

const tracerProvider = new BasicTracerProvider({
    resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: '<your-service-name>'
    }),
    sampler
});

import express from "express";

const router = express.Router()

const app = express();
app.use('/', router);

sampler.setExpressApp(app);

app.listen(3000, () => {
    console.log('Server is running')
});
```
