import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { EXTERNAL_LINKS } from "../../shared/external-links";

type Link = (typeof EXTERNAL_LINKS)[keyof typeof EXTERNAL_LINKS];

/**
 * A link to one of the allow-listed pages. The main window opens it in the browser through
 * its window-open handler; any other URL is refused there.
 */
export function ExternalLink({
  href,
  children,
}: {
  href: Link;
  children: ReactNode;
}) {
  return (
    <Button asChild variant="link" size="sm" className="h-auto px-0">
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    </Button>
  );
}
