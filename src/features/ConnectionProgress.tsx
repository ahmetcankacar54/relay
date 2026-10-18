import { Check, CircleAlert, LoaderCircle, Pause } from "lucide-react";
import { cn } from "@/lib/utils";

type Step = { title: string; detail: string };
export function ConnectionProgress({
  steps,
  current,
  state,
  label,
}: {
  steps: Step[];
  current: number;
  state: "working" | "waiting" | "complete" | "failed" | "cancelled";
  label: string;
}) {
  const stopped = state === "failed" || state === "cancelled";
  return (
    <div className="grid gap-2.5">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 font-medium",
            state === "failed" && "text-destructive",
            state === "cancelled" && "text-muted-foreground",
            state === "complete" && "text-primary",
          )}
        >
          {state === "working" ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : state === "complete" ? (
            <Check className="size-3.5" />
          ) : state === "failed" ? (
            <CircleAlert className="size-3.5" />
          ) : state === "cancelled" ? (
            <Pause className="size-3.5" />
          ) : (
            <span className="size-2 animate-pulse rounded-full bg-brand" />
          )}
          {label}
        </span>
        {!stopped && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {state === "complete" ? steps.length : current + 1} / {steps.length}
          </span>
        )}
      </div>
      <ol
        className={cn(
          "grid gap-2 sm:grid-cols-3",
          stopped && "opacity-60",
        )}
        aria-label={label}
      >
        {steps.map((step, index) => {
          const done = !stopped && (state === "complete" || index < current);
          const active = !stopped && state !== "complete" && index === current;
          return (
            <li
              key={index}
              className={cn(
                "grid grid-cols-[auto_1fr] items-start gap-x-2 rounded-lg border p-2.5",
                active && "border-brand/50 bg-brand/5",
              )}
              aria-current={active ? "step" : undefined}
            >
              <span
                className={cn(
                  "row-span-2 grid size-6 place-items-center rounded-full text-xs font-semibold tabular-nums",
                  done
                    ? "bg-brand text-primary-foreground"
                    : active
                      ? "border-2 border-brand text-primary"
                      : "bg-muted text-muted-foreground",
                )}
                aria-hidden="true"
              >
                {done ? (
                  <Check className="size-3.5" />
                ) : (
                  String(index + 1).padStart(2, "0")
                )}
              </span>
              <strong className="text-sm font-semibold">{step.title}</strong>
              <span className="text-xs text-muted-foreground">
                {step.detail}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
