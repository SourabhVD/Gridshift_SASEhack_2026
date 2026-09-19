'use client';

/**
 * The 3D scene's readouts. Plain DOM over the canvas rather than in-world text:
 * it stays crisp at any dpr, costs no draw calls, and matches the 2D diagram's
 * corner readouts exactly.
 *
 * Nothing here is interactive, so the whole layer is pointer-events-none and the
 * canvas underneath keeps every gesture it would otherwise lose.
 *
 * One addition for the interactive scene: a discreet bottom-centre hint that
 * fades in after a second and a half of hovering an unselected scene, telling
 * you the props can be clicked. It never appears on a touch device (there is no
 * hover to reward) and it disappears for good once something has been picked.
 * While a card is open the site name in the bottom-right is suppressed, because
 * the card sits on top of it.
 */

import { useEffect, useState, type RefObject } from 'react';
import clsx from 'clsx';
import { formatHourIndex, formatKw } from '@/lib/format';
import type { SceneMode } from './contracts';
import { useSelected } from './interaction/selection';

const LEGEND: readonly { label: string; color: string }[] = [
  { label: 'Grid', color: 'var(--color-forecast)' },
  { label: 'Solar', color: 'var(--color-peak)' },
  { label: 'Battery', color: 'var(--color-battery)' },
  { label: 'EV', color: 'var(--color-forecast)' },
  { label: 'HVAC', color: 'var(--color-muted)' },
];

/** How long the pointer has to rest on the scene before the hint is offered. */
const HINT_DELAY_MS = 1500;

/**
 * The one piece of instruction the scene ever gives.
 *
 * Mounted only while nothing is selected, so its whole lifetime is the
 * condition -- no state to reset, and picking something takes it away. It
 * listens on the container rather than on this layer, which is
 * pointer-events-none by design, and it checks `:hover` on mount because the
 * pointer is usually already inside by the time it appears.
 */
function InspectHint({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    /* A coarse pointer has no hover to reward; the hint would simply sit there. */
    if (window.matchMedia('(hover: none)').matches) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      clear();
      timer = setTimeout(() => setShow(true), HINT_DELAY_MS);
    };
    const onLeave = () => {
      clear();
      setShow(false);
    };

    if (el.matches(':hover')) arm();
    el.addEventListener('pointerenter', arm);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      clear();
      el.removeEventListener('pointerenter', arm);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [containerRef]);

  return (
    <div
      className={clsx(
        'absolute inset-x-0 bottom-3 flex justify-center transition-opacity duration-500',
        show ? 'opacity-100' : 'opacity-0',
      )}
    >
      <span className="rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[10px] tracking-wide text-white/70 backdrop-blur-sm">
        Click a device to inspect
      </span>
    </div>
  );
}

export interface SceneHudProps {
  /** 0–23, the hour being viewed. */
  hour: number;
  mode: SceneMode;
  /** Net import from the utility this hour. */
  gridKw: number;
  overThreshold: boolean;
  /** Site name, in the bottom-right corner. */
  label?: string;
  /** The scene's own box, for the hover that arms the hint. */
  containerRef: RefObject<HTMLDivElement | null>;
}

export function SceneHud({
  hour,
  mode,
  gridKw,
  overThreshold,
  label,
  containerRef,
}: SceneHudProps) {
  const selected = useSelected();

  return (
    <div className="pointer-events-none absolute inset-0 select-none" aria-hidden="true">
      {/* Scrims: the sky goes pale at noon and the readouts have to survive it. */}
      <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-black/45 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/35 to-transparent" />

      {/* top-left: what you are looking at */}
      <div className="absolute top-3 left-3">
        <span
          className={clsx(
            'inline-flex items-center rounded-full border border-line bg-surface-2/80 px-3 py-1',
            'text-[11px] tracking-wide text-muted backdrop-blur-sm',
          )}
        >
          {formatHourIndex(hour)} · {mode}
        </span>
      </div>

      {/* top-right: the number that matters */}
      <div className="absolute top-3 right-4 text-right">
        <div className="text-[10px] tracking-[0.08em] text-muted uppercase">Net grid draw</div>
        <div
          className={clsx(
            'font-mono text-2xl leading-tight',
            overThreshold ? 'text-alert' : 'text-ink',
          )}
          style={{ textShadow: '0 1px 6px rgba(0,0,0,0.6)' }}
        >
          {formatKw(gridKw)}
        </div>
      </div>

      {/* bottom-left: what the colours mean */}
      <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        {LEGEND.map(({ label, color }) => (
          <span key={label} className="inline-flex items-center gap-1.5 text-[10px] text-muted">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: label === 'Grid' && overThreshold ? 'var(--color-alert)' : color }}
            />
            {label}
          </span>
        ))}
      </div>

      {/* bottom-centre: click affordance, only while nothing is selected */}
      {selected === null && <InspectHint containerRef={containerRef} />}

      {/* bottom-right: which site this is. The detail card sits over it. */}
      {label && selected === null && (
        <div className="absolute right-4 bottom-3 max-w-[45%] truncate text-[10px] tracking-wide text-muted/80">
          {label}
        </div>
      )}
    </div>
  );
}

export default SceneHud;
