import { cva } from "class-variance-authority";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AccountProvider } from "../../shared/types";
import { providerLabel, providerShortLabel } from "@/pages/accounts/accountLabels";

/** Each provider's tint, light and dark: terracotta Claude, emerald Codex, indigo Antigravity. */
const providerBadge = cva("", {
  variants: {
    provider: {
      claude:
        "border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900 dark:bg-orange-950/60 dark:text-orange-200",
      codex:
        "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200",
      antigravity:
        "border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-200",
      gemini: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-200",
    },
  },
  defaultVariants: { provider: "claude" },
});

/** Which provider an account belongs to, as a badge in the provider's tint. */
export function ProviderBadge({
  provider,
  full,
  className,
}: {
  provider: AccountProvider | undefined;
  /** `OpenAI / Codex` instead of `Codex`. */
  full?: boolean;
  className?: string;
}) {
  const value = provider ?? "claude";
  return (
    <Badge variant="outline" data-provider={value} className={cn(providerBadge({ provider: value }), className)}>
      {full ? providerLabel(provider) : providerShortLabel(provider)}
    </Badge>
  );
}
