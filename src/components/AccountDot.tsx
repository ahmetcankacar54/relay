import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** An account's colour as a dot, in the same tints as its avatar (`avatarClass`). */
const dot = cva("shrink-0 rounded-full", {
  variants: {
    color: {
      terra: "bg-orange-500 dark:bg-orange-400",
      olive: "bg-lime-600 dark:bg-lime-400",
      blue: "bg-sky-500 dark:bg-sky-400",
      plum: "bg-purple-500 dark:bg-purple-400",
      none: "bg-muted-foreground/50",
    },
    size: { sm: "size-2", md: "size-2.5" },
  },
  defaultVariants: { color: "none", size: "sm" },
});

type DotColor = "terra" | "olive" | "blue" | "plum";
const known = (color: string | undefined): color is DotColor => ["terra", "olive", "blue", "plum"].includes(color ?? "");

export function AccountDot({ color, size, className }: { color: string | undefined; size?: "sm" | "md"; className?: string }) {
  return <span aria-hidden="true" className={cn(dot({ color: known(color) ? color : "none", size }), className)} />;
}
