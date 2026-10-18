import { I18nProvider } from "./data/i18n";
import { api, RelayProvider } from "./data/useRelay";
import { Shell } from "./app/Shell";

export default function App() {
  return (
    <I18nProvider api={api}>
      {/* Hidden with win.hide(), the window reads as hidden and stops polling. */}
      <RelayProvider pollWhenHidden={false}>
        <Shell />
      </RelayProvider>
    </I18nProvider>
  );
}
