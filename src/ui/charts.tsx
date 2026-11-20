/**
 * Canvas charts. They draw straight from the telemetry ring buffers on the runtime's
 * telemetry tick - no React state, no re-renders, no charting dependency.
 */
import { useEffect, useRef } from 'react';
import { formatClock, formatValue } from '../core/format';
import type { HealthState } from '../core/types';
import type { SeriesView } from '../telemetry/TelemetryEngine';
import { useRuntime } from './context';

const C = {
  line: '#38d6ff',
  text: 'rgba(160,190,205,0.9)',
  faint: 'rgba(111,138,154,0.7)',
  grid: 'rgba(56,214,255,0.09)',
  band: 'rgba(56,214,255,0.10)',
  mean: 'rgba(56,214,255,0.45)',
  setpoint: 'rgba(220,235,245,0.55)',
  advisory: '#ffd152',
  warning: '#ff8a1f',
  critical: '#ff3b42',
};

const LEVEL_COLOR: Record<HealthState, string> = { nominal: C.line, advisory: C.advisory, warning: C.warning, critical: C.critical };
const MONO = '10px "JetBrains Mono", "Cascadia Mono", Consolas, Menlo, monospace';

function prepare(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

export function TrendChart({ signalId, height = 150, windowS = 180 }: { signalId: string; height?: number; windowS?: number }) {
  const runtime = useRuntime();
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const core = runtime.core;
    const series: SeriesView = { t: [], v: [] };
    const setpoint: SeriesView = { t: [], v: [] };
    let hoverX: number | null = null;

    const draw = () => {
      const def = core.telemetry.signal(signalId);
      const width = canvas.clientWidth;
      const ctx = prepare(canvas, width, height);
      if (!ctx || !def || width < 40) return;
      const pad = { l: 46, r: 30, t: 8, b: 16 };
      const plotW = width - pad.l - pad.r;
      const plotH = height - pad.t - pad.b;
      const now = core.now;
      const from = now - windowS * 1000;
      core.telemetry.read(signalId, from, series);
      ctx.font = MONO;
      if (series.v.length < 2) {
        ctx.fillStyle = C.faint;
        ctx.fillText('Waiting for data', pad.l, pad.t + 14);
        return;
      }
      let min = Infinity;
      let max = -Infinity;
      for (const v of series.v) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const baseline = core.anomalies.baseline(signalId);
      if (baseline?.ready && def.detect.baseline) {
        min = Math.min(min, baseline.mean - 3 * baseline.std);
        max = Math.max(max, baseline.mean + 3 * baseline.std);
      }
      if (def.setpointSignalId) {
        core.telemetry.read(def.setpointSignalId, from, setpoint);
        for (const v of setpoint.v) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      const limits: Array<{ value: number; label: string; color: string }> = [];
      const lim = def.limits;
      if (lim && def.type !== 'status') {
        if (lim.highAlarm !== undefined) limits.push({ value: lim.highAlarm, label: 'HH', color: C.critical });
        if (lim.highWarn !== undefined) limits.push({ value: lim.highWarn, label: 'H', color: C.warning });
        if (lim.lowWarn !== undefined) limits.push({ value: lim.lowWarn, label: 'L', color: C.warning });
        if (lim.lowAlarm !== undefined) limits.push({ value: lim.lowAlarm, label: 'LL', color: C.critical });
      }
      // Bring a limit into view once the data is getting close to it.
      const spanRaw = Math.max(max - min, (def.range[1] - def.range[0]) * 0.01);
      for (const l of limits) {
        if (l.value > max && l.value - max < spanRaw * 0.6) max = l.value;
        if (l.value < min && min - l.value < spanRaw * 0.6) min = l.value;
      }
      const span = Math.max(max - min, (def.range[1] - def.range[0]) * 0.01);
      min -= span * 0.08;
      max += span * 0.08;
      const x = (t: number) => pad.l + ((t - from) / (windowS * 1000)) * plotW;
      const y = (v: number) => pad.t + (1 - (v - min) / (max - min)) * plotH;

      // Grid and y labels.
      ctx.strokeStyle = C.grid;
      ctx.fillStyle = C.faint;
      ctx.lineWidth = 1;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let i = 0; i <= 3; i++) {
        const v = min + ((max - min) * i) / 3;
        const yy = Math.round(y(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(pad.l, yy);
        ctx.lineTo(pad.l + plotW, yy);
        ctx.stroke();
        ctx.fillText(formatValue(v), pad.l - 6, yy);
      }

      // Periods during which an anomaly was active on this signal.
      for (const a of core.anomalies.all()) {
        if (!a.signalIds.includes(signalId)) continue;
        const end = a.clearedAt ?? now;
        if (end < from) continue;
        const x0 = x(Math.max(a.startedAt, from));
        const x1 = x(end);
        ctx.fillStyle = LEVEL_COLOR[a.severity];
        ctx.globalAlpha = 0.09;
        ctx.fillRect(x0, pad.t, Math.max(1, x1 - x0), plotH);
        ctx.globalAlpha = 0.55;
        if (a.startedAt >= from) ctx.fillRect(Math.round(x0), pad.t, 1, plotH);
        ctx.globalAlpha = 1;
      }

      // Learned baseline: mean and +/- 3 sigma band.
      if (baseline?.ready && def.detect.baseline) {
        const y0 = y(baseline.mean + 3 * baseline.std);
        const y1 = y(baseline.mean - 3 * baseline.std);
        ctx.fillStyle = C.band;
        ctx.fillRect(pad.l, y0, plotW, y1 - y0);
        ctx.strokeStyle = C.mean;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.l, y(baseline.mean));
        ctx.lineTo(pad.l + plotW, y(baseline.mean));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Alarm limits.
      ctx.textAlign = 'left';
      for (const l of limits) {
        if (l.value < min || l.value > max) continue;
        const yy = Math.round(y(l.value)) + 0.5;
        ctx.strokeStyle = l.color;
        ctx.globalAlpha = 0.75;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.l, yy);
        ctx.lineTo(pad.l + plotW, yy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = l.color;
        ctx.fillText(l.label, pad.l + plotW + 5, yy);
        ctx.globalAlpha = 1;
      }

      const path = (s: SeriesView) => {
        ctx.beginPath();
        for (let i = 0; i < s.v.length; i++) {
          const px = x(s.t[i]);
          const py = y(s.v[i]);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
      };
      if (def.setpointSignalId && setpoint.v.length > 1) {
        ctx.strokeStyle = C.setpoint;
        ctx.setLineDash([1, 3]);
        path(setpoint);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      path(series);
      ctx.stroke();
      const lastX = x(series.t[series.t.length - 1]);
      const lastY = y(series.v[series.v.length - 1]);
      ctx.fillStyle = C.line;
      ctx.beginPath();
      ctx.arc(lastX, lastY, 2.4, 0, Math.PI * 2);
      ctx.fill();

      // Time axis.
      ctx.fillStyle = C.faint;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillText(`−${windowS}s`, pad.l, height - 3);
      ctx.textAlign = 'right';
      ctx.fillText(formatClock(now), pad.l + plotW, height - 3);
      if (baseline && now < baseline.holdoffUntil) {
        ctx.textAlign = 'center';
        ctx.fillStyle = C.advisory;
        ctx.fillText('baseline re-learning after commanded change', pad.l + plotW / 2, height - 3);
      }

      // Hover read-out.
      if (hoverX !== null && hoverX >= pad.l && hoverX <= pad.l + plotW) {
        const tHover = from + ((hoverX - pad.l) / plotW) * windowS * 1000;
        let best = 0;
        for (let i = 1; i < series.t.length; i++) if (Math.abs(series.t[i] - tHover) < Math.abs(series.t[best] - tHover)) best = i;
        const hx = x(series.t[best]);
        const hy = y(series.v[best]);
        ctx.strokeStyle = 'rgba(207,230,242,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(hx) + 0.5, pad.t);
        ctx.lineTo(Math.round(hx) + 0.5, pad.t + plotH);
        ctx.stroke();
        ctx.fillStyle = '#e6f6ff';
        ctx.beginPath();
        ctx.arc(hx, hy, 2.6, 0, Math.PI * 2);
        ctx.fill();
        const text = `${formatValue(series.v[best], def.unit)}  ${formatClock(series.t[best])}`;
        const tw = ctx.measureText(text).width + 10;
        const bx = Math.min(Math.max(hx - tw / 2, pad.l), pad.l + plotW - tw);
        ctx.fillStyle = 'rgba(3,8,13,0.92)';
        ctx.fillRect(bx, pad.t, tw, 15);
        ctx.strokeStyle = 'rgba(56,214,255,0.4)';
        ctx.strokeRect(bx + 0.5, pad.t + 0.5, tw - 1, 14);
        ctx.fillStyle = '#e6f6ff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + 5, pad.t + 8);
      }
    };

    const onMove = (e: PointerEvent) => {
      hoverX = e.clientX - canvas.getBoundingClientRect().left;
      draw();
    };
    const onLeave = () => {
      hoverX = null;
      draw();
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    const unsubscribe = runtime.onTelemetry(draw);
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      unsubscribe();
      observer.disconnect();
    };
  }, [runtime, signalId, height, windowS]);

  return <canvas ref={ref} className="trend" style={{ height }} role="img" aria-label={`Trend of ${signalId}`} />;
}

export function Sparkline({ signalId, level = 'nominal', windowS = 90 }: { signalId: string; level?: HealthState; windowS?: number }) {
  const runtime = useRuntime();
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const core = runtime.core;
    const series: SeriesView = { t: [], v: [] };
    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const ctx = prepare(canvas, width, height);
      if (!ctx) return;
      const now = core.now;
      const from = now - windowS * 1000;
      core.telemetry.read(signalId, from, series);
      if (series.v.length < 2) return;
      let min = Infinity;
      let max = -Infinity;
      for (const v of series.v) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const def = core.telemetry.signal(signalId);
      const floor = def ? (def.range[1] - def.range[0]) * 0.02 : 1;
      if (max - min < floor) {
        const mid = (max + min) / 2;
        min = mid - floor / 2;
        max = mid + floor / 2;
      }
      ctx.strokeStyle = LEVEL_COLOR[level];
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < series.v.length; i++) {
        const px = ((series.t[i] - from) / (windowS * 1000)) * width;
        const py = 2 + (1 - (series.v[i] - min) / (max - min)) * (height - 4);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    };
    const unsubscribe = runtime.onTelemetry(draw);
    draw();
    return unsubscribe;
  }, [runtime, signalId, level, windowS]);

  return <canvas ref={ref} className="spark" aria-hidden="true" />;
}
