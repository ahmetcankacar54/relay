import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Card heading with a one-line description. */
export function SectionHeading({
  title,
  description,
  icon,
  aside,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  aside?: ReactNode;
  id?: string;
}) {
  return (
    <div className="mb-1 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3
          id={id}
          className="flex items-center gap-2 font-display text-sm font-semibold"
        >
          {icon}
          {title}
        </h3>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {aside}
    </div>
  );
}

/**
 * A titled group of setting rows (direction A): a small heading above one bordered box, the rows
 * inside it divided by hairlines, as in the macOS settings.
 */
export function SettingGroup({
  title,
  id,
  className,
  children,
}: {
  title: ReactNode;
  id: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} data-slot="setting-group" className="grid gap-1.5">
      <h3 id={id} className="px-1 text-xs font-semibold text-muted-foreground">
        {title}
      </h3>
      <div className={cn("rounded-lg border bg-card px-3", className)}>{children}</div>
    </section>
  );
}

/** Label and description on the left, a control on the right. */
export function SettingRow({
  label,
  htmlFor,
  description,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 border-t border-border py-2 first:border-t-0">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-sm">
          {label}
        </label>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Note({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      {children}
    </p>
  );
}

/** Shadcn select that always shows the current label (also in static markup). */
export function OptionSelect<V extends string>({
  id,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  id?: string;
  value: V;
  options: { value: V; label: string; disabled?: boolean }[];
  onChange: (value: V) => void;
  disabled?: boolean;
  className?: string;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(v) => onChange(v as V)}
    >
      <SelectTrigger id={id} className={cn("min-w-44", className)}>
        <SelectValue>{current?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
