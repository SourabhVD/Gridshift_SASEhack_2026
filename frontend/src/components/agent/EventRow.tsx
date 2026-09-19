'use client';

/**
 * One step in the agent timeline: a node on the vertical rail, the tool name or
 * step label, the agent's own sentence, and the collapsed payload.
 */

import clsx from 'clsx';
import { Badge } from '@/components/ui/Badge';
import { formatDuration } from '@/lib/format';
import type { AgentEvent } from '@/types/api';
import { EVENT_STYLES } from '@/components/agent/eventStyles';
import { PayloadDetails } from '@/components/agent/PayloadDetails';

/** "2025-09-18T15:00:09-07:00" -> "15:00:09". Local zone, like the rest of the UI. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface EventRowProps {
  event: AgentEvent;
  /** False on the final node, so the rail does not dangle past the last step. */
  continuesBelow: boolean;
  expanded: boolean;
  onToggle: () => void;
}

export function EventRow({ event, continuesBelow, expanded, onToggle }: EventRowProps) {
  const style = EVENT_STYLES[event.type];
  const { Icon } = style;
  const duration = formatDuration(event.duration_ms);

  return (
    <li
      className={clsx(
        'gs-agent-row relative flex gap-3 rounded-md px-2 py-2.5',
        style.row,
      )}
    >
      {/* Rail + node */}
      <div className="relative flex w-5 shrink-0 justify-center">
        <span
          aria-hidden
          className={clsx(
            'absolute left-1/2 border-l border-line',
            continuesBelow ? 'inset-y-0' : 'top-0 h-4',
          )}
        />
        <span
          aria-hidden
          className={clsx(
            'relative mt-1.5 h-2 w-2 rounded-full ring-4 ring-surface',
            style.node,
          )}
        />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <span className={clsx('flex min-w-0 items-center gap-1.5', style.accent)}>
            <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
            {event.tool_name ? (
              <span className="truncate font-mono text-xs">
                {style.reply ? `↳ ${event.tool_name}` : event.tool_name}
              </span>
            ) : (
              <span className="truncate text-[11px] font-medium tracking-wide uppercase">
                {style.label}
              </span>
            )}
          </span>

          <span className="flex shrink-0 items-center gap-2 pt-px">
            <time
              dateTime={event.timestamp}
              className="text-[11px] tabular-nums text-muted"
            >
              {formatClock(event.timestamp)}
            </time>
            {duration && <Badge tone="neutral">{duration}</Badge>}
          </span>
        </div>

        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{event.message}</p>

        {event.payload && (
          <PayloadDetails
            payload={event.payload}
            open={expanded}
            onToggle={onToggle}
            subject={event.tool_name ?? `step ${event.seq}`}
          />
        )}
      </div>
    </li>
  );
}

export default EventRow;
