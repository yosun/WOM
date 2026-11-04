// Number, time and date formats shared by the dashboard.
import { isNum } from '../core/analyze.ts';

export { isNum };
export const DASH = '–';

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export const fx = (v: number | null | undefined, d = 2) => (isNum(v) ? v.toFixed(d) : DASH);

/** A difference with its sign. Anything that rounds to zero reads ±0.00 so a tie never looks like a gain or a loss. */
export function fSigned(v: number | null | undefined, d = 2) {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v).toFixed(d);
  if (Number(a) === 0) return `±${a}`;
  return `${v < 0 ? '−' : '+'}${a}`;
}

export const fPct = (v: number | null | undefined, d = 0) => (isNum(v) ? `${(v * 100).toFixed(d)}%` : DASH);

/** Seconds as a person reads them: 0.4 s, 23 s, 2 min 24 s. */
export function fSec(s: number | null | undefined) {
  if (!isNum(s)) return DASH;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 100) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m} min ${String(rest).padStart(2, '0')} s`;
}

/** Money; small amounts keep a third decimal so a price of 0.4 cents does not read as nothing. */
export function fUsd(v: number | null | undefined) {
  if (!isNum(v)) return DASH;
  return v > 0 && v < 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

export function fWhen(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fDay(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A label as it reads in the middle of a sentence: "World" becomes "world", "3D model" stays as it is. */
export const lower = (s: string) => s.replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase());

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
