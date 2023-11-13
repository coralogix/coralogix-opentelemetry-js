import {Span} from "@opentelemetry/sdk-trace-base";
import {SemanticAttributes} from "@opentelemetry/semantic-conventions";

export function getSpanDisplayName(span: Span): string {
    const httpMethod = span.attributes?.[SemanticAttributes.HTTP_METHOD];
    const httpRoute = span.attributes?.[SemanticAttributes.HTTP_ROUTE];
    if (httpMethod && httpRoute) {
        return `${httpMethod} ${httpRoute}`;
    }
    return span.name;
}