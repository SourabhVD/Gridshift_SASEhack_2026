'use client';

/**
 * One chapter of the tour: a pill that opens into a panel.
 *
 * Collapsed it is a title on a 24 px circle, the way Apple's feature tours list
 * their chapters. Open it is the same element with a bigger radius and a body
 * underneath -- never a second element, so the title never jumps and the pill
 * reads as the panel it became.
 *
 * The circle carries the only three marks in the whole column:
 *
 *   plus        the chapter is closed and nothing in the scene points at it
 *   channel dot the device is hovered or selected in the scene
 *   rotated +   an open story chapter, i.e. the close affordance
 *
 * Opening animates `grid-template-rows` from 0fr to 1fr with the body mounted a
 * frame earlier, and closing keeps the body mounted for one `--dur` so the
 * collapse has something to collapse. Under `prefers-reduced-motion` the shared
 * rule in globals.css kills every transition on the page, so both are cuts.
 *
 * Nothing here owns state that matters: which chapter is open, what the scene
 * is selecting and what the copy says are all decided by <ChapterTour>.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, LoaderCircle, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { MiniChart } from '@/components/scene/interaction/MiniChart';
import { formatHour, formatHourIndex } from '@/lib/format';
import { useGridShift } from '@/lib/store';
import type { Action } from '@/types/api';
import {
  ACTION_CHAPTER,
  CHANNEL,
  FLOW_KEY,
  chapterCopy,
  chapterTitle,
  chapterValue,
  isDeviceChapter,
  kwText,
  type ChapterCtx,
  type ChapterId,
  type DeviceChapter,
} from './copy';

/** Matches `--dur` in globals.css; the close animation is unmounted after it. */
const DUR_MS = 330;

export interface ChapterPillProps {
  id: ChapterId;
  title: string;
  /** Position in the column, for the chevrons and for the arrow keys. */
  index: number;
  count: number;
  expanded: boolean;
  /** Show the channel dot: the scene is hovering or holding this device. */
  marked: boolean;
  /** How much attention this chip is asking for. */
  emphasis: PillEmphasis;
  ctx: ChapterCtx;
  onToggle: (id: ChapterId) => void;
  /** -1 / +1 from the chevrons. */
  onStep: (delta: number) => void;
  onHover: (id: ChapterId | null) => void;
  registerHeader: (el: HTMLButtonElement | null) => void;
}

/**
 * How loudly a chip is speaking.
 *
 *   none     nothing to say.
 *   ambient  a run is going and this chip is not what the agent is on. Dim,
 *            steady, and the reason the column no longer looks frozen for the
 *            eighty seconds a live run takes between tool calls.
 *   active   the agent's current tool is about this chip. The channel colour,
 *            breathing.
 *   pending  the plan is waiting on a human and this chip is part of what it
 *            asks for. Accent, and deliberately not the channel colour: the
 *            whole column turning one colour reads as "a decision is waiting"
 *            in a way five different colours do not.
 */
export type PillEmphasis = 'none' | 'ambient' | 'active' | 'pending';

export function ChapterPill({
  id,
  title,
  index,
  count,
  expanded,
  marked,
  emphasis,
  ctx,
  onToggle,
  onStep,
  onHover,
  registerHeader,
}: ChapterPillProps) {
  const panelId = useId();
  const device = isDeviceChapter(id);

  /**
   * Two flags, one frame apart in each direction.
   *
   * `mounted` is whether the body exists at all -- only the open chapter pays
   * for its mini chart -- and it outlives the close by one duration so the
   * 0fr collapse has something to collapse. `open` is the 1fr/0fr switch, and
   * it is always flipped a frame after the body has been through layout;
   * without that the browser coalesces the two into an instant appearance.
   *
   * Every write below happens inside a frame or timer callback rather than in
   * the effect body, so opening a chapter costs no cascading render.
   */
  const [mounted, setMounted] = useState(expanded);
  const [open, setOpen] = useState(expanded);

  useEffect(() => {
    if (expanded) {
      /* A 0 ms task, then the next frame. The body has to exist and be laid
         out at 0fr before the switch to 1fr, or the browser coalesces the two
         and the panel appears instead of opening. The timer beside the frame
         is the safety net: a tab that is not painting never runs a rAF, and
         a chapter that is open must have content whether it animated or not. */
      const mount = window.setTimeout(() => setMounted(true), 0);
      const frame = requestAnimationFrame(() => setOpen(true));
      const reveal = window.setTimeout(() => setOpen(true), 64);
      return () => {
        window.clearTimeout(mount);
        cancelAnimationFrame(frame);
        window.clearTimeout(reveal);
      };
    }
    const collapse = window.setTimeout(() => setOpen(false), 0);
    const unmount = window.setTimeout(() => setMounted(false), DUR_MS + 40);
    return () => {
      window.clearTimeout(collapse);
      window.clearTimeout(unmount);
    };
  }, [expanded]);

  const ring = device ? CHANNEL[id] : 'var(--color-accent)';

  return (
    <li className="flex items-stretch gap-3">
      {/* The chevron rail. It holds its width on every row so the pills keep
          one left edge whether or not anything is open, and it is the one part
          of the column a phone does without. */}
      <div className="hidden w-10 shrink-0 flex-col justify-between lg:flex">
        {expanded && (
          <>
            <Chevron
              direction="up"
              disabled={index === 0}
              onClick={() => onStep(-1)}
            />
            <Chevron
              direction="down"
              disabled={index === count - 1}
              onClick={() => onStep(1)}
            />
          </>
        )}
      </div>

      <div
        className={clsx(
          'relative min-w-0 flex-1 bg-surface-2',
          'transition-[border-radius,filter] duration-[var(--dur)] ease-[var(--ease)]',
          expanded ? 'rounded-[24px]' : 'rounded-full hover:brightness-[1.35]',
        )}
        onMouseEnter={() => onHover(id)}
        onMouseLeave={() => onHover(null)}
      >
        {emphasis !== 'none' && (
          <span
            aria-hidden="true"
            data-emphasis={emphasis}
            className={clsx(
              'pointer-events-none absolute inset-0',
              'transition-opacity duration-[var(--dur)] ease-[var(--ease)]',
              expanded ? 'rounded-[24px]' : 'rounded-full',
              emphasis === 'active' && 'gs-chapter-pulse',
              emphasis === 'ambient' && 'opacity-25',
            )}
            style={{
              boxShadow: `0 0 0 ${emphasis === 'ambient' ? 2 : 3}px ${
                emphasis === 'pending' ? 'var(--color-accent)' : ring
              }`,
            }}
          />
        )}
        {/* The ring above is decoration. This is the same fact for anyone who
            cannot see it, and only for the state that asks for something. */}
        {emphasis === 'pending' && <span className="sr-only">Awaiting your approval.</span>}

        <button
          ref={registerHeader}
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => onToggle(id)}
          onFocus={() => onHover(id)}
          onBlur={() => onHover(null)}
          className={clsx(
            'relative flex w-full items-center gap-3 text-left',
            'text-[15px] font-medium text-ink',
            'transition-[padding] duration-[var(--dur)] ease-[var(--ease)]',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            expanded ? 'rounded-[24px] px-6 pt-5 pb-3' : 'rounded-full px-5 py-3',
          )}
        >
          <span
            aria-hidden="true"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface ring-1 ring-line-2 ring-inset"
          >
            {device && marked ? (
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: CHANNEL[id] }}
              />
            ) : (
              <Plus
                className={clsx(
                  'h-3.5 w-3.5 text-ink-2',
                  'transition-transform duration-[var(--dur)] ease-[var(--ease)]',
                  expanded && 'rotate-45',
                )}
              />
            )}
          </span>
          <span className="truncate">{title}</span>
        </button>

        <div
          id={panelId}
          className={clsx(
            'grid transition-[grid-template-rows,opacity] duration-[var(--dur)] ease-[var(--ease)]',
            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="px-6 pb-5">
              {mounted ? <ChapterBody id={id} ctx={ctx} /> : null}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Chevrons                                                                    */
/* -------------------------------------------------------------------------- */

function Chevron({
  direction,
  disabled,
  onClick,
}: {
  direction: 'up' | 'down';
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = direction === 'up' ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={direction === 'up' ? 'Previous chapter' : 'Next chapter'}
      className={clsx(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2',
        'text-ink-2 transition-[filter,color] duration-[var(--dur)] ease-[var(--ease)]',
        'hover:brightness-[1.35] hover:text-ink',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:opacity-35',
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Body                                                                        */
/* -------------------------------------------------------------------------- */

function ChapterBody({ id, ctx }: { id: ChapterId; ctx: ChapterCtx }) {
  const copy = chapterCopy(id, ctx);

  return (
    <div>
      <p className="text-[15px] leading-snug font-semibold text-ink">{copy.lead}</p>
      {copy.body.map((line, i) => (
        <p
          key={i}
          className={clsx(
            'mt-1.5 text-[13px] leading-relaxed text-ink-2',
            /* An agent message is the one line that can run long. */
            id === 'plan' && i === 0 && 'line-clamp-3',
          )}
        >
          {line}
        </p>
      ))}

      {isDeviceChapter(id) ? <DeviceDetail id={id} ctx={ctx} /> : null}
      {id === 'peak' ? <PeakControl ctx={ctx} /> : null}
      {id === 'plan' ? <PlanControl ctx={ctx} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Device chapters                                                             */
/* -------------------------------------------------------------------------- */

function DeviceDetail({ id, ctx }: { id: DeviceChapter; ctx: ChapterCtx }) {
  const { forecast, plan, viewHour, viewMode, setViewHour } = useGridShift();
  const value = chapterValue(id, ctx);

  const series = useMemo(() => {
    if (!forecast) return null;
    const key = FLOW_KEY[id];
    return {
      baseline: forecast.points.map((point) => point.flows[key]),
      optimized: plan ? plan.impact.map((point) => point.optimized_flows[key]) : null,
    };
  }, [id, forecast, plan]);

  const threshold = ctx.building.peak_threshold_kw;
  const showsThreshold = id === 'grid';

  return (
    <div>
      {value && (
        <div className="mt-4">
          <div
            className={clsx(
              'font-mono text-[32px] leading-none tabular-nums',
              value.alert ? 'text-alert' : 'text-ink',
            )}
          >
            {kwText(value.kw)}
            <span className="ml-1 text-[18px] text-muted">kW</span>
          </div>
          <p className="mt-1.5 text-xs text-muted">{value.note}</p>
        </div>
      )}

      {series && (
        <div className="mt-4">
          <div className="mb-1 flex items-baseline justify-between text-[10px] text-muted">
            <span className="tracking-[0.08em] uppercase">24 hours</span>
            <span className="tabular-nums">{formatHourIndex(viewHour)}</span>
          </div>
          <MiniChart
            label={`${chapterTitle(id, ctx.building)}, 24 hours`}
            baseline={series.baseline}
            optimized={series.optimized}
            hour={viewHour}
            onPick={setViewHour}
            threshold={showsThreshold ? threshold : null}
            signed={id === 'battery'}
            color={CHANNEL[id]}
          />
          {series.optimized && (
            <div className="mt-1 flex items-center gap-3 text-[10px] text-muted">
              <span className="inline-flex items-center gap-1">
                <span
                  className="h-1.5 w-3 rounded-sm opacity-45"
                  style={{ backgroundColor: CHANNEL[id] }}
                />
                baseline
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  className="h-[1.5px] w-3 rounded-sm"
                  style={{ backgroundColor: CHANNEL[id] }}
                />
                {viewMode === 'optimized' ? 'optimized' : 'planned'}
              </span>
            </div>
          )}
        </div>
      )}

      <ActionBlock id={id} />
    </div>
  );
}

function StatusBadge({ status }: { status: Action['status'] }) {
  if (status === 'approved') return <Badge tone="good">Approved</Badge>;
  if (status === 'rejected') return <Badge tone="neutral">Rejected</Badge>;
  if (status === 'executed') return <Badge tone="info">Executed</Badge>;
  return <Badge tone="warn">Pending</Badge>;
}

/** "90 kW", "+3 degF" -- the sign is only meaningful on a setpoint. */
function magnitudeLabel(action: Action): string {
  const signed =
    action.type === 'hvac_setpoint' && action.magnitude > 0
      ? `+${action.magnitude}`
      : `${action.magnitude}`;
  return `${signed} ${action.unit}`;
}

/**
 * The plan's say on this device.
 *
 * Solar always gets its one line, plan or no plan: an array is the one thing on
 * the site nobody can dispatch, and saying so is the point of the chapter. The
 * grid chapter deliberately shows nothing -- every action in the plan aims at
 * the meter, so listing them here would only duplicate "The plan".
 */
function ActionBlock({ id }: { id: DeviceChapter }) {
  const { plan, approve, reject } = useGridShift();
  const [busy, setBusy] = useState<{ id: string; decision: 'approve' | 'reject' } | null>(
    null,
  );
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const decide = useCallback(
    async (actionId: string, decision: 'approve' | 'reject') => {
      setBusy({ id: actionId, decision });
      try {
        await (decision === 'approve' ? approve(actionId) : reject(actionId));
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [approve, reject],
  );

  if (id === 'solar') {
    return (
      <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
        Generation is forecast, not controllable.
      </p>
    );
  }

  if (!plan || id === 'grid') return null;

  const actions = plan.actions.filter((action) => ACTION_CHAPTER[action.type] === id);
  if (actions.length === 0) {
    return (
      <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
        No action touches this device.
      </p>
    );
  }

  return (
    <ul className="mt-4 border-t border-line pt-3">
      {actions.map((action) => (
        <li key={action.id} className="mt-3 first:mt-0">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 flex-1 text-[13px] font-medium text-ink">
              {action.title}
            </p>
            <StatusBadge status={action.status} />
          </div>
          <p className="mt-1 text-xs text-muted tabular-nums">
            {formatHour(action.start_time)}&ndash;{formatHour(action.end_time)} ·{' '}
            {magnitudeLabel(action)}
          </p>

          {action.status === 'pending' && (
            <div className="mt-2.5 flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                aria-label={`Approve: ${action.title}`}
                disabled={busy !== null}
                onClick={() => void decide(action.id, 'approve')}
                icon={
                  busy?.id === action.id && busy.decision === 'approve' ? (
                    <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : null
                }
              >
                Approve
              </Button>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Reject: ${action.title}`}
                disabled={busy !== null}
                onClick={() => void decide(action.id, 'reject')}
                icon={
                  busy?.id === action.id && busy.decision === 'reject' ? (
                    <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : null
                }
              >
                Reject
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* Story chapters                                                              */
/* -------------------------------------------------------------------------- */

function PeakControl({ ctx }: { ctx: ChapterCtx }) {
  const { setViewHour } = useGridShift();
  const peak = ctx.peak;
  if (!peak) return null;

  return (
    <div className="mt-4">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setViewHour(peak.hour)}
        disabled={ctx.hour === peak.hour}
      >
        Jump to peak
      </Button>
    </div>
  );
}

function PlanControl({ ctx }: { ctx: ChapterCtx }) {
  const { plan, runStatus, isLoading, startRun, approve } = useGridShift();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const running = runStatus === 'running';

  const approveAll = useCallback(
    async (ids: string[]) => {
      setBusy(true);
      try {
        for (const id of ids) await approve(id);
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [approve],
  );

  if (!plan) {
    return (
      <div className="mt-4">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void startRun()}
          disabled={running || isLoading}
          icon={
            running ? (
              <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : null
          }
        >
          Run GridShift
        </Button>
      </div>
    );
  }

  const pending = plan.actions.filter((action) => action.status === 'pending');

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      {pending.length > 0 ? (
        <Button
          variant="primary"
          size="sm"
          aria-label="Approve every pending action"
          disabled={busy}
          onClick={() => void approveAll(pending.map((action) => action.id))}
          icon={
            busy ? (
              <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : null
          }
        >
          Approve all
        </Button>
      ) : ctx.runStatus === 'approved' ? (
        <Badge tone="good">Approved</Badge>
      ) : ctx.runStatus === 'rejected' ? (
        <Badge tone="neutral">Rejected</Badge>
      ) : (
        <Badge tone="info">Decided</Badge>
      )}
    </div>
  );
}

export default ChapterPill;
