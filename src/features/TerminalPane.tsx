import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { RelayAPI, Run, TerminalEvent } from "../../shared/types";
import { terminalTheme } from "../lib/terminal-theme";

export default function TerminalPane({
  run,
  api,
  onError,
}: {
  run: Run;
  api: RelayAPI;
  onError: (error: unknown) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    if (!element.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.3,
      fontFamily: "Menlo, Consolas, monospace",
      scrollback: 5000,
      allowProposedApi: false,
      theme: terminalTheme,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current);
    let disposed = false;
    let hydrated = false;
    let sequence = 0;
    const queued: (TerminalEvent & { sequence?: number })[] = [];
    const apply = (event: TerminalEvent & { sequence?: number }) => {
      if (event.data && (event.sequence ?? 0) > sequence) {
        terminal.write(event.data);
        sequence = event.sequence!;
      }
      if (event.exitCode !== undefined)
        terminal.write(
          `\r\n\x1b[90m[İşlem sonlandı · çıkış ${event.exitCode}]\x1b[0m\r\n`,
        );
    };
    const unsubscribe = api.onTerminal((event) => {
      if (event.runId !== run.id || disposed) return;
      if (!hydrated) queued.push(event);
      else apply(event);
    });
    void api
      .terminalBuffer(run.id)
      .then((buffer) => {
        if (disposed) return;
        terminal.write(buffer.data);
        sequence = buffer.sequence;
        hydrated = true;
        queued.forEach(apply);
        if (
          buffer.status === "exited" &&
          !queued.some((e) => e.exitCode !== undefined)
        )
          terminal.write(
            "\r\n\x1b[90m[Bu terminal kapandı. Geçmiş, oturum kataloğunda saklanır.]\x1b[0m\r\n",
          );
        terminal.focus();
      })
      .catch((error) => errorRef.current(error));
    const input = terminal.onData((data) => api.terminalWrite(run.id, data));
    const resize = () => {
      if (
        !disposed &&
        element.current?.clientWidth &&
        element.current?.clientHeight
      ) {
        fit.fit();
        api.terminalResize(
          run.id,
          Math.max(10, terminal.cols),
          Math.max(3, terminal.rows),
        );
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element.current);
    resize();
    return () => {
      disposed = true;
      unsubscribe();
      input.dispose();
      observer.disconnect();
      terminal.dispose();
    };
  }, [run.id, api]);
  return (
    <div
      className="terminal"
      ref={element}
      aria-label={`${run.title} Claude terminali`}
    />
  );
}
