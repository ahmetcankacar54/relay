import { trayPanel } from "../state";
import { relayPage, window } from "../windows";
/**
 * Only the main frames of the main window and the menu bar panel may call Relay, and only while
 * they show Relay's own pages.
 */
export function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  const allowed = [
    window && !window.isDestroyed() ? window.webContents : undefined,
    trayPanel?.webContents(),
  ];
  if (
    !allowed.includes(event.sender) ||
    event.senderFrame !== event.sender.mainFrame ||
    !relayPage(event.senderFrame?.url)
  )
    throw new Error("Invalid IPC source.");
}
/** Panel-only one-way messages; anything else (including the main window) is ignored. */
export function fromPanel(event: Electron.IpcMainEvent) {
  const panel = trayPanel?.webContents();
  return (
    !!panel && event.sender === panel && event.senderFrame === panel.mainFrame
  );
}
