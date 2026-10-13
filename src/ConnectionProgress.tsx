import { Check, CircleAlert, LoaderCircle, Pause } from "lucide-react";

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
    <div className={`connection-progress ${stopped ? "is-stopped" : ""}`}>
      <div className="progress-summary">
        <span className={`progress-status ${state}`}>
          {state === "working" ? (
            <LoaderCircle className="spin" size={14} />
          ) : state === "complete" ? (
            <Check size={14} />
          ) : state === "failed" ? (
            <CircleAlert size={14} />
          ) : state === "cancelled" ? (
            <Pause size={14} />
          ) : (
            <span className="waiting-dot" />
          )}
          {label}
        </span>
        {!stopped && (
          <span className="progress-count">
            {state === "complete" ? steps.length : current + 1} / {steps.length}
          </span>
        )}
      </div>
      <ol className="connection-steps" aria-label={label}>
        {steps.map((step, index) => {
          const done = !stopped && (state === "complete" || index < current);
          const active = !stopped && state !== "complete" && index === current;
          return (
            <li
              key={index}
              className={done ? "done" : active ? "current" : "upcoming"}
              aria-current={active ? "step" : undefined}
            >
              <span className="step-track" aria-hidden="true">
                <span className="step-number">
                  {done ? (
                    <Check size={15} />
                  ) : (
                    String(index + 1).padStart(2, "0")
                  )}
                </span>
              </span>
              <strong>{step.title}</strong>
              <span className="step-detail">{step.detail}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
