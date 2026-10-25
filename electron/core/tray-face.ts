/** The part of Electron's Tray that shows the menu bar item. */
export interface TrayFaceTarget<I> {
  setTitle(title: string, options?: { fontType?: "monospacedDigit" }): void;
  setToolTip(tooltip: string): void;
  setImage(image: I): void;
}

/**
 * Sets the tray's title, tooltip and image only when they change: the tray
 * refreshes every few seconds, and each call redraws the menu bar item. A value
 * the tray refused (the call threw) is set again next time.
 */
export class TrayFace<I> {
  private title?: string;
  private tooltip?: string;
  private image?: string;
  constructor(private readonly tray: TrayFaceTarget<I>) {}
  setTitle(title: string) {
    if (title === this.title) return;
    // Digits of one width: a countdown or a percent that changes never shifts the menu bar items beside it.
    this.tray.setTitle(title, { fontType: "monospacedDigit" });
    this.title = title;
  }
  setToolTip(tooltip: string) {
    if (tooltip === this.tooltip) return;
    this.tray.setToolTip(tooltip);
    this.tooltip = tooltip;
  }
  /** `key` names the image; `image` is only called when the key changed. */
  setImage(key: string, image: () => I) {
    if (key === this.image) return;
    this.tray.setImage(image());
    this.image = key;
  }
}
