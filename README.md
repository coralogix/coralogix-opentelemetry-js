# Coralogix Opentelemetry

## Flows With Express
To use coralogix flows with express you must use the `setExpressApp`
function to make sure that the `coralogix sampler` understands
your routes and endpoints.

Example:

```javascript
const sampler = new CoralogixTransactionSampler();

const tracerProvider = new BasicTracerProvider({
    resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: '<your-service-name>'
    }),
    sampler
});
import express from "express";
import router from "./router";

const app = express();
app.use('/', router);

sampler.setExpressApp(app);

app.listen(3000, () => {
    console.log('Server is running')
});
