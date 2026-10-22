import { cn } from "@/lib/utils";
const tones = {
  ok: "bg-ok",
  warn: "bg-warn",
  crit: "bg-crit",
  off: "bg-muted-foreground/40",
} as const;
const rings: Record<keyof typeof tones, string> = {
  ok: "border-ok",
  warn: "border-warn",
  crit: "border-crit",
  off: "border-muted-foreground/60",
};
/** A status dot; `hollow` draws it as a ring, for a neutral state (saved, closed) rather than a live one. */
export function StatusDot({
  tone,
  hollow,
  className,
}: {
  tone: keyof typeof tones;
  hollow?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        hollow ? cn("border-[1.5px]", rings[tone]) : tones[tone],
        className,
      )}
    />
  );
}
