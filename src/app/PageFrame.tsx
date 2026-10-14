import type { ReactNode } from "react";
import { PageHeader } from "./PageHeader";
import { Banners } from "./Banners";
import { ConnectionPanels } from "./ConnectionPanels";

/** Shared page chrome: header, global banners and in-progress connection panels above the content. */
export function PageFrame({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} description={description} actions={actions} />
      <Banners />
      <ConnectionPanels />
      {children}
    </>
  );
}
