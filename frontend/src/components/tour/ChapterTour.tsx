'use client';

/**
 * The chapter tour -- the left third of the hero row.
 *
 * Seven chapters in reading order: the five devices on the site, then the
 * problem the day has, then the answer the agent found. One is open at a time.
 * Opening a device chapter is exactly the same event as clicking that device in
 * the scene, because it IS that event: the tour writes to the same selection
 * store the scene reads, so the camera flies, the ground ring lights and the
 * copy changes from one act.
 *
 * The sync is two-way and deliberately idempotent at both ends:
 *
 *   tour -> scene   `open()` writes the selection, guarded so re-selecting the
 *                   node that is already held is a no-op (the store's own
 *                   `select` toggles, which a tour must never do by accident)
 *   scene -> tour   one effect watches `useSelected()` and reconciles which
 *                   chapter is open. Because both directions settle on the same
 *                   pair of values, the round trip converges on the first pass.
 *
 * The building has no chapter of its own, so picking it in the scene clears the
 * selection rather than leaving the camera in a close-up nothing explains.
 *
 * Two chapters do something to the page when they open, which is allowed
 * because opening is a click: "The peak" parks the scrubber on the worst hour,
 * and "The plan" switches the page to the optimized flows once a plan exists.
 *
 * While the agent runs, the pill whose device the current tool is about gets a
 * soft ring in that device's channel colour. It does not open anything: a run
 * is the agent's turn, not a hijack of the viewer's.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useGridShift } from '@/lib/store';
import { TOOL_NODES, type SceneNode } from '@/components/scene/layout';
import {
  useHovered,
  useSelected,
  useSelectionStore,
} from '@/components/scene/interaction/selection';
import { ChapterPill } from './ChapterPill';
import {
  CHAPTERS,
  chapterTitle,
  isDeviceChapter,
  type ChapterCtx,
  type ChapterId,
  type PeakFacts,
} from './copy';
import { useChapterKeys } from './useChapterKeys';

/**
 * The agent's ring. Kept local rather than in globals.css for the same reason
 * the agent log keeps its row animation there: the rule belongs to the one
 * component that can explain it. Opacity only, so it is a compositor job.
 */
const PULSE_CSS = `
@keyframes gsChapterPulse {
  0%, 100% { opacity: 0.14; }
  50% { opacity: 0.42; }
}
.gs-chapter-pulse { animation: gsChapterPulse 1800ms var(--ease) infinite; }
@media (prefers-reduced-motion: reduce) {
  .gs-chapter-pulse { animation: none; opacity: 0.3; }
}
`;

export function ChapterTour() {
  const {
    building,
    forecast,
    plan,
    viewHour,
    setViewHour,
    viewMode,
    setViewMode,
    flowsAt,
    runStatus,
    activeTool,
    events,
  } = useGridShift();

  const store = useSelectionStore();
  const selected = useSelected();
  const hovered = useHovered();

  const [expanded, setExpanded] = useState<ChapterId | null>(null);

  /* ----------------------------------------------------------------- facts */

  const peak = useMemo<PeakFacts | null>(() => {
    if (!forecast) return null;
    const points = forecast.points;
    let hour = -1;
    let kw = -Infinity;
    let hours = 0;
    points.forEach((point, index) => {
      if (!point.is_peak) return;
      hours += 1;
      if (point.predicted_load_kw > kw) {
        kw = point.predicted_load_kw;
        hour = index;
      }
    });
    if (hour < 0) return null;
    return { kw, hour, hours, threshold: forecast.peak_threshold_kw };
  }, [forecast]);

  const latestMessage = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].message) return events[i].message;
    }
    return null;
  }, [events]);

  const ctx = useMemo<ChapterCtx | null>(() => {
    if (!building) return null;
    return {
      building,
      flows: flowsAt(viewHour),
      hour: viewHour,
      price: forecast?.points[viewHour]?.price_per_kwh ?? null,
      plan,
      peak,
      runStatus,
      stepCount: events.length,
      latestMessage,
    };
  }, [
    building,
    flowsAt,
    viewHour,
    forecast,
    plan,
    peak,
    runStatus,
    events.length,
    latestMessage,
  ]);

  /* ------------------------------------------------------------- tour sync */

  /**
   * Open a chapter (or close everything) and tell the scene about it.
   *
   * `store.select` toggles when handed the node it already holds, so every
   * write is guarded: a tour must be able to say "this one" without meaning
   * "not this one".
   */
  const open = useCallback(
    (id: ChapterId | null) => {
      setExpanded(id);

      const node: SceneNode | null = id !== null && isDeviceChapter(id) ? id : null;
      if (store.getSelected() !== node) store.select(node);

      if (id === 'peak' && peak) setViewHour(peak.hour);
      if (id === 'plan' && plan) setViewMode('optimized');
    },
    [store, peak, plan, setViewHour, setViewMode],
  );

  const toggle = useCallback(
    (id: ChapterId) => open(expanded === id ? null : id),
    [expanded, open],
  );

  const close = useCallback(() => open(null), [open]);

  /* Scene -> tour. A subscription rather than an effect on `selected`: the
     selection store is an external system, and reacting to it in its own
     callback is what keeps this out of the render cascade. Everything written
     here is already what `open` writes, so a tour-driven pick lands in this
     callback and changes nothing. */
  useEffect(
    () =>
      store.subscribe(() => {
        const node = store.getSelected();
        if (node === null) {
          setExpanded((current) =>
            current !== null && isDeviceChapter(current) ? null : current,
          );
          return;
        }
        if (node === 'building') {
          /* No chapter explains the building as a whole, and a close-up with
             the column shut would be a camera nobody asked for. */
          store.select(null);
          return;
        }
        setExpanded(node);
      }),
    [store],
  );

  /* Escape anywhere on the page closes the chapter and releases the camera --
     bound only while something is open, so nothing else loses the key. */
  useEffect(() => {
    if (expanded === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, close]);

  /* --------------------------------------------------------------- keyboard */

  const openAt = useCallback((index: number) => open(CHAPTERS[index]), [open]);

  const { register, onKeyDown } = useChapterKeys({
    count: CHAPTERS.length,
    onOpen: openAt,
    onClose: close,
  });

  const step = useCallback(
    (delta: number) => {
      if (expanded === null) return;
      const index = CHAPTERS.indexOf(expanded) + delta;
      if (index < 0 || index >= CHAPTERS.length) return;
      open(CHAPTERS[index]);
    },
    [expanded, open],
  );

  /** Hovering a pill lights the same ring hovering the device does. */
  const onHover = useCallback(
    (id: ChapterId | null) => {
      store.hover(id !== null && isDeviceChapter(id) ? id : null);
    },
    [store],
  );

  /* ------------------------------------------------------------------ agent */

  const activeNodes = useMemo<ReadonlySet<SceneNode>>(() => {
    if (runStatus !== 'running' || !activeTool) return new Set<SceneNode>();
    return new Set(TOOL_NODES[activeTool] ?? []);
  }, [runStatus, activeTool]);

  /* ----------------------------------------------------------------- render */

  if (!building || !ctx) {
    return (
      <div
        role="status"
        aria-label="Site tour loading"
        className="flex min-w-0 flex-col justify-center gap-2 lg:min-h-[520px]"
      >
        {CHAPTERS.map((id) => (
          <div key={id} className="h-[46px] animate-pulse rounded-full bg-surface-2 lg:ml-13" />
        ))}
      </div>
    );
  }

  return (
    <section
      aria-label="Site tour"
      className="flex min-w-0 flex-col justify-center lg:min-h-[520px]"
    >
      <style>{PULSE_CSS}</style>

      {/* A group rather than a tablist: the panels live inside the items, which
          is an accordion, not tabs. ARIA does not carry `aria-orientation` on a
          group -- the column's direction is already unambiguous -- so the arrow
          keys are announced by the headers' own `aria-expanded` instead. */}
      <ul
        role="group"
        aria-label="Site tour chapters"
        onKeyDown={onKeyDown}
        className="flex flex-col gap-2"
      >
        {CHAPTERS.map((id, index) => (
          <ChapterPill
            key={id}
            id={id}
            title={chapterTitle(id, building)}
            index={index}
            count={CHAPTERS.length}
            expanded={expanded === id}
            marked={isDeviceChapter(id) && (hovered === id || selected === id)}
            pulsing={isDeviceChapter(id) && activeNodes.has(id)}
            ctx={ctx}
            onToggle={toggle}
            onStep={step}
            onHover={onHover}
            registerHeader={register(index)}
          />
        ))}
      </ul>

      {/* The one thing the column says about itself, and only once a plan has
          given the two modes something to disagree about. */}
      {plan && (
        <p className="mt-3 text-[11px] text-muted lg:ml-13">
          Showing the {viewMode} day.
        </p>
      )}
    </section>
  );
}

export default ChapterTour;
