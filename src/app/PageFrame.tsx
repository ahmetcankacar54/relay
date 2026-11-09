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
  cliFlowInline,
  back,
  leading,
  badge,
  account,
  children,
}: {
  /** The account this page is about: its sign-in warning stays on the page, not in a banner. */
  account?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** The page shows the automation status and its offer itself, so the banner would repeat them. */
  automationInline?: boolean;
  /** The page shows the usage sign-in in progress itself, next to its row. */
  cliFlowInline?: boolean;
  back?: ReactNode;
  leading?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={actions}
        back={back}
        leading={leading}
        badge={badge}
      />
      <Banners automation={!automationInline} exceptAccount={account} />
      <ConnectionPanels cliFlow={!cliFlowInline} />
      {children}
    </>
  );
}
