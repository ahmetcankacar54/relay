import type { ReactNode } from "react";
import { Check, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import type { Copy } from "./hooks";

/** An address or key as a compact chip; the button copies the real value. */
export function CopyChip({
  id,
  label,
  shown,
  value,
  copy,
  children,
}: {
  id: string;
  label: string;
  shown: string;
  value?: string;
  copy: Copy;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <span className="flex min-w-0 items-center gap-0.5 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2.5">
      <span className="sr-only">{label}: </span>
      <span data-slot={`chip-${id}`} className="truncate font-mono text-xs">
        {shown}
      </span>
      {children}
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!value}
        aria-label={t("proxy.copy", { label })}
        onClick={() => value && copy.copy(id, value)}
      >
        {copy.copied === id ? <Check className="text-ok" /> : <CopyIcon />}
      </Button>
    </span>
  );
}
