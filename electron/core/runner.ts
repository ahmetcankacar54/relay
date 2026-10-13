import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { Run, TerminalEvent } from "../../shared/types";

interface ProcessEntry {
  run: Run;
  process: pty.IPty;
  buffer: string;
  sequence: number;
  exited: Promise<void>;
}
export class Runner {
  private entries = new Map<string, ProcessEntry>();
  constructor(
    private emit: (event: TerminalEvent & { sequence?: number }) => void,
  ) {}
  list() {
    return [...this.entries.values()].map((e) => ({ ...e.run }));
  }
  start(
    executable: string,
    args: string[],
    env: Record<string, string>,
    input: Omit<Run, "id" | "status">,
  ): Run {
    // Keep one managed writer per project; separate accounts may still work in different projects.
    const busy = this.list().find(
      (r) => r.status === "running" && r.cwd === input.cwd,
    );
    if (busy)
      throw new Error(
        "Bu hesapta giriş işlemi veya bu projede canlı bir oturum var. Önce Canlı çalışma sekmesinden durdur.",
      );
    // Bound retained terminal memory; active runs are never evicted.
    for (const [id, entry] of this.entries)
      if (this.entries.size >= 20 && entry.run.status === "exited")
        this.entries.delete(id);
    if (this.entries.size >= 20)
      throw new Error("En fazla 20 canlı terminal açılabilir.");
    const proc = pty.spawn(executable, args, {
      name: "xterm-256color",
      cols: 110,
      rows: 30,
      cwd: input.cwd,
      env,
    });
    const run: Run = { ...input, id: randomUUID(), status: "running" };
    let resolveExit!: () => void;
    const entry: ProcessEntry = {
      run,
      process: proc,
      buffer: "",
      sequence: 0,
      exited: new Promise((resolve) => {
        resolveExit = resolve;
      }),
    };
    this.entries.set(run.id, entry);
    proc.onData((data) => {
      // Do not honor OSC 52 clipboard writes originating in model/tool output.
      // xterm does not register a clipboard handler; no shell link callbacks are exposed either.
      entry.buffer = (entry.buffer + data).slice(-512_000);
      this.emit({ runId: run.id, data, sequence: ++entry.sequence });
    });
    proc.onExit(({ exitCode }) => {
      run.status = "exited";
      run.exitCode = exitCode;
      this.emit({ runId: run.id, exitCode });
      resolveExit();
    });
    return { ...run };
  }
  buffer(id: string) {
    const e = this.get(id);
    return { data: e.buffer, sequence: e.sequence, status: e.run.status };
  }
  write(id: string, data: string) {
    const e = this.get(id);
    if (e.run.status === "running") e.process.write(data);
  }
  resize(id: string, cols: number, rows: number) {
    const e = this.get(id);
    if (e.run.status === "running") e.process.resize(cols, rows);
  }
  async stop(id: string) {
    const e = this.get(id);
    if (e.run.status === "exited") return;
    e.process.kill();
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        e.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("İşlem henüz kapanmadı. Aktarım başlatılmadı.")),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  close(id: string) {
    if (this.get(id).run.status === "running")
      throw new Error("Önce çalışan oturumu durdur.");
    this.entries.delete(id);
  }
  private get(id: string) {
    const e = this.entries.get(id);
    if (!e) throw new Error("Terminal bulunamadı.");
    return e;
  }
}
