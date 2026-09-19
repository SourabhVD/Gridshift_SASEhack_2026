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
 *
 * The legend follows the same rule for the same reason. With the card gone the
 * scene is the page, and a permanent row of dots in the corner is chrome nobody
 * asked for; it fades in while the pointer is over the scene -- which is
 * exactly when somebody is reading the colours -- and never on touch.
 *
 * What is NOT here: the hour/mode pill and the site name. EnergyFlowPanel owns
 * the first (it pairs it with a status line it has the data for) and the
 * header's building selector already says which site this is.
 */

import { useEffect, useState, type RefObject } from 'react';
import clsx from 'clsx';
import { formatKw } from '@/lib/format';
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
 * True while a fine pointer is inside the scene's box, optionally after a delay.
 *
 * It listens on the container rather than on the HUD layer, which is
 * pointer-events-none by design, and it checks `:hover` on mount because the
 * pointer is usually already inside by the time a consumer appears. A coarse
 * pointer never reports true: there is no hover to reward, so anything gated on
 * this simply stays away on touch.
 */
function usePointerOver(
  containerRef: RefObject<HTMLDivElement | null>,
  delayMs: number,
): boolean {
  const [over, setOver] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (window.matchMedia('(hover: none)').matches) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      clear();
      if (delayMs <= 0) setOver(true);
      else timer = setTimeout(() => setOver(true), delayMs);
    };
    const onLeave = () => {
      clear();
      setOver(false);
    };

    if (el.matches(':hover')) arm();
    el.addEventListener('pointerenter', arm);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      clear();
      el.removeEventListener('pointerenter', arm);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [containerRef, delayMs]);

  return over;
}

/**
 * The one piece of instruction the scene ever gives.
 *
 * Mounted only while nothing is selected, so its whole lifetime is the
 * condition -- no state to reset, and picking something takes it away.
 */
function InspectHint({
  containerRef,
  fill,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  fill?: boolean;
}) {
  const show = usePointerOver(containerRef, HINT_DELAY_MS);

  return (
    <div
      className={clsx(
        'absolute inset-x-0 flex justify-center transition-opacity duration-500',
        fill ? 'bottom-4' : 'bottom-3',
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
  /** Net import from the utility this hour. */
  gridKw: number;
  overThreshold: boolean;
  /** The scene's own box, for the hover that arms the hint and the legend. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Card-free panel: a bigger readout, no scrims, and a legend that hides. */
  fill?: boolean;
}

export function SceneHud({ gridKw, overThreshold, containerRef, fill }: SceneHudProps) {
  const selected = useSelected();
  const pointerOver = usePointerOver(containerRef, 0);

  return (
    <div className="pointer-events-none absolute inset-0 select-none" aria-hidden="true">
      {/* Scrims: the sky goes pale at noon and the readouts have to survive it.
          The card-free panel has neither, because a band of black over the page
          background is visible as a band -- which is the rectangle the whole
          edge treatment exists to remove. Nothing is ever drawn behind the
          corners there anyway, so the readouts sit on `bg-base` and the text
          shadow is enough. */}
      {!fill && (
        <>
          <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-black/45 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/35 to-transparent" />
        </>
      )}

      {/* top-right: the number that matters */}
      <div
        className={clsx('absolute text-right', fill ? 'top-4 right-4 sm:right-5' : 'top-3 right-4')}
      >
        <div className="text-[10px] tracking-[0.08em] text-muted uppercase">Net grid draw</div>
        <div
          className={clsx(
            'font-mono leading-tight',
            fill ? 'text-[22px] sm:text-[28px]' : 'text-2xl',
            overThreshold ? 'text-alert' : 'text-ink',
          )}
          style={{ textShadow: '0 1px 6px rgba(0,0,0,0.6)' }}
        >
          {formatKw(gridKw)}
        </div>
      </div>

      {/* bottom-left: what the colours mean, while somebody is looking */}
      <div
        className={clsx(
          'absolute flex flex-wrap items-center gap-x-3 gap-y-1 transition-opacity duration-200',
          fill ? 'bottom-4 left-4 sm:left-5' : 'bottom-3 left-3',
          fill && !pointerOver ? 'opacity-0' : 'opacity-100',
        )}
      >
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
      {selected === null && <InspectHint containerRef={containerRef} fill={fill} />}
    </div>
  );
}

export default SceneHud;
