import type { Severity, HealthState } from './types';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** HH:MM:SS (UTC) for a simulated epoch timestamp. */
export function formatClock(t: number): string {
  const d = new Date(t);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function formatDate(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Compact duration: 42s, 3m 05s, 1h 02m. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/** Signed offset relative to a reference: T+42s. */
export function formatOffset(ms: number): string {
  const s = Math.round(ms / 1000);
  return `T${s >= 0 ? '+' : '−'}${Math.abs(s)}s`;
}

/** Value formatting that adapts precision to magnitude. */
export function formatValue(v: number | undefined, unit = ''): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const digits = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  const text = v.toFixed(digits);
  return unit ? `${text} ${unit}` : text;
}

export function formatSigned(v: number, digits = 1): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  advisory: 'Advisory',
  warning: 'Warning',
  critical: 'Critical',
};

export const HEALTH_LABEL: Record<HealthState, string> = {
  nominal: 'Nominal',
  advisory: 'Advisory',
  warning: 'Warning',
  critical: 'Critical',
};

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
