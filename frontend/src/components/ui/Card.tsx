import clsx from 'clsx';
import type { ReactNode } from 'react';

export type CardVariant = 'panel' | 'flat';

export interface CardProps {
  /**
   * `panel` -- the soft borderless surface. Radius 12, `bg-surface`, no border.
   * Reserved for content that needs an edge to be read against: the two charts
   * and the dense agent log.
   *
   * `flat` -- transparent, no radius, a single hairline along the top. The
   * default container language for everything else on the page.
   *
   * Defaults to `panel` so existing call sites keep their shape.
   */
  variant?: CardVariant;
  /** Panel heading. Omit for a bare surface with no header row. */
  title?: ReactNode;
  /** Secondary line under the title. */
  subtitle?: ReactNode;
  /** Slotted into the top-right of the header: badges, buttons, legends. */
  right?: ReactNode;
  children?: ReactNode;
  /** Extra classes on the outer panel (e.g. column span, min-height). */
  className?: string;
  /** Extra classes on the body wrapper. Use "p-0" for edge-to-edge content. */
  bodyClassName?: string;
}

const SHELL: Record<CardVariant, string> = {
  panel: 'rounded-xl bg-surface',
  flat: 'border-t border-line-2 bg-transparent',
};

/** The header rule only exists inside a filled panel. */
const HEADER: Record<CardVariant, string> = {
  panel: 'border-b border-line px-5 py-4',
  flat: 'px-0 pt-4 pb-3',
};

const BODY: Record<CardVariant, string> = {
  panel: 'px-5 py-4',
  flat: 'px-0 py-0',
};

/**
 * The one panel primitive for the Energy Command Center.
 *
 * Under the flattened layout most sections are `flat`; the fill is the
 * exception rather than the rule, which is what keeps the pure-black page
 * reading as deliberate instead of unfinished.
 */
export function Card({
  variant = 'panel',
  title,
  subtitle,
  right,
  children,
  className,
  bodyClassName,
}: CardProps) {
  const hasHeader = Boolean(title || subtitle || right);

  return (
    <section className={clsx('flex min-w-0 flex-col', SHELL[variant], className)}>
      {hasHeader && (
        <header
          className={clsx('flex items-start justify-between gap-4', HEADER[variant])}
        >
          <div className="min-w-0">
            {title && (
              <h2 className="truncate text-[15px] font-semibold -tracking-[0.01em] text-ink">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p>
            )}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </header>
      )}
      <div className={clsx('flex-1', BODY[variant], bodyClassName)}>{children}</div>
    </section>
  );
}

export default Card;
