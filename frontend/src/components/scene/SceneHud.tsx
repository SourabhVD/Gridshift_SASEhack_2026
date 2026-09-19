'use client';

/**
 * The 3D scene's readouts. Plain DOM over the canvas rather than in-world text:
 * it stays crisp at any dpr, costs no draw calls, and matches the 2D diagram's
 * corner readouts exactly.
 *
 * Nothing here is interactive, so the whole layer is pointer-events-none and the
 * canvas underneath keeps every gesture it would otherwise lose.
 */

import clsx from 'clsx';
import { formatHourIndex, formatKw } from '@/lib/format';
import type { SceneMode } from './contracts';

const LEGEND: readonly { label: string; color: string }[] = [
  { label: 'Grid', color: 'var(--color-forecast)' },
  { label: 'Solar', color: 'var(--color-peak)' },
  { label: 'Battery', color: 'var(--color-battery)' },
  { label: 'EV', color: 'var(--color-forecast)' },
  { label: 'HVAC', color: 'var(--color-muted)' },
];

export interface SceneHudProps {
  /** 0–23, the hour being viewed. */
  hour: number;
  mode: SceneMode;
  /** Net import from the utility this hour. */
  gridKw: number;
  overThreshold: boolean;
  /** Site name, in the bottom-right corner. */
  label?: string;
}

export function SceneHud({ hour, mode, gridKw, overThreshold, label }: SceneHudProps) {
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

      {/* bottom-right: which site this is */}
      {label && (
        <div className="absolute right-4 bottom-3 max-w-[45%] truncate text-[10px] tracking-wide text-muted/80">
          {label}
        </div>
      )}
    </div>
  );
}

export default SceneHud;
