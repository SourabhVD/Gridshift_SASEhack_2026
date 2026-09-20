'use client';

/**
 * The collapsed "details" disclosure under an agent event.
 *
 * Tool payloads are small, flat-ish bags of scalars, so a two-column key/value
 * grid reads far better than pretty-printed JSON. Nested objects are flattened
 * one level ("deadlines.fleet"); anything deeper is summarised rather than
 * dumped, because the row has to stay scannable at a glance during the demo.
 */

import { Fragment } from 'react';
import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { formatHour } from '@/lib/format';

/** Matches the ISO 8601 timestamps the API uses, so they render as "15:00". */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** At most one decimal, and no trailing ".0" on whole numbers. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1).replace(/\.0$/, '');
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '--';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return ISO_RE.test(value) ? formatHour(value) : value;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.length > 6) return `${value.length} items`;
    return value.map((item) => formatValue(item)).join(', ');
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).length;
    return keys === 0 ? '{}' : `{${keys} keys}`;
  }
  return String(value);
}

/** Flatten exactly one level, so `{deadlines: {fleet}}` -> `deadlines.fleet`. */
export function flattenPayload(payload: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (isPlainObject(value)) {
      const entries = Object.entries(value);
      if (entries.length === 0) {
        rows.push([key, '{}']);
        continue;
      }
      for (const [innerKey, innerValue] of entries) {
        rows.push([`${key}.${innerKey}`, formatValue(innerValue)]);
      }
      continue;
    }
    rows.push([key, formatValue(value)]);
  }
  return rows;
}

export interface PayloadDetailsProps {
  payload: Record<string, unknown>;
  open: boolean;
  onToggle: () => void;
  /** Used only for the toggle's aria-label, e.g. the tool name. */
  subject: string;
}

export function PayloadDetails({ payload, open, onToggle, subject }: PayloadDetailsProps) {
  const rows = flattenPayload(payload);
  if (rows.length === 0) return null;

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} details for ${subject}`}
        className={clsx(
          'inline-flex items-center gap-1 rounded text-[11px] text-muted',
          'transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline-none',
        )}
      >
        <ChevronRight
          aria-hidden
          className={clsx('h-3 w-3 transition-transform duration-150', open && 'rotate-90')}
        />
        details
      </button>

      {open && (
        <dl
          className={clsx(
            'mt-1.5 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1',
            'rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-[11px]',
          )}
        >
          {rows.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="truncate text-muted">{key}</dt>
              <dd className="break-words text-ink tabular-nums">{value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

export default PayloadDetails;
