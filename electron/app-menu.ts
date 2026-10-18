import type { MenuItemConstructorOptions } from "electron";
import { pick, type AppLanguage } from "./language";

const separator: MenuItemConstructorOptions = { type: "separator" };

/**
 * The application menu, in the app's language. Cmd+Q closes the window to the menu bar and
 * Alt+Cmd+Q quits (there is no stock quit role); Cmd+W closes the focused window. Pure, so main
 * rebuilds it whenever the language changes and the tests read it in both languages.
 */
export function appMenuTemplate(
  language: AppLanguage,
  actions: { closeToTray(): void; quit(): void; closeWindow(): void },
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const t = pick(language);
  return [
    ...(platform === "darwin"
      ? [
          {
            label: "Relay",
            submenu: [
              { role: "about", label: t("Relay hakkında", "About Relay") },
              separator,
              { role: "hide", label: t("Relay’i gizle", "Hide Relay") },
              {
                label: t("Relay penceresini kapat", "Close Relay window"),
                accelerator: "CmdOrCtrl+Q",
                click: () => actions.closeToTray(),
              },
              {
                label: t("Relay’den çık", "Quit Relay"),
                accelerator: "Alt+CmdOrCtrl+Q",
                click: () => actions.quit(),
              },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: t("Düzenle", "Edit"),
      submenu: [
        { role: "undo", label: t("Geri al", "Undo") },
        { role: "redo", label: t("Yinele", "Redo") },
        separator,
        { role: "cut", label: t("Kes", "Cut") },
        { role: "copy", label: t("Kopyala", "Copy") },
        { role: "paste", label: t("Yapıştır", "Paste") },
        { role: "selectAll", label: t("Tümünü seç", "Select All") },
      ],
    },
    {
      label: t("Görünüm", "View"),
      submenu: [
        { role: "resetZoom", label: t("Gerçek boyut", "Actual Size") },
        { role: "zoomIn", label: t("Yakınlaştır", "Zoom In") },
        { role: "zoomOut", label: t("Uzaklaştır", "Zoom Out") },
        separator,
        {
          role: "togglefullscreen",
          label: t("Tam ekran", "Toggle Full Screen"),
        },
      ],
    },
    {
      label: t("Pencere", "Window"),
      role: "window",
      submenu: [
        { role: "minimize", label: t("Küçült", "Minimize") },
        { role: "zoom", label: t("Büyüt", "Zoom") },
        separator,
        {
          label: t("Pencereyi kapat", "Close Window"),
          accelerator: "CmdOrCtrl+W",
          click: () => actions.closeWindow(),
        },
      ],
    },
  ];
}
