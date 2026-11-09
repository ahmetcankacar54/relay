import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/**
 * Relay's own icons: a 24 px grid, a 1.5 px line with round ends and corners, simple outlines, as in
 * the macOS and Claude apps. The size follows the text (1em) unless a class sets it.
 */
function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Overview: a window split into a header and two panes. */
export function OverviewIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.75" y="3.75" width="16.5" height="16.5" rx="4" />
      <path d="M3.75 9.75h16.5M10.5 9.75v10.5" />
    </Icon>
  );
}

/** Accounts: a person, and a second one behind. */
export function AccountsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9.5" cy="8.25" r="3.25" />
      <path d="M3.75 19.25c.55-3.05 2.85-5 5.75-5s5.2 1.95 5.75 5" />
      <path d="M15.25 5.2a3.25 3.25 0 0 1 0 6.1M17.5 14.6c1.5.8 2.45 2.35 2.75 4.65" />
    </Icon>
  );
}

/** Proxy & Gateway: one node that fans out into three routes. */
export function ProxyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5.5" cy="12" r="2" />
      <circle cx="18.5" cy="5.75" r="2" />
      <circle cx="18.5" cy="12" r="2" />
      <circle cx="18.5" cy="18.25" r="2" />
      <path d="M7.5 12h9M7.2 11l9.3-4.2M7.2 13l9.3 4.2" />
    </Icon>
  );
}

/** Usage: three bars of rising height. */
export function UsageIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.75" y="12.5" width="4" height="7.75" rx="1.25" />
      <rect x="10" y="7.5" width="4" height="12.75" rx="1.25" />
      <rect x="16.25" y="3.75" width="4" height="16.5" rx="1.25" />
    </Icon>
  );
}

/** Tokens and cost: a stack of three coins. */
export function TokensIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <ellipse cx="12" cy="6.5" rx="7.25" ry="2.75" />
      <path d="M4.75 6.5v5.5c0 1.5 3.25 2.75 7.25 2.75s7.25-1.25 7.25-2.75V6.5" />
      <path d="M4.75 12v5.5c0 1.5 3.25 2.75 7.25 2.75s7.25-1.25 7.25-2.75V12" />
    </Icon>
  );
}

/** Pins: a round badge on a ribbon. */
export function PinsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="9.25" r="5.5" />
      <path d="m8.75 13.75-1.5 6.5 4.75-2.25 4.75 2.25-1.5-6.5" />
      <circle cx="12" cy="9.25" r="2" />
    </Icon>
  );
}

/** Settings: two sliders. */
export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.75 7.5h9M17.75 7.5h2.5M3.75 16.5h2.5M11.25 16.5h9" />
      <circle cx="15.25" cy="7.5" r="2.5" />
      <circle cx="8.75" cy="16.5" r="2.5" />
    </Icon>
  );
}

/** Read again: a circle that is almost closed, with its arrow head. */
export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19.25 12a7.25 7.25 0 1 1-2.2-5.2" />
      <path d="M19.25 4.5v4.25H15" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.75" cy="10.75" r="6.25" />
      <path d="m15.5 15.5 4.25 4.25" />
    </Icon>
  );
}

export function BackIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m14.5 5.75-6.25 6.25 6.25 6.25" />
    </Icon>
  );
}

/** Show or hide the sidebar: a window with its left column. */
export function SidebarIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="3.5" />
      <path d="M9.25 4.75v14.5" />
    </Icon>
  );
}
