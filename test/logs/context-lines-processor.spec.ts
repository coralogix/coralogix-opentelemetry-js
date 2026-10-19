import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor} from "@opentelemetry/sdk-logs";
import {ATTR_EXCEPTION_CONTEXT_LINES, ContextLinesProcessor} from "../../src/logs";
import type {FrameContext} from "../../src/logs";

const ATTR_EXCEPTION_STACKTRACE = "exception.stacktrace";
const LINES_OF_CONTEXT = 3;

function throwFromKnownLine(): never {
    const reason = "context-lines-marker";
    throw new Error(reason);
}

function captureStack(): string {
    try {
        throwFromKnownLine();
    } catch (e) {
        return (e as Error).stack ?? "";
    }
}

function emitAndExport(attributes: Record<string, string>) {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
        processors: [
            new ContextLinesProcessor({linesOfContext: LINES_OF_CONTEXT}),
            new SimpleLogRecordProcessor(exporter),
        ],
    });
    provider.getLogger("test").emit({body: "boom", attributes});
    const record = exporter.getFinishedLogRecords()[0];
    assert.ok(record, "record was not exported");
    return record;
}

export default describe("ContextLinesProcessor", () => {
    it("attaches in-app source context for the throwing frame", () => {
        const stack = captureStack();
        const record = emitAndExport({[ATTR_EXCEPTION_STACKTRACE]: stack});

        const raw = record.attributes[ATTR_EXCEPTION_CONTEXT_LINES];
        assert.equal(typeof raw, "string", `${ATTR_EXCEPTION_CONTEXT_LINES} missing`);
        const frames = JSON.parse(raw as string) as FrameContext[];
        const top = frames[0];
        assert.ok(top);

        assert.equal(top.index, 0);
        assert.match(top.filename, /context-lines-processor\.spec\.ts$/);
        assert.equal(top.function, "throwFromKnownLine");
        assert.equal(top.context_line.trim(), "throw new Error(reason);");
        assert.equal(top.pre_context.length, LINES_OF_CONTEXT);
        assert.equal(top.pre_context[LINES_OF_CONTEXT - 1]?.trim(), 'const reason = "context-lines-marker";');
        assert.equal(top.post_context[0]?.trim(), "}");
        assert.ok(frames.every((f) => !f.filename.includes("node_modules") && !f.filename.startsWith("node:")));
        assert.equal(record.attributes[ATTR_EXCEPTION_STACKTRACE], stack, "stacktrace must be untouched");
    });

    it("adds no attribute when the record has no exception.stacktrace", () => {
        const record = emitAndExport({"some.other": "value"});
        assert.equal(record.attributes[ATTR_EXCEPTION_CONTEXT_LINES], undefined);
    });

    it("does not throw on a garbage stacktrace", () => {
        const garbage = "at \n    at (:)\nat x (file:///\u0000:NaN:NaN)\n" + "at ".repeat(5000);
        const record = emitAndExport({[ATTR_EXCEPTION_STACKTRACE]: garbage});
        assert.equal(record.attributes[ATTR_EXCEPTION_CONTEXT_LINES], undefined);
        assert.equal(record.attributes[ATTR_EXCEPTION_STACKTRACE], garbage);
    });
});
