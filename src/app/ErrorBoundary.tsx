import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * A window's last resort. Without it one render error unmounts the whole tree: the window stays
 * blank (the menu bar panel is transparent, so it shows nothing) and its polling stops. It uses
 * no provider, since the provider may be what failed.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const turkish = navigator.language.toLowerCase().startsWith("tr");
    return (
      <div role="alert" className="grid gap-3 p-6 text-sm text-foreground">
        <p className="font-semibold">{turkish ? "Beklenmedik bir hata oluştu." : "This window hit an unexpected error."}</p>
        <p className="text-muted-foreground">
          {turkish ? "Hesaplarına dokunulmadı. Yeniden yüklemek yeterli olur." : "Your accounts were not touched. Reloading should be enough."}
        </p>
        <div>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            {turkish ? "Yeniden yükle" : "Reload"}
          </Button>
        </div>
      </div>
    );
  }
}
