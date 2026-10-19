import { readFileSync, statSync } from "node:fs";
import { SourceMap } from "node:module";
import type { SourceMapPayload } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@opentelemetry/api";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";

const ATTR_EXCEPTION_STACKTRACE = "exception.stacktrace";
export const ATTR_EXCEPTION_CONTEXT_LINES = "cx.exception.context_lines";

export interface ContextLinesOptions {
  linesOfContext?: number;
  maxFrames?: number;
  maxFileBytes?: number;
  maxLineLength?: number;
  maxAttributeBytes?: number;
  cacheSize?: number;
}

export interface FrameContext {
  index: number;
  filename: string;
  function: string;
  lineno: number;
  colno?: number;
  in_app: boolean;
  pre_context: string[];
  context_line: string;
  post_context: string[];
  generated?: { filename: string; lineno: number; colno?: number };
}

interface StackFrame {
  index: number;
  filename: string;
  function: string;
  lineno: number;
  colno?: number;
}

interface SourcePosition {
  filename: string;
  lineno: number;
  colno?: number;
  lines: string[];
}

const DEFAULTS: Required<ContextLinesOptions> = {
  linesOfContext: 7,
  maxFrames: 50,
  maxFileBytes: 1024 * 1024,
  maxLineLength: 150,
  maxAttributeBytes: 32 * 1024,
  cacheSize: 50,
};

const MINIFIED_ABOVE_LINENO = 10_000;
const MINIFIED_ABOVE_COLNO = 1_000;

const TYPESCRIPT_FILE = /\.[cm]?tsx?$/;
const SOURCE_MAPPING_URL = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/;

const V8_FRAME = /at (?:async )?(?:(.+?)\s+\()?(?:(.+):(\d+):(\d+)?|([^)]+))\)?/;

function toFilePath(location: string): string {
  return location.startsWith("file://") ? fileURLToPath(location) : location;
}

function parseV8Frame(line: string, index: number): StackFrame | undefined {
  const match = V8_FRAME.exec(line);
  const [, fn, location, lineno, colno] = match ?? [];
  if (!location || !lineno) return undefined;
  return {
    index,
    filename: toFilePath(location),
    function: fn ?? "?",
    lineno: Number(lineno),
    colno: colno ? Number(colno) : undefined,
  };
}

function parseV8Stack(stack: string, maxFrames: number): StackFrame[] {
  return stack
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .slice(0, maxFrames)
    .map((line, index) => parseV8Frame(line.slice(0, 1024), index))
    .filter((frame): frame is StackFrame => frame !== undefined);
}

function isInAppFile(filename: string): boolean {
  return isAbsolute(filename) && !filename.includes("/node_modules/");
}

function isProbablyMinified(frame: StackFrame): boolean {
  return frame.lineno > MINIFIED_ABOVE_LINENO || (frame.colno ?? 0) > MINIFIED_ABOVE_COLNO;
}

class SourceFileCache {
  private readonly files = new Map<string, string[] | null>();

  constructor(private readonly capacity: number, private readonly maxFileBytes: number) {}

  lines(path: string): string[] | null {
    const cached = this.files.get(path);
    if (cached !== undefined) {
      this.files.delete(path);
      this.files.set(path, cached);
      return cached;
    }
    const lines = this.read(path);
    this.files.set(path, lines);
    if (this.files.size > this.capacity) {
      this.files.delete(this.files.keys().next().value as string);
    }
    return lines;
  }

  private read(path: string): string[] | null {
    try {
      if (statSync(path).size > this.maxFileBytes) return null;
      return readFileSync(path, "utf8").split(/\r?\n/);
    } catch {
      return null;
    }
  }
}

function sourceMapReference(generatedLines: string[]): string | undefined {
  for (let i = generatedLines.length - 1; i >= 0; i--) {
    const line = generatedLines[i] ?? "";
    const match = SOURCE_MAPPING_URL.exec(line);
    if (match) return match[1];
    if (line.trim() !== "") return undefined;
  }
  return undefined;
}

function decodeInlineSourceMap(reference: string): SourceMapPayload | undefined {
  const encoded = /^data:application\/json[^,]*;base64,(.+)$/.exec(reference)?.[1];
  return encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : undefined;
}

function loadSourceMap(
  generatedFile: string,
  generatedLines: string[],
  cache: SourceFileCache,
): { payload: SourceMapPayload; mapDir: string } | undefined {
  const reference = sourceMapReference(generatedLines);
  if (!reference) return undefined;
  if (reference.startsWith("data:")) {
    const payload = decodeInlineSourceMap(reference);
    return payload && { payload, mapDir: dirname(generatedFile) };
  }
  const mapFile = resolve(dirname(generatedFile), toFilePath(reference));
  const mapLines = cache.lines(mapFile);
  return mapLines ? { payload: JSON.parse(mapLines.join("\n")), mapDir: dirname(mapFile) } : undefined;
}

function originalSourceLines(
  payload: SourceMapPayload,
  source: string,
  originalFile: string,
  cache: SourceFileCache,
): string[] | null {
  const embedded = payload.sourcesContent?.[payload.sources.indexOf(source)];
  return embedded != null ? embedded.split(/\r?\n/) : cache.lines(originalFile);
}

function mapToOriginalPosition(
  frame: StackFrame,
  generatedLines: string[],
  cache: SourceFileCache,
): SourcePosition | undefined {
  const map = loadSourceMap(frame.filename, generatedLines, cache);
  if (!map) return undefined;
  const entry = new SourceMap(map.payload).findEntry(frame.lineno - 1, (frame.colno ?? 1) - 1);
  if (!("originalSource" in entry)) return undefined;
  const originalFile = resolve(map.mapDir, map.payload.sourceRoot ?? "", toFilePath(entry.originalSource));
  const lines = originalSourceLines(map.payload, entry.originalSource, originalFile, cache);
  return lines
    ? { filename: originalFile, lineno: entry.originalLine + 1, colno: entry.originalColumn + 1, lines }
    : undefined;
}

function stackIsUnmapped(filename: string): boolean {
  return !process.sourceMapsEnabled && !TYPESCRIPT_FILE.test(filename);
}

function resolveSourcePosition(frame: StackFrame, cache: SourceFileCache): SourcePosition | undefined {
  const lines = cache.lines(frame.filename);
  if (!lines) return undefined;
  const asIs = { filename: frame.filename, lineno: frame.lineno, colno: frame.colno, lines };
  if (!stackIsUnmapped(frame.filename)) return asIs;
  try {
    return mapToOriginalPosition(frame, lines, cache) ?? asIs;
  } catch {
    return asIs;
  }
}

function snipLine(line: string, colno: number | undefined, maxLength: number): string {
  if (line.length <= maxLength) return line;
  const window = maxLength - 10;
  const column = Math.min(colno ?? 0, line.length);
  let start = Math.max(column - 60, 0);
  if (start < 5) start = 0;
  let end = Math.min(start + window, line.length);
  if (end > line.length - 5) end = line.length;
  if (end === line.length) start = Math.max(end - window, 0);
  return `${start > 0 ? "{snip} " : ""}${line.slice(start, end)}${end < line.length ? " {snip}" : ""}`;
}

function toFrameContext(
  frame: StackFrame,
  position: SourcePosition,
  { linesOfContext, maxLineLength }: Required<ContextLinesOptions>,
): FrameContext | undefined {
  const lineIndex = position.lineno - 1;
  const contextLine = position.lines[lineIndex];
  if (contextLine === undefined) return undefined;
  const snip = (line: string) => snipLine(line, position.colno, maxLineLength);
  const mapped = position.filename !== frame.filename || position.lineno !== frame.lineno;
  return {
    index: frame.index,
    filename: position.filename,
    function: frame.function,
    lineno: position.lineno,
    colno: position.colno,
    in_app: true,
    pre_context: position.lines.slice(Math.max(0, lineIndex - linesOfContext), lineIndex).map(snip),
    context_line: snip(contextLine),
    post_context: position.lines.slice(lineIndex + 1, lineIndex + 1 + linesOfContext).map(snip),
    ...(mapped ? { generated: { filename: frame.filename, lineno: frame.lineno, colno: frame.colno } } : {}),
  };
}

function serializeWithinBudget(frames: FrameContext[], maxBytes: number): string | undefined {
  for (let kept = frames.length; kept > 0; kept--) {
    const json = JSON.stringify(frames.slice(0, kept));
    if (Buffer.byteLength(json) <= maxBytes) return json;
  }
  return undefined;
}

// Must precede the exporting processor: a full batch exports inside its own onEmit,
// and records turn read-only once the last onEmit returns
export class ContextLinesProcessor implements LogRecordProcessor {
  private readonly options: Required<ContextLinesOptions>;
  private readonly cache: SourceFileCache;

  constructor(options: ContextLinesOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.cache = new SourceFileCache(this.options.cacheSize, this.options.maxFileBytes);
  }

  onEmit(logRecord: SdkLogRecord, _context?: Context): void {
    const stack = logRecord.attributes[ATTR_EXCEPTION_STACKTRACE];
    if (typeof stack !== "string") return;
    // Logger.emit has no try/catch: a throw here escapes into captureException's caller
    try {
      const json = this.contextLinesFor(stack);
      if (json) logRecord.setAttribute(ATTR_EXCEPTION_CONTEXT_LINES, json);
    } catch {
      return;
    }
  }

  private contextLinesFor(stack: string): string | undefined {
    const frames = parseV8Stack(stack, this.options.maxFrames)
      .filter((frame) => isInAppFile(frame.filename) && !isProbablyMinified(frame))
      .map((frame) => {
        const position = resolveSourcePosition(frame, this.cache);
        return position && toFrameContext(frame, position, this.options);
      })
      .filter((frame): frame is FrameContext => frame !== undefined);
    return frames.length ? serializeWithinBudget(frames, this.options.maxAttributeBytes) : undefined;
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
