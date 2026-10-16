import { contextBridge, ipcRenderer } from "electron";
import type { RelaySwitchAPI, SwitchSceneView } from "../shared/switch-scene";

// The switch window only draws; it gets no Relay API.
const api: RelaySwitchAPI = {
  onScene: (callback) => {
    const listener = (_: unknown, view: SwitchSceneView) => callback(view);
    ipcRenderer.on("relay:switch-scene", listener);
    return () => ipcRenderer.removeListener("relay:switch-scene", listener);
  },
  ready: () => ipcRenderer.send("relay:switch-ready"),
};
contextBridge.exposeInMainWorld("relaySwitch", api);
