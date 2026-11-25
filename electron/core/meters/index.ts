import {
  METER_INTERVAL_MS,
  METER_PROVIDERS,
  type MeterProvider,
  type MeterReading,
} from "../../../shared/meters";
import { MeterError, type MeterRead } from "./common";
import { readCopilot } from "./copilot";
import { readCursor } from "./cursor";
import { readGeminiCli } from "./gemini-cli";

export type MeterReader = () => Promise<MeterRead>;

/** Each meter's reader; every one reads an endpoint the tool itself uses, none a documented API. */
export const METER_READERS: Record<MeterProvider, MeterReader> = {
  copilot: () => readCopilot(),
  cursor: () => readCursor(),
  "gemini-cli": () => readGeminiCli(),
};

const SOURCE: Record<MeterProvider, MeterReading["source"]> = {
  copilot: "unofficial",
  cursor: "unofficial",
  "gemini-cli": "unofficial",
};

/** How often main asks whether a meter is due; the meter itself reads at most every interval. */
const CHECK_MS = 60_000;

/**
 * The meters turned on in Settings → Other tools, read in main. Each is read when it is turned on
 * and then at most every `intervalMs` (later when the provider asked to wait), never while off. A
 * failed read keeps the windows of the read before it and says why beside them. The readings
 * carry no token: the readers keep theirs to the request.
 */
export class MeterService {
  private readonly readings = new Map<MeterProvider, MeterReading>();
  /** The earliest time each meter may be read again; kept while it is off, so off and on again does not read sooner. */
  private readonly due = new Map<MeterProvider, number>();
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly options: {
      enabled: () => readonly MeterProvider[];
      readers?: Partial<Record<MeterProvider, MeterReader>>;
      now?: () => number;
      intervalMs?: number;
      /** A reading changed: the windows are told to read the snapshot again. */
      onChange?: () => void;
      /** A failed read, redacted: the meter, the step and a status. */
      log?: (line: string) => void;
    },
  ) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }

  /** The enabled meters' readings in Relay's order; one not read yet has no windows and no `readAt`. */
  snapshot(): MeterReading[] {
    const enabled = this.options.enabled();
    return METER_PROVIDERS.filter((provider) => enabled.includes(provider)).map(
      (provider) =>
        this.readings.get(provider) ?? {
          provider,
          windows: [],
          source: SOURCE[provider],
        },
    );
  }

  /** Reads every enabled meter that is due; one pass at a time. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass() {
    const enabled = this.options.enabled();
    const due = METER_PROVIDERS.filter(
      (provider) =>
        enabled.includes(provider) &&
        (this.due.get(provider) ?? 0) <= this.now(),
    );
    if (!due.length) return;
    await Promise.all(due.map((provider) => this.read(provider)));
    this.options.onChange?.();
  }

  private async read(provider: MeterProvider) {
    const interval = this.options.intervalMs ?? METER_INTERVAL_MS;
    const reader = this.options.readers?.[provider] ?? METER_READERS[provider];
    // Set before the read, so a read that hangs is not started again by the next tick.
    this.due.set(provider, this.now() + interval);
    const before = this.readings.get(provider);
    try {
      const read = await reader();
      this.readings.set(provider, {
        provider,
        ...(read.label ? { label: read.label } : {}),
        windows: read.windows,
        source: SOURCE[provider],
        readAt: new Date(this.now()).toISOString(),
      });
    } catch (error) {
      const failure =
        error instanceof MeterError
          ? error
          : new MeterError("unavailable", undefined, "read failed");
      if (failure.retryAt !== undefined)
        this.due.set(
          provider,
          Math.max(failure.retryAt, this.now() + interval),
        );
      if (before?.error?.issue !== failure.issue)
        this.options.log?.(
          `${provider}: ${failure.issue}${failure.detail ? ` (${failure.detail})` : ""}`,
        );
      this.readings.set(provider, {
        ...(before ?? { provider, windows: [], source: SOURCE[provider] }),
        error: {
          issue: failure.issue,
          ...(failure.retryAt !== undefined
            ? { retryAt: new Date(failure.retryAt).toISOString() }
            : {}),
        },
      });
    }
  }

  start() {
    this.timer ??= setInterval(() => void this.tick(), CHECK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
