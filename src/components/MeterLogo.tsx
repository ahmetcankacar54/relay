import { Github, MousePointer2 } from "lucide-react";
import { ProviderLogo } from "@/components/ProviderLogo";
import type { MeterProvider } from "../../shared/meters";

/**
 * A metered tool's mark beside its name: decorative, the name says it. Gemini CLI has Gemini's own
 * mark; Copilot and Cursor a plain outline icon, since Relay does not carry their logos.
 */
export function MeterLogo({ provider }: { provider: MeterProvider }) {
  if (provider === "gemini-cli") return <ProviderLogo provider="gemini" />;
  const Icon = provider === "copilot" ? Github : MousePointer2;
  return (
    <Icon
      aria-hidden="true"
      data-slot="meter-logo"
      className="size-3.5 shrink-0 text-muted-foreground"
    />
  );
}
