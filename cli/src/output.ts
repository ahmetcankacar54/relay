import type { CliIO } from "./io";
import type { Flags } from "./args";

export type Style = "bold" | "dim" | "green" | "yellow" | "red" | "cyan";
const CODES: Record<Style, [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  green: [32, 39],
  yellow: [33, 39],
  red: [31, 39],
  cyan: [36, 39],
};

/** Colors only on a terminal, without NO_COLOR and without --no-color. */
export function colorEnabled(io: CliIO, flags: Flags): boolean {
  return io.isTTY && !io.env.NO_COLOR && !flags["no-color"];
}

export function paint(enabled: boolean, style: Style, text: string): string {
  if (!enabled) return text;
  const [on, off] = CODES[style];
  return `\x1b[${on}m${text}\x1b[${off}m`;
}

/** Visible width, ignoring color codes. */
const width = (text: string) => text.replace(/\x1b\[\d+m/g, "").normalize("NFC").length;

/** Columns padded to their widest cell, two spaces apart, headers first. */
export function table(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) =>
    Math.max(...all.map((row) => width(row[column] ?? ""))),
  );
  return all
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1
            ? cell
            : cell + " ".repeat(widths[column] - width(cell)),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function printJson(io: CliIO, value: unknown): void {
  io.stdout(JSON.stringify(value, null, 2));
}
