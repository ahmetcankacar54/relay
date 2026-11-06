import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-sm text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow] outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 active:bg-primary/80",
        destructive:
          "bg-destructive text-white shadow-xs hover:bg-destructive/90 active:bg-destructive/80 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border border-input bg-control shadow-xs hover:bg-muted active:bg-secondary dark:border-transparent dark:hover:bg-control/80 dark:active:bg-control/70",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/70",
        ghost:
          "hover:bg-foreground/5 active:bg-foreground/10",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-7 px-3 has-[>svg]:px-2.5",
        xs: "h-5 gap-1 px-1.5 text-xs has-[>svg]:px-1 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-6 gap-1 px-2.5 has-[>svg]:px-2",
        lg: "h-8 px-4 has-[>svg]:px-3",
        icon: "size-7",
        "icon-xs": "size-5 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-6",
        "icon-lg": "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
