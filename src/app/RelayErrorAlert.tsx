import { Banner } from "@/components/Banner";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { localizeError } from "../messages";

/** The current Relay or Desktop error, for surfaces (dialogs) that cover the page banners. */
export function RelayErrorAlert() {
  const relay = useRelay();
  const { t, language } = useI18n();
  const message = relay.error || relay.desktop?.error;
  if (!message) return null;
  return (
    <Banner
      tone="error"
      role="alert"
      onDismiss={() => void relay.dismissError()}
      dismissLabel={t("Hatayı kapat", "Dismiss error")}
    >
      <span>{localizeError(message, language)}</span>
    </Banner>
  );
}
