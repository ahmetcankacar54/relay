import type { Root } from "react-dom/client";
import { mascotTrayFrames } from "../../electron/mascot-tray-frames";
import { MascotGallery } from "./MascotGallery";

export function render(root: Root) {
  root.render(<MascotGallery frames={mascotTrayFrames} />);
}
