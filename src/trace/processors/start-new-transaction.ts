import {Span} from "@opentelemetry/api";
import {CoralogixAttributes} from "../common";

/** Override the local transaction name on an in-flight span (attribute-only).
 * Prefer {@link TransactionSpanProcessor.startNewTransaction} when using the
 * processor so the parent-resolution side table stays in sync.
 */
export function startNewTransaction(span: Span, name: string): Span {
    span.setAttributes({
        [CoralogixAttributes.TRANSACTION_IDENTIFIER]: name,
        [CoralogixAttributes.TRANSACTION_ROOT]: true,
    });
    return span;
}
