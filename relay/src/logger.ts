/**
 * Minimal structured logger for the untrusted relay.
 *
 * The relay only ever holds CIPHERTEXT, so by construction it cannot log a
 * plaintext order field. To make that guarantee testable, all log records go
 * through here and the buffer can be inspected (see relay.test.ts, which greps
 * it for plaintext to prove nothing leaks — CLAUDE.md §5 / Phase 2 exit gate).
 */
export interface LogRecord {
  level: "info" | "warn" | "error";
  msg: string;
  meta?: Record<string, unknown>;
}

export class Logger {
  private readonly buffer: LogRecord[] = [];
  constructor(private readonly echo = true) {}

  private write(rec: LogRecord) {
    this.buffer.push(rec);
    if (this.echo) {
      const line = `[${rec.level}] ${rec.msg}` + (rec.meta ? ` ${JSON.stringify(rec.meta)}` : "");
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }

  info(msg: string, meta?: Record<string, unknown>) {
    this.write({ level: "info", msg, meta });
  }
  warn(msg: string, meta?: Record<string, unknown>) {
    this.write({ level: "warn", msg, meta });
  }
  error(msg: string, meta?: Record<string, unknown>) {
    this.write({ level: "error", msg, meta });
  }

  /** All log text concatenated — used by tests to assert no plaintext leaked. */
  dump(): string {
    return this.buffer
      .map((r) => `${r.msg} ${r.meta ? JSON.stringify(r.meta) : ""}`)
      .join("\n");
  }
}
