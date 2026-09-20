import clsx from 'clsx';
import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'good' | 'warn' | 'alert' | 'info' | 'accent';

export interface BadgeProps {
  /** Colour intent. Defaults to 'neutral'. */
  tone?: BadgeTone;
  children: ReactNode;
  /** Render a small filled dot before the label (useful for live status). */
  dot?: boolean;
  className?: string;
}

/**
 * Tones map onto the palette, not onto a generic semantic set:
 *   info  = the grid channel        warn = solar / peak hours
 *   alert = grid over threshold     good = grid under threshold / plan approved
 *   accent = something to act on. At most one accent object per region.
 *
 * Borders are gone; on pure black a 10% wash plus the channel's own text colour
 * carries further than a 1px rule does through a projector.
 */
const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  good: 'bg-good/10 text-good',
  warn: 'bg-peak/10 text-peak',
  alert: 'bg-alert/10 text-alert',
  info: 'bg-forecast/10 text-forecast',
  accent: 'bg-accent/12 text-accent',
};

const DOT_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-muted',
  good: 'bg-good',
  warn: 'bg-peak',
  alert: 'bg-alert',
  info: 'bg-forecast',
  accent: 'bg-accent',
};

/** Small status pill. Used for run state, action state and the mock-data flag. */
export function Badge({ tone = 'neutral', children, dot, className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5',
        'text-[11px] font-medium tracking-[0.06em] whitespace-nowrap uppercase',
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
