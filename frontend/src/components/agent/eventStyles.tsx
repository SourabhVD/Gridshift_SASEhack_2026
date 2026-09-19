/**
 * Per-event-type presentation for the agent timeline.
 *
 * One table so the icon, the timeline node colour, the accent used on the tool
 * name and the row tint can never drift apart between rows.
 */

import {
  Brain,
  CheckCircle2,
  Flag,
  Sparkles,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { AgentEventType } from '@/types/api';

export interface EventStyle {
  /** Leading glyph for the row's first line. */
  Icon: LucideIcon;
  /** Tailwind text colour for the icon and the tool name. */
  accent: string;
  /** Tailwind background for the 8px timeline node. */
  node: string;
  /** Row tint. Only the reasoning beats get one, so they stand out. */
  row: string;
  /** Fallback label for events that carry no tool_name. */
  label: string;
  /** tool_result rows are indented replies to the call above them. */
  reply: boolean;
}

export const EVENT_STYLES: Record<AgentEventType, EventStyle> = {
  thinking: {
    Icon: Brain,
    accent: 'text-muted',
    node: 'bg-muted',
    row: '',
    label: 'reasoning',
    reply: false,
  },
  tool_call: {
    Icon: Wrench,
    accent: 'text-forecast',
    node: 'bg-forecast',
    row: '',
    label: 'tool call',
    reply: false,
  },
  tool_result: {
    Icon: CheckCircle2,
    accent: 'text-good',
    node: 'bg-good',
    row: '',
    label: 'tool result',
    reply: true,
  },
  decision: {
    Icon: Sparkles,
    accent: 'text-peak',
    node: 'bg-peak',
    row: 'bg-peak/5',
    label: 'decision',
    reply: false,
  },
  error: {
    Icon: XCircle,
    accent: 'text-alert',
    node: 'bg-alert',
    row: 'bg-alert/5',
    label: 'error',
    reply: false,
  },
  complete: {
    Icon: Flag,
    accent: 'text-good',
    node: 'bg-good',
    row: '',
    label: 'complete',
    reply: false,
  },
};

/** Events whose payload holds the headline numbers and opens by default. */
export const AUTO_EXPAND_TOOLS = new Set<string>(['run_schedule_optimizer']);
