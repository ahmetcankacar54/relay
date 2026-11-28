import type { Root } from "react-dom/client";
import { mascotTrayFrames } from "../mascot/tray-frames";
import { MascotGallery } from "./MascotGallery";

export function render(root: Root) {
  root.render(<MascotGallery frames={mascotTrayFrames} />);
}
