/** The menu bar: its panel, title, icon, switch window and story, and the global shortcuts. */
import { app, globalShortcut, systemPreferences } from "electron";
import path from "node:path";
import { sceneView, SwitchStory, type SwitchSceneView } from "../../shared/switch-scene";
import { GlobalShortcuts } from "../core/global-shortcuts";
import { MenuBarTitle } from "../core/menu-bar-title";
import { motionAllowed, readDesktopForTray } from "../core/tray-mascot";
import { loadWindowSpace } from "../core/window-space";
import { getAppLocale } from "../i18n";
import { SwitchWindow } from "../switch-window";
import { RelayTray } from "../tray";
import { TrayPanel } from "../tray-panel";
import { desktopLock } from "./desktop-lock";
import { alignWorkspacesLater } from "./desktop-support";
import { logDraftEvent } from "./logs";
import {
  desktop,
  globalShortcuts,
  keeper,
  menuBarTitle,
  observedDesktop,
  service,
  set,
  switchWindow,
  tray,
  trayPanel,
  trayTimer,
  usage,
} from "./state";
import { trayToday, widgetActiveId, writeWidget } from "./tokens-widget";
import { openFromShortcut, switchFromShortcut, traySwitch } from "./tray-actions";
import { loadPage, showWindow } from "./windows";
export function createTrayStack() {
      if (process.platform === "darwin")
        set.trayPanel(new TrayPanel({
          preload: path.join(__dirname, "preload.cjs"),
          load: (win) => loadPage(win, "panel.html"),
          onEvent: logDraftEvent,
          onActiveSpace: loadWindowSpace(__dirname),
          onVisibilityChange: () => {
            try {
              switchWindow?.sync();
            } catch {
              // The switch window never affects the menu bar panel.
            }
          },
        }));
      /** Unreadable attempts only cost the panda its warm-up, never the tray. */
      const recentKeeperAttempts = () => {
        try {
          return keeper.recentAttempts();
        } catch {
          return undefined;
        }
      };
      set.menuBarTitle(new MenuBarTitle(path.join(app.getPath("userData"), "menu-bar.json")));
      set.tray(new RelayTray({
        getSnapshot: async () => {
          const read = await readDesktopForTray({
            // Every 5 s: the shared cached reading. Through observedDesktop it feeds
            // keeperBlocked() and the keeper's activeId between keeper runs; the keeper's
            // start and guard read a fresh snapshot before they act.
            read: () => desktop.cachedSnapshot(),
            busy: () => desktop.isBusy || desktopLock.busy,
            operations: () => desktopLock.operations + desktop.operations,
          });
          set.observedDesktop(read.state);
          alignWorkspacesLater();
          // The widgets show the account open in Claude: a switch reaches them now.
          if (read.state.activeProfileId !== widgetActiveId) writeWidget();
          return (set.lastTraySnapshot({
            accounts: service.store.state.accounts,
            usage: usage.snapshot(),
            desktop: { ...read.state, busy: read.busy },
            authBusy: service.auth
              .list()
              .some((f) =>
                ["starting", "waiting", "verifying"].includes(f.status),
              ),
            attempts: recentKeeperAttempts(),
            // The title names a switch's target and gives a full window's reset in the planning zone.
            switchingTo: desktop.switchingTo,
            timeZone: service.store.state.settings.planning.timeZone,
            // The items the user chose for the title, and today's figures some of them show.
            titleItems: menuBarTitle?.current.items,
            today: trayToday,
          }));
        },
        showWindow,
        requestSwitch: (profileId) => void traySwitch(profileId),
        quit: () => app.quit(),
        language: () => getAppLocale(),
        panel: trayPanel,
        motionAllowed: () =>
          motionAllowed(service.store.state.settings, () =>
            systemPreferences.getAnimationSettings(),
          ),
      }));
      if (process.platform === "darwin") {
        // The story is decoration: if it cannot start, Relay starts without it.
        try {
          set.switchWindow(new SwitchWindow({
            preload: path.join(__dirname, "switch-preload.cjs"),
            load: (win) => loadPage(win, "switch.html"),
            anchor: () => tray?.bounds(),
            enabled: () => service.store.state.settings.switchWindow !== false,
            panelOpen: () => !!trayPanel?.isOpen(),
          }));
          const story = new SwitchStory({
            show: (state) =>
              switchWindow?.show(
                sceneView(state, {
                  language: getAppLocale(),
                  name: (id) =>
                    service.store.state.accounts.find((a) => a.id === id)?.name,
                  percent: (id) => usage.snapshot()[id]?.fiveHour?.usedPercent,
                  motion: motionAllowed(service.store.state.settings, () =>
                    systemPreferences.getAnimationSettings(),
                  ),
                }),
              ),
          });
          set.switchStory(story);
          // Real restarts only: lock holders that never quit Claude stay silent.
          // A start names the account Claude had open, for the window's from → to line.
          desktop.onRestart = (event) =>
            story.report(
              event.phase === "start"
                ? { ...event, fromId: observedDesktop?.activeProfileId }
                : event,
            );
          // The window exists only during a story, so the smoke test starts one scene through it.
          // A packaged Relay has no such hook.
          if (!app.isPackaged)
            Object.assign(globalThis, {
              relaySmokeSwitchScene: (view: SwitchSceneView) =>
                switchWindow?.show(view),
            });
        } catch {
          switchWindow?.destroy();
          set.switchWindow(undefined);
          set.switchStory(undefined);
          desktop.onRestart = undefined;
        }
      }
      set.trayTimer(setInterval(() => tray?.update(), 5000));
      trayTimer!.unref();
      set.globalShortcuts(new GlobalShortcuts(
        globalShortcut,
        { openPanel: openFromShortcut, switchToSuggested: () => void switchFromShortcut() },
        logDraftEvent,
      ));
      globalShortcuts!.apply(service.store.state.settings.shortcuts);
}
