'use client';

import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `primary`   -- the accent fill. One per viewport region, and only for the
   *                thing a person is meant to do next (Run GridShift, Approve).
   * `secondary` -- a hairline ring, no fill. Reject, Retry, Reset.
   * `ghost`     -- text only. Tertiary links and repeat actions.
   */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Rendered before the label, inside the same flex row. */
  icon?: ReactNode;
  children?: ReactNode;
}

const BASE = [
  'inline-flex items-center justify-center gap-1.5 rounded-md whitespace-nowrap',
  'font-medium select-none',
  'transition-[filter,color,background-color,box-shadow,transform]',
  'duration-[var(--dur)] ease-[var(--ease)]',
  'active:scale-[0.97]',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
  'disabled:pointer-events-none disabled:opacity-55',
].join(' ');

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink font-semibold hover:brightness-110',
  secondary:
    'text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-2)] hover:text-ink hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)]',
  ghost: 'text-muted hover:text-ink hover:bg-surface-2',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-[13px]',
};

/**
 * The one button primitive. Press compresses, hover brightens, nothing lifts --
 * a lift on a dense dark page reads as a shadow bug on a projector.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(BASE, VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export default Button;
