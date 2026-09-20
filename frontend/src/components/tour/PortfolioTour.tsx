'use client';

/**
 * The campus chapter column -- the portfolio-level half of the tour.
 *
 * Same column, same shape, one level up: where the site tour lists the five
 * devices on a lot, this lists the four lots. Each chapter is one sentence of
 * fact about that site at the hour on the scrubber, and opening one is not a
 * disclosure -- it is a journey. `enterSite` selects the building AND flies the
 * camera down to it, so clicking a chapter here and clicking that building in
 * the world are the same event, exactly as opening a device chapter and
 * clicking that device are at site level.
 *
 * Because opening navigates, the arrow keys deliberately do NOT open. They rove
 * focus down the column the way they do at site level; Enter and Space go, and
 * the browser turns both into a click on a real `<button>` for free. A tour
 * that flew the camera on every ArrowDown would be a tour nobody could read.
 *
 * Hovering a chapter lights that lot in the scene, through the same selection
 * store the device chapters write to.
 */

import { useCallback, useMemo, useRef, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { formatHourIndex, formatKw } from '@/lib/format';
import { useGridShift } from '@/lib/store';
import type { PortfolioSite } from '@/lib/store';
import {
  useHoveredSite,
  useSelectionStore,
} from '@/components/scene/interaction/selection';
import { kwText } from './copy';

/**
 * The one line under a site's name.
 *
 * Three cases, because a meter can run backwards. Over the cap it says by how
 * much, since that is the only number anybody acts on. Under it, the share --
 * a site at 40 % of its cap and one at 95 % are different stories and "under
 * cap" tells neither. And a site whose array is beating its own load is
 * exporting, which is neither of those and must never read as "-29 percent".
 */
function line(site: PortfolioSite, hour: number): string {
  const at = formatHourIndex(hour);
  if (site.over) {
    return `${kwText(site.grid_kw)} kW at ${at}, ${kwText(site.grid_kw - site.threshold)} kW over its ${formatKw(site.threshold)} cap.`;
  }
  if (site.grid_kw < 0) {
    return `Exporting ${kwText(-site.grid_kw)} kW at ${at}. Drawing nothing.`;
  }
  const share = site.threshold > 0 ? Math.round((site.grid_kw / site.threshold) * 100) : 0;
  return `${kwText(site.grid_kw)} kW at ${at}, ${share} percent of its ${formatKw(site.threshold)} cap.`;
}

export function PortfolioTour() {
  const { buildings, viewHour, portfolioAt, enterSite } = useGridShift();
  const store = useSelectionStore();
  const hoveredSite = useHoveredSite();
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const reading = useMemo(() => portfolioAt(viewHour), [portfolioAt, viewHour]);
  const bySite = useMemo(() => {
    const map = new Map<string, PortfolioSite>();
    for (const site of reading.per_site) map.set(site.id, site);
    return map;
  }, [reading]);

  const focus = useCallback((index: number) => {
    items.current[index]?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const active = document.activeElement;
      const index = items.current.findIndex((el) => el !== null && el === active);
      if (index < 0) return;
      const last = buildings.length - 1;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          focus(Math.min(last, index + 1));
          break;
        case 'ArrowUp':
          event.preventDefault();
          focus(Math.max(0, index - 1));
          break;
        case 'Home':
          event.preventDefault();
          focus(0);
          break;
        case 'End':
          event.preventDefault();
          focus(last);
          break;
        default:
          break;
      }
    },
    [buildings.length, focus],
  );

  if (buildings.length === 0) {
    return (
      <div
        role="status"
        aria-label="Portfolio loading"
        className="flex min-w-0 flex-col justify-center gap-2 lg:min-h-[520px]"
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[74px] animate-pulse rounded-[24px] bg-surface-2 lg:ml-13" />
        ))}
      </div>
    );
  }

  return (
    <section
      aria-label="Portfolio tour"
      className="flex min-w-0 flex-col justify-center lg:min-h-[520px]"
    >
      <p className="mb-3 text-[11px] tracking-[0.09em] text-muted uppercase lg:ml-13">
        {`${buildings.length} sites · one substation`}
      </p>

      <ul
        role="group"
        aria-label="Portfolio sites"
        onKeyDown={onKeyDown}
        className="flex flex-col gap-2"
      >
        {buildings.map((b, index) => {
          const site = bySite.get(b.id);
          const over = site?.over ?? false;
          const hovered = hoveredSite === b.id;

          return (
            <li key={b.id} className="flex items-stretch gap-3">
              {/* Holds the same rail the site tour's chevrons live in, so the
                  two columns share one left edge across the swap. */}
              <div className="hidden w-10 shrink-0 lg:block" />

              <button
                ref={(el) => {
                  items.current[index] = el;
                }}
                type="button"
                onClick={() => void enterSite(b.id)}
                onMouseEnter={() => store.hoverSite(b.id)}
                onMouseLeave={() => store.hoverSite(null)}
                onFocus={() => store.hoverSite(b.id)}
                onBlur={() => store.hoverSite(null)}
                className={clsx(
                  'flex min-w-0 flex-1 items-start gap-3 rounded-[24px] bg-surface-2 px-6 py-4 text-left',
                  'transition-[filter] duration-[var(--dur)] ease-[var(--ease)]',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  hovered ? 'brightness-[1.35]' : 'hover:brightness-[1.35]',
                )}
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface ring-1 ring-line-2 ring-inset"
                >
                  {/* Channel-neutral on purpose: a site is not a channel. The
                      only state it takes is the grid's one alert. */}
                  <span
                    className="h-2 w-2 rounded-full transition-colors duration-[var(--dur)]"
                    style={{
                      backgroundColor: over ? 'var(--color-alert)' : 'var(--color-ink-2)',
                    }}
                  />
                </span>

                <span className="min-w-0">
                  <span className="block text-[15px] leading-snug font-semibold text-ink">
                    {b.name}.
                  </span>
                  <span
                    className={clsx(
                      'mt-1 block text-[13px] leading-relaxed tabular-nums',
                      over ? 'text-alert' : 'text-ink-2',
                    )}
                  >
                    {site ? line(site, viewHour) : 'No reading yet.'}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-[11px] text-muted lg:ml-13">
        Open a site to fly down to it.
      </p>
    </section>
  );
}

export default PortfolioTour;
