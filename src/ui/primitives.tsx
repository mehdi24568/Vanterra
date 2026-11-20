import type { ReactNode } from 'react';
import type { HealthState, OperatingState } from '../core/types';
import { HEALTH_LABEL } from '../core/format';

export function Dot({ level, pulse = false }: { level: HealthState | 'info' | 'standby'; pulse?: boolean }) {
  return <span className={`dot dot--${level}${pulse ? ' dot--pulse' : ''}`} aria-hidden="true" />;
}

export function SeverityTag({ level }: { level: HealthState }) {
  return (
    <span className={`tag tag--${level}`}>
      <Dot level={level} />
      {HEALTH_LABEL[level]}
    </span>
  );
}

const STATE_LABEL: Record<OperatingState, string> = { running: 'Running', standby: 'Standby', tripped: 'Tripped' };

export function StateTag({ state }: { state: OperatingState }) {
  return <span className={`tag tag--state-${state}`}>{STATE_LABEL[state]}</span>;
}

export function Section({
  title,
  aside,
  children,
  className = '',
  id,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`section ${className}`} id={id}>
      <header className="section__head">
        <h3 className="section__title">{title}</h3>
        {aside ? <div className="section__aside">{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} className={`toggle${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)} title={hint}>
      <span className="toggle__track" aria-hidden="true">
        <span className="toggle__thumb" />
      </span>
      <span className="toggle__label">{label}</span>
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="slider">
      <span className="slider__row">
        <span className="slider__label">{label}</span>
        <span className="slider__value">{format(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

/** Clickable asset reference used everywhere an asset is mentioned. */
export function AssetLink({ id, name, onClick, level }: { id: string; name?: string; onClick: () => void; level?: HealthState }) {
  return (
    <button type="button" className={`asset-link${level && level !== 'nominal' ? ` asset-link--${level}` : ''}`} onClick={onClick} title={name ? `${id} ${name}` : id}>
      <span className="asset-link__id">{id}</span>
      {name ? <span className="asset-link__name">{name}</span> : null}
    </button>
  );
}
