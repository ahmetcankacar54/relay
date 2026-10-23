import type { Root } from "react-dom/client";
import { PinGallery } from "./PinGallery";

export function render(root: Root) {
  root.render(<PinGallery />);
}
