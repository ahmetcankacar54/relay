/**
 * What the hidden renewal window does on claude.ai's authorize page, decided from what the page
 * shows. Kept apart from Electron so it can be tested.
 */

export interface ApprovalPage {
  host: string;
  path: string;
  /** The page asks for an email or a password: the session is gone. */
  loginForm: boolean;
  buttons: { text: string; disabled: boolean }[];
}

/** The approval button, in the languages claude.ai shows; whole labels only. */
const APPROVE = /^(authori[sz]e|allow|approve|yetkilendir|izin ver|onayla)$/i;

export type ApprovalStep =
  | { step: "click"; index: number }
  | { step: "signed-out" }
  | { step: "wait" };

export function approvalStep(page: ApprovalPage): ApprovalStep {
  if (page.loginForm || /\/login\b/.test(page.path)) return { step: "signed-out" };
  if (!/(^|\.)claude\.(ai|com)$/.test(page.host)) return { step: "wait" };
  const index = page.buttons.findIndex((b) => !b.disabled && APPROVE.test(b.text.trim()));
  return index >= 0 ? { step: "click", index } : { step: "wait" };
}

/**
 * Runs in the page: what `approvalStep` reads. Button labels only; no field value or address
 * leaves the page.
 */
export const READ_PAGE = `(() => {
  const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit]')];
  return {
    host: location.hostname,
    path: location.pathname,
    loginForm: !!document.querySelector('input[type=email], input[type=password], input[name=email]'),
    buttons: buttons.map((b) => ({ text: String(b.innerText || b.value || '').trim().slice(0, 60), disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true' })),
  };
})()`;

/** Runs in the page: clicks the button `READ_PAGE` listed at `index`, if it is still the same. */
export const clickButton = (index: number, text: string) => `(() => {
  const b = [...document.querySelectorAll('button, [role=button], input[type=submit]')][${index}];
  if (!b || String(b.innerText || b.value || '').trim().slice(0, 60) !== ${JSON.stringify(text)}) return false;
  b.click();
  return true;
})()`;
