import {ReadableSpan, Span, SpanProcessor} from "@opentelemetry/sdk-trace-base";
import opentelemetry, {Context, diag} from "@opentelemetry/api"
import {getSpanDisplayName} from "../utils/trace-utils";

const TRANSACTION_ATTRIBUTE = 'cgx.transaction';

export class CoralogixTransactionProcessor implements SpanProcessor {


    // /* eslint-disable @typescript-eslint/no-unused-vars */

    // /* eslint-disable @typescript-eslint/no-empty-function */

    async forceFlush(): Promise<void> {
    }

    /* eslint-disable @typescript-eslint/no-unused-vars */

    /* eslint-disable @typescript-eslint/no-empty-function */

    onEnd(span: ReadableSpan): void {
    }

    onStart(span: Span, parentContext: Context): void {
        this.propagateAttributes(parentContext, span);
    }

    async shutdown(): Promise<void> {
    }

    private propagateAttributes(parentContext: Context, span: Span) {
        // if propagation fails we dont want to fail processing the span
        try {
            if (!span || !parentContext) {
                return;
            }

            const fatherSpan = opentelemetry.trace.getSpan(parentContext);
            const transaction =
                ((fatherSpan instanceof Span) && fatherSpan?.attributes?.[TRANSACTION_ATTRIBUTE]) ?? getSpanDisplayName(span);

            if (transaction) {
                span.setAttributes({[TRANSACTION_ATTRIBUTE]: transaction})
            }

        } catch (error) {
            diag.warn(`CoralogixProcessor: failed attaching transaction to span: ${error}`);
        }
    }
}