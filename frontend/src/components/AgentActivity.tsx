'use client';

/**
 * The live agent log -- the panel judges actually watch during the demo.
 *
 * Reads events / runStatus / error from useGridShift(). The events array is
 * cumulative and grows about once a second while a run is in flight, so this
 * component only ever appends: rows are keyed by event id, each one animates in
 * once, and the scroll position is only forced when the viewer is already
 * parked at the bottom.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, Bot } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { formatDuration } from '@/lib/format';
import { useGridShift } from '@/lib/store';
import type { RunStatus } from '@/types/api';
import { AUTO_EXPAND_TOOLS } from '@/components/agent/eventStyles';
import { EventRow } from '@/components/agent/EventRow';

/** Treat the viewer as "following" the log within this many px of the bottom. */
const STICK_THRESHOLD_PX = 40;

const STATUS_BADGE: Record<RunStatus, { tone: BadgeTone; label: string; dot: boolean }> = {
  idle: { tone: 'neutral', label: 'Idle', dot: false },
  running: { tone: 'info', label: 'Live', dot: true },
  awaiting_approval: { tone: 'warn', label: 'Awaiting approval', dot: false },
  approved: { tone: 'good', label: 'Approved', dot: false },
  rejected: { tone: 'neutral', label: 'Rejected', dot: false },
  failed: { tone: 'alert', label: 'Failed', dot: false },
};

/* Kept local so the shared globals.css stays owned by the layout. */
const ROW_ANIMATION_CSS = `
@keyframes gsAgentRowIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.gs-agent-row { animation: gsAgentRowIn 160ms ease-out both; }
@media (prefers-reduced-motion: reduce) { .gs-agent-row { animation: none; } }
`;

export function AgentActivity() {
  const { events, runStatus, error } = useGridShift();

  const scrollRef = useRef<HTMLDivElement>(null);
  /** Ref, not state: the scroll handler must not re-render on every wheel tick. */
  const followRef = useRef(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  /** Explicit user toggles, keyed by event id. Absent = use the default. */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const isRunning = runStatus === 'running';

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    followRef.current = true;
    setHasNewBelow(false);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const following = distance <= STICK_THRESHOLD_PX;
    followRef.current = following;
    if (following) setHasNewBelow(false);
  }, []);

  // New step arrived: follow it, or offer the "new steps" pill instead. The
  // pill flag is set from a frame callback so the scroll above has settled and
  // we are not cascading a render straight out of the effect body.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A fresh run clears the log; start following again from the top.
    if (events.length === 0) followRef.current = true;
    if (followRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    }
    const frame = requestAnimationFrame(() => {
      setHasNewBelow(events.length > 0 && !followRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [events.length]);

  const toggleRow = useCallback((id: string, fallback: boolean) => {
    setToggled((prev) => ({ ...prev, [id]: !(prev[id] ?? fallback) }));
  }, []);

  const badge = STATUS_BADGE[runStatus];
  const showEmptyState = events.length === 0 && !isRunning;

  const first = events[0];
  const last = events[events.length - 1];
  const elapsedMs =
    first && last && first !== last
      ? new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()
      : null;
  const showElapsed =
    !isRunning && runStatus !== 'idle' && elapsedMs !== null && elapsedMs > 0;

  return (
    <Card
      title="GridShift agent"
      subtitle="Gemini orchestrating tools"
      right={
        <Badge
          tone={badge.tone}
          dot={badge.dot}
          className={badge.dot ? '[&>span]:animate-pulse' : undefined}
        >
          {badge.label}
        </Badge>
      }
      variant="panel"
      className="min-h-[360px]"
      bodyClassName="flex flex-col p-0!"
    >
      <style>{ROW_ANIMATION_CSS}</style>

      <div className="relative flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          role="log"
          aria-live="polite"
          aria-label="GridShift agent activity log"
          className="h-[320px] overflow-y-auto px-3 py-3 sm:h-[360px]"
        >
          {showEmptyState ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <Bot aria-hidden className="h-6 w-6 text-muted" />
              <p className="text-xs text-muted">Run GridShift to start the agent</p>
            </div>
          ) : (
            <ol className="flex flex-col">
              {events.map((event, index) => {
                const autoExpand =
                  event.type === 'tool_result' &&
                  event.tool_name !== null &&
                  AUTO_EXPAND_TOOLS.has(event.tool_name);
                return (
                  <EventRow
                    key={event.id}
                    event={event}
                    continuesBelow={isRunning || index < events.length - 1}
                    expanded={toggled[event.id] ?? autoExpand}
                    onToggle={() => toggleRow(event.id, autoExpand)}
                  />
                );
              })}

              {isRunning && (
                <li className="relative flex gap-3 px-2 py-2.5">
                  <div className="relative flex w-5 shrink-0 justify-center">
                    <span
                      aria-hidden
                      className="absolute top-0 left-1/2 h-3 border-l border-line"
                    />
                  </div>
                  <div className="flex items-center gap-2 pt-0.5">
                    <span aria-hidden className="flex items-center gap-1">
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          className="h-1 w-1 animate-bounce rounded-full bg-muted"
                          style={{ animationDelay: `${i * 120}ms` }}
                        />
                      ))}
                    </span>
                    <span className="text-xs text-muted">thinking&hellip;</span>
                  </div>
                </li>
              )}
            </ol>
          )}
        </div>

        {hasNewBelow && (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Scroll to the newest agent steps"
            className={clsx(
              'absolute bottom-3 left-1/2 z-10 -translate-x-1/2',
              'inline-flex items-center gap-1 rounded-full px-3 py-1',
              'bg-surface-2 text-[11px] text-ink-2 shadow-lg shadow-black/60',
              'shadow-[inset_0_0_0_1px_var(--color-line-2)]',
              'transition-colors duration-[var(--dur)] ease-[var(--ease)] hover:text-ink',
            )}
          >
            <ArrowDown aria-hidden className="h-3 w-3" />
            new steps
          </button>
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
        <span className="text-[11px] tabular-nums text-muted">
          {events.length} {events.length === 1 ? 'step' : 'steps'}
          {showElapsed && ` · ${formatDuration(elapsedMs)} total`}
        </span>
        {runStatus === 'failed' && (
          <span className="truncate text-xs text-alert">{error ?? 'Run failed'}</span>
        )}
      </footer>
    </Card>
  );
}

export default AgentActivity;
