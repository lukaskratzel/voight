export interface SourceFile {
    readonly text: string;
    readonly lineMap: LineMap;
}

export interface SourceSpan {
    readonly start: number;
    readonly end: number;
}

export interface SourceLocation {
    readonly offset: number;
    readonly line: number;
    readonly column: number;
}

export interface LineMap {
    readonly starts: readonly number[];
}

export function createSourceFile(text: string): SourceFile {
    return {
        text,
        lineMap: createLineMap(text),
    };
}

export function createLineMap(text: string): LineMap {
    const starts = [0];

    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "\n") {
            starts.push(index + 1);
        }
    }

    return { starts };
}

export function createSpan(start: number, end: number): SourceSpan {
    return { start, end };
}

export function mergeSpans(first: SourceSpan, second: SourceSpan): SourceSpan {
    return {
        start: Math.min(first.start, second.start),
        end: Math.max(first.end, second.end),
    };
}

export function getLocation(lineMap: LineMap, offset: number): SourceLocation {
    let low = 0;
    let high = lineMap.starts.length - 1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const lineStart = lineMap.starts[mid] ?? 0;
        const nextLineStart = lineMap.starts[mid + 1] ?? Number.MAX_SAFE_INTEGER;

        if (offset < lineStart) {
            high = mid - 1;
            continue;
        }

        if (offset >= nextLineStart) {
            low = mid + 1;
            continue;
        }

        return {
            offset,
            line: mid + 1,
            column: offset - lineStart + 1,
        };
    }

    const fallbackLine = Math.max(0, lineMap.starts.length - 1);
    const fallbackStart = lineMap.starts[fallbackLine] ?? 0;
    return {
        offset,
        line: fallbackLine + 1,
        column: offset - fallbackStart + 1,
    };
}
