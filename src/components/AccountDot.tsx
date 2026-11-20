import { cva } from "class-variance-authority";
import { accountColor, accountFill } from "@/lib/account-color";
import { cn } from "@/lib/utils";

export { accountColor };

const dot = cva("shrink-0 rounded-full", {
  variants: { size: { sm: "size-2", md: "size-2.5" } },
  defaultVariants: { size: "sm" },
});

/** An account's colour as a dot: the same colour as its lane, its bars and its chart series. */
export function AccountDot({ color, size, className }: { color: string | undefined; size?: "sm" | "md"; className?: string }) {
  return <span aria-hidden="true" className={cn(dot({ size }), accountFill(color), className)} />;
}
