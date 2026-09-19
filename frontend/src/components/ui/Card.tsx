import clsx from 'clsx';
import type { ReactNode } from 'react';

export interface CardProps {
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

/**
 * The one panel primitive for the Energy Command Center. Every section of the
 * dashboard sits in one of these so borders, radii and padding stay identical.
 */
export function Card({
  title,
  subtitle,
  right,
  children,
  className,
  bodyClassName,
}: CardProps) {
  const hasHeader = Boolean(title || subtitle || right);

  return (
    <section
      className={clsx(
        'flex min-w-0 flex-col rounded-xl border border-line bg-surface',
        'shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset]',
        className,
      )}
    >
      {hasHeader && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {title && (
              <h2 className="truncate text-sm font-semibold tracking-wide text-ink">
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
      <div className={clsx('flex-1 px-5 py-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export default Card;
