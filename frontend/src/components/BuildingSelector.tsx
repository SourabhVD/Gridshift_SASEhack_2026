'use client';

/**
 * BuildingSelector -- the header control that switches the whole dashboard
 * between the three sites.
 *
 * Everything below the header is keyed on `buildingId` in page.tsx, so all this
 * has to do is call `selectBuilding()`; the store aborts the poll loop, clears
 * the run and reloads summary + forecast on its own.
 *
 * Interaction is a plain listbox: the trigger owns `aria-haspopup="listbox"`,
 * each row is a `role="option"`, focus moves with ArrowUp/ArrowDown and Enter
 * commits. The menu closes on outside click and on Escape.
 */

import clsx from 'clsx';
import {
  Building2,
  Check,
  ChevronDown,
  Hospital,
  House,
  LoaderCircle,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { formatKw } from '@/lib/format';
import { useGridShift } from '@/lib/store';
import type { BuildingType } from '@/types/api';

const TYPE_ICON: Record<BuildingType, LucideIcon> = {
  office: Building2,
  hospital: Hospital,
  warehouse: Warehouse,
  residence: House,
};

const TRIGGER = [
  'inline-flex max-w-[18rem] items-center gap-2 rounded-md -mx-1 px-1 py-1',
  'text-[15px] font-medium text-ink',
  'transition-colors duration-[var(--dur)] ease-[var(--ease)] hover:text-ink',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
].join(' ');

/** 150_000 -> "150k sqft", 9_800 -> "9.8k sqft". */
function formatArea(sqft: number): string {
  const k = sqft / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k sqft`;
}

function TypeIcon({ type, className }: { type: BuildingType; className?: string }) {
  const Icon = TYPE_ICON[type];
  return <Icon className={className} aria-hidden="true" />;
}

export function BuildingSelector() {
  const { buildings, building, buildingId, selectBuilding, isLoading } = useGridShift();

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  /* Outside click + Escape. Bound only while the menu is open. */
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  /* Opening parks focus on the row that is already selected. */
  useEffect(() => {
    if (!open) return;
    const index = Math.max(
      0,
      buildings.findIndex((b) => b.id === buildingId),
    );
    optionRefs.current[index]?.focus();
  }, [open, buildings, buildingId]);

  const choose = useCallback(
    (id: string) => {
      setOpen(false);
      triggerRef.current?.focus();
      void selectBuilding(id);
    },
    [selectBuilding],
  );

  const onOptionKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      const count = buildings.length;
      if (count === 0) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        optionRefs.current[(index + 1) % count]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        optionRefs.current[(index - 1 + count) % count]?.focus();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        choose(buildings[index].id);
      } else if (event.key === 'Home') {
        event.preventDefault();
        optionRefs.current[0]?.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        optionRefs.current[count - 1]?.focus();
      }
    },
    [buildings, choose],
  );

  const name = building?.name ?? 'Loading building...';

  /* One site (or none loaded yet): there is nothing to choose between. */
  if (buildings.length <= 1) {
    return (
      <span className="flex min-w-0 items-center gap-2 text-[15px] font-medium text-ink">
        {building && <TypeIcon type={building.type} className="h-4 w-4 shrink-0" />}
        <span className="truncate">{name}</span>
        {isLoading && (
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-muted" aria-hidden="true" />
        )}
      </span>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select building"
        className={TRIGGER}
      >
        <span className="truncate">{name}</span>
        {isLoading && (
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" aria-hidden="true" />
        )}
        <ChevronDown
          className={clsx(
            'h-4 w-4 shrink-0 text-muted transition-transform duration-[var(--dur)] ease-[var(--ease)]',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Buildings"
          className="absolute top-full left-0 z-20 mt-2 w-80 rounded-xl bg-surface p-1 shadow-2xl shadow-black/70 ring-1 ring-line-2"
        >
          {buildings.map((b, index) => {
            const selected = b.id === buildingId;
            return (
              <button
                key={b.id}
                ref={(el) => {
                  optionRefs.current[index] = el;
                }}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => choose(b.id)}
                onKeyDown={(event) => onOptionKeyDown(event, index)}
                className={clsx(
                  'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left',
                  'transition-colors duration-[var(--dur)] ease-[var(--ease)]',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                  selected ? 'bg-surface-2' : 'hover:bg-surface-2',
                )}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 ring-1 ring-line">
                  <TypeIcon type={b.type} className="h-4 w-4 text-muted" />
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{b.name}</span>
                  <span className="block truncate text-[11px] text-muted">
                    {`${b.type} · ${b.floors} ${b.floors === 1 ? 'floor' : 'floors'} · ${formatArea(
                      b.area_sqft,
                    )} · ${formatKw(b.peak_threshold_kw)}`}
                  </span>
                </span>

                {selected && <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default BuildingSelector;
