import type { ReactNode } from "react";
import { PageHeader } from "./PageHeader";
import { Banners } from "./Banners";
import { ConnectionPanels } from "./ConnectionPanels";

/** Shared page chrome: header, global banners and in-progress connection panels above the content. */
export function PageFrame({
  title,
  description,
  actions,
  automationInline,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** The page shows the automation status and its offer itself, so the banner would repeat them. */
  automationInline?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} description={description} actions={actions} />
      <Banners automation={!automationInline} />
      <ConnectionPanels />
      {children}
    </>
  );
}
