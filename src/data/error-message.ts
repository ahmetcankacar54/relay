// Kept free of browser-only imports so components and tests can use it.

/** An error's message without Electron's "Error invoking remote method" prefix. */
export function errorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (?:\w*Error: )?/,
    "",
  );
}
