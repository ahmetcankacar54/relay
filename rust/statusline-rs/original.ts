// The unit, plus data-only wrappers for the two exports that take callbacks, so the recorder can
// call them as `relay statusline` does: the snapshot and stdin as text, read by the unit's own
// parsers, a fixed sign-in instead of `signIn()`, and a tagging paint when `color` is set.
import {
  parseStatuslineInput,
  parseStatuslineSnapshot,
  renderStatusline,
  statuslineAccount,
} from "../../shared/statusline";

export * from "../../shared/statusline";

type SignIn = { accountUuid: string; orgId: string } | undefined;

export function renderStatuslineLine(
  snapshotText: string,
  inputText: string,
  configDir: string | undefined,
  signIn: SignIn,
  now: number,
  color: boolean,
): string {
  const snapshot = parseStatuslineSnapshot(snapshotText);
  if (!snapshot) return "";
  return renderStatusline({
    snapshot,
    input: parseStatuslineInput(inputText),
    configDir,
    signIn: () => signIn,
    now,
    paint: (style, text) => (color ? `<${style}>${text}</${style}>` : text),
  });
}

export function statuslineAccountId(
  snapshotText: string,
  inputText: string,
  configDir: string | undefined,
  signIn: SignIn,
): { accountId?: string; viaGateway: boolean } | undefined {
  const snapshot = parseStatuslineSnapshot(snapshotText);
  if (!snapshot) return undefined;
  const { account, viaGateway } = statuslineAccount(
    snapshot,
    parseStatuslineInput(inputText),
    configDir,
    () => signIn,
  );
  return { ...(account ? { accountId: account.id } : {}), viaGateway };
}
