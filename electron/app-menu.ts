import type { MenuItemConstructorOptions } from "electron";
import type { Locale } from "../shared/i18n/locales";
import { tFor } from "../shared/i18n/translate";

const separator: MenuItemConstructorOptions = { type: "separator" };

/**
 * The application menu, in the app's language. Cmd+Q closes the window to the menu bar and
 * Alt+Cmd+Q quits (there is no stock quit role); Cmd+W closes the focused window. Pure, so main
 * rebuilds it whenever the language changes and the tests read it in both languages.
 */
export function appMenuTemplate(
  language: Locale,
  actions: { closeToTray(): void; quit(): void; closeWindow(): void },
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const t = tFor(language);
  return [
    ...(platform === "darwin"
      ? [
          {
            label: "Relay",
            submenu: [
              { role: "about", label: t("appMenu.aboutRelay") },
              separator,
              { role: "hide", label: t("appMenu.hideRelay") },
              {
                label: t("appMenu.closeRelayWindow"),
                accelerator: "CmdOrCtrl+Q",
                click: () => actions.closeToTray(),
              },
              {
                label: t("appMenu.quitRelay"),
                accelerator: "Alt+CmdOrCtrl+Q",
                click: () => actions.quit(),
              },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: t("appMenu.edit"),
      submenu: [
        { role: "undo", label: t("appMenu.undo") },
        { role: "redo", label: t("appMenu.redo") },
        separator,
        { role: "cut", label: t("appMenu.cut") },
        { role: "copy", label: t("common.copy") },
        { role: "paste", label: t("appMenu.paste") },
        { role: "selectAll", label: t("appMenu.selectAll") },
      ],
    },
    {
      label: t("appMenu.view"),
      submenu: [
        { role: "resetZoom", label: t("appMenu.actualSize") },
        { role: "zoomIn", label: t("appMenu.zoomIn") },
        { role: "zoomOut", label: t("appMenu.zoomOut") },
        separator,
        {
          role: "togglefullscreen",
          label: t("appMenu.toggleFullScreen"),
        },
      ],
    },
    {
      label: t("appMenu.window"),
      role: "window",
      submenu: [
        { role: "minimize", label: t("appMenu.minimize") },
        { role: "zoom", label: t("appMenu.zoom") },
        separator,
        {
          label: t("appMenu.closeWindow"),
          accelerator: "CmdOrCtrl+W",
          click: () => actions.closeWindow(),
        },
      ],
    },
  ];
}
