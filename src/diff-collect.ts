const fileMark = "diff --git ";
const nextFile = "\ndiff --git ";

function quotedDestination(rest: string): string | undefined {
  const fields = [...rest.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) =>
    (match[1] ?? "").replace(/\\(.)/g, "$1"),
  );
  const destination = fields[1];
  return destination?.startsWith("b/") ? destination.slice(2) : destination;
}

export function diffDestination(header: string): string | undefined {
  if (!header.startsWith(fileMark)) return undefined;
  const rest = header.slice(fileMark.length);
  if (rest.startsWith('"')) return quotedDestination(rest);
  const splitAt = rest.lastIndexOf(" b/");
  if (splitAt < 0) return undefined;
  return rest.slice(splitAt + 3);
}

// Reads a unified diff in chunks and keeps only files that fit in maxFileBytes.
export class DiffCollector {
  private readonly kept: string[] = [];
  private readonly omittedFiles: string[] = [];
  private pending = "";
  private current = "";
  private currentBytes = 0;
  private currentPath: string | undefined;
  private skipping = false;
  private tail = "";

  constructor(private readonly maxFileBytes: number) {}

  push(chunk: string): void {
    if (this.skipping) {
      this.skip(chunk);
      return;
    }
    this.pending += chunk;
    this.drain();
  }

  finish(): { diff: string; omittedFiles: string[] } {
    if (!this.skipping && this.pending) this.takeLine(this.pending);
    this.pending = "";
    this.keepCurrent();
    return { diff: this.kept.join(""), omittedFiles: [...this.omittedFiles] };
  }

  private drain(): void {
    while (!this.skipping) {
      const newline = this.pending.indexOf("\n");
      if (newline < 0) {
        if (
          this.currentPath !== undefined &&
          this.currentBytes + Buffer.byteLength(this.pending) >
            this.maxFileBytes
        ) {
          this.dropCurrent();
          const rest = this.pending;
          this.pending = "";
          this.skip(rest);
        }
        return;
      }
      const line = this.pending.slice(0, newline + 1);
      this.pending = this.pending.slice(newline + 1);
      this.takeLine(line);
    }
  }

  private takeLine(line: string): void {
    if (line.startsWith(fileMark)) {
      this.keepCurrent();
      this.currentPath = diffDestination(line.trimEnd()) ?? "unknown";
    }
    if (this.currentPath === undefined) return;
    const bytes = Buffer.byteLength(line);
    if (this.currentBytes + bytes > this.maxFileBytes) {
      this.dropCurrent();
      const rest = this.pending;
      this.pending = "";
      this.skip(rest);
      return;
    }
    this.current += line;
    this.currentBytes += bytes;
  }

  private keepCurrent(): void {
    if (!this.currentPath || !this.current) {
      this.currentPath = undefined;
      this.current = "";
      this.currentBytes = 0;
      return;
    }
    this.kept.push(this.current);
    this.current = "";
    this.currentBytes = 0;
    this.currentPath = undefined;
  }

  private dropCurrent(): void {
    if (this.currentPath) this.omittedFiles.push(this.currentPath);
    this.current = "";
    this.currentBytes = 0;
    this.currentPath = undefined;
  }

  private skip(chunk: string): void {
    this.skipping = true;
    const pending = this.tail + chunk;
    const resume = pending.startsWith(fileMark)
      ? 0
      : pending.indexOf(nextFile) + 1;
    if (resume <= 0 && !pending.startsWith(fileMark)) {
      this.tail = pending.slice(-(nextFile.length - 1));
      return;
    }
    this.tail = "";
    this.skipping = false;
    this.pending = pending.slice(resume);
    this.drain();
  }
}
