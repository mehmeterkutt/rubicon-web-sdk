import type { DefaultSink, LogLevel, RubiconLogger } from 'rubicon-analytics-core';

/** One line a {@link RecordingLogger} or {@link RecordingSink} received. */
export interface RecordedLine {
  readonly level: LogLevel;
  readonly message: string;
  /** The error passed to a developer's logger; a sink never receives one. */
  readonly error?: unknown;
  /** Whether a sink was asked for the developer-error form of `debug` (Web Logging 1). */
  readonly developerErrorForm?: boolean;
}

/** A developer's logger that keeps every line, the counterpart of the Android `RecordingLogger`. */
export class RecordingLogger {
  readonly lines: RecordedLine[] = [];

  /** The function to hand to the SDK as `logging.logger`. */
  readonly logger: RubiconLogger = (level, message, error) => {
    this.lines.push({ level, message, error });
  };

  /** The messages received so far, oldest first. */
  get messages(): string[] {
    return this.lines.map((line) => line.message);
  }
}

/** A default sink that keeps every line, standing in for the `console` sink of `web`. */
export class RecordingSink implements DefaultSink {
  readonly lines: RecordedLine[] = [];

  write(level: LogLevel, message: string): void {
    this.lines.push({ level, message, developerErrorForm: false });
  }

  writeDeveloperError(message: string): void {
    this.lines.push({ level: 'error', message, developerErrorForm: true });
  }

  /** The messages received so far, oldest first. */
  get messages(): string[] {
    return this.lines.map((line) => line.message);
  }
}
