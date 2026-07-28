import {Span} from "@opentelemetry/api";
import {CoralogixAttributes} from "../common";

/** Override the local transaction name on an in-flight span (processor path). */
export function startNewTransaction(span: Span, name: string): Span {
    span.setAttributes({
        [CoralogixAttributes.TRANSACTION_IDENTIFIER]: name,
        [CoralogixAttributes.TRANSACTION_ROOT]: true,
    });
    return span;
}
