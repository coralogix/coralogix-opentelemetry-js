import { CoralogixAttributes } from "./coralogix-attributes";

export const CoralogixTraceState = {
    TRANSACTION_IDENTIFIER: attributeToTraceState(CoralogixAttributes.TRANSACTION_IDENTIFIER),
    DISTRIBUTED_TRANSACTION_IDENTIFIER: attributeToTraceState(CoralogixAttributes.DISTRIBUTED_TRANSACTION_IDENTIFIER),
}

export function attributeToTraceState(attribute: string): string {
    return attribute.replace(/\./g, '_');
}