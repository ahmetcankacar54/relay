import { cn } from "@/lib/utils";
const tones = {
  ok: "bg-ok",
  warn: "bg-warn",
  crit: "bg-crit",
  off: "bg-muted-foreground/40",
} as const;
export function StatusDot({
  tone,
  className,
}: {
  tone: keyof typeof tones;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        tones[tone],
        className,
      )}
    />
  );
}
