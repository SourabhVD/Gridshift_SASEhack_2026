import clsx from 'clsx';
import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'good' | 'warn' | 'alert' | 'info';

export interface BadgeProps {
  /** Colour intent. Defaults to 'neutral'. */
  tone?: BadgeTone;
  children: ReactNode;
  /** Render a small filled dot before the label (useful for live status). */
  dot?: boolean;
  className?: string;
}

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'border-line bg-surface-2 text-muted',
  good: 'border-good/30 bg-good/10 text-good',
  warn: 'border-peak/30 bg-peak/10 text-peak',
  alert: 'border-alert/30 bg-alert/10 text-alert',
  info: 'border-forecast/30 bg-forecast/10 text-forecast',
};

const DOT_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-muted',
  good: 'bg-good',
  warn: 'bg-peak',
  alert: 'bg-alert',
  info: 'bg-forecast',
};

/** Small status pill. Used for run state, action state and the mock-data flag. */
export function Badge({ tone = 'neutral', children, dot, className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
        'text-[11px] font-medium tracking-wide whitespace-nowrap uppercase',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {dot && <span className={clsx('h-1.5 w-1.5 rounded-full', DOT_CLASSES[tone])} />}
      {children}
    </span>
  );
}

export default Badge;
