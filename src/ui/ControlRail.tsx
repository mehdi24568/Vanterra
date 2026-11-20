import { useState } from 'react';
import { ASSET_CATEGORIES, CATEGORY_LABEL, RELATION_LABEL } from '../core/types';
import type { RelationType, ScenarioInfo } from '../core/types';
import type { LeftTab } from '../runtime/AtlasRuntime';
import { ADVISORY_ECHO_INTENSITY } from '../sonar/SonarEngine';
import { useRuntime, useUi } from './context';
import { Section, Slider, Toggle } from './primitives';

const SPEEDS = [1, 2, 4, 8];
const RELATION_TYPES: RelationType[] = ['process', 'mechanical', 'electrical', 'cooling', 'utility'];

function SonarControls() {
  const runtime = useRuntime();
  const scan = useUi((s) => s.scan);
  const selected = useUi((s) => s.selectedAssetId);
  const sweep = scan.lastSweep;
  return (
    <Section title="Sonar" aside={<span className={`status-chip status-chip--${scan.status}`}>{scan.status}</span>}>
      <div className="button-row">
        <button type="button" className="btn btn--primary" onClick={() => runtime.ping()} disabled={scan.paused} title="Emit one pulse from the emitter mast (Space)">
          Ping
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => runtime.pingFromSelection()}
          disabled={scan.paused || !selected}
          title={selected ? `Emit one pulse from ${selected}` : 'Select an asset first'}
        >
          Ping from selection
        </button>
      </div>
      <div className="button-row">
        <Toggle checked={scan.continuous} onChange={(v) => runtime.setSonar({ continuous: v })} label="Continuous" hint="Emit a pulse automatically at the set interval" />
        <button type="button" className={`btn btn--ghost${scan.paused ? ' is-active' : ''}`} onClick={() => runtime.setSonar({ paused: !scan.paused })}>
          {scan.paused ? 'Resume scan' : 'Pause scan'}
        </button>
      </div>
      <Slider label="Intensity" value={scan.intensity} min={0.3} max={1.5} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => runtime.setSonar({ intensity: v })} />
      <p className="hint">
        {scan.intensity < ADVISORY_ECHO_INTENSITY
          ? `Below ${ADVISORY_ECHO_INTENSITY.toFixed(1)}: advisory-level conditions return no echo.`
          : 'Higher intensity reveals for longer and hears advisory-level conditions.'}
      </p>
      <Slider label="Radius" value={scan.radius} min={20} max={140} step={5} format={(v) => `${v.toFixed(0)} m`} onChange={(v) => runtime.setSonar({ radius: v })} />
      <Slider label="Interval" value={scan.intervalS} min={2} max={15} step={0.5} format={(v) => `${v.toFixed(1)} s`} onChange={(v) => runtime.setSonar({ intervalS: v })} />
      <Toggle
        checked={scan.autoPing}
        onChange={(v) => runtime.setSonar({ autoPing: v })}
        label="Ping on detection"
        hint="Emit a local pulse from an asset the moment an anomaly is detected on it"
      />
      <dl className="kv kv--compact">
        <dt>Sweeps completed</dt>
        <dd>{scan.sweepCount}</dd>
        <dt>Last sweep</dt>
        <dd>
          {sweep
            ? `${sweep.contacts} contacts · ${sweep.abnormal.critical}c ${sweep.abnormal.warning}w ${sweep.abnormal.advisory}a${sweep.missed ? ` · ${sweep.missed} unheard` : ''}`
            : '—'}
        </dd>
      </dl>
      <p className="hint">Double-click the ground to ping from that point.</p>
    </Section>
  );
}

function SimulationControls() {
  const runtime = useRuntime();
  const seed = useUi((s) => s.seed);
  const operating = useUi((s) => s.operating);
  const [seedText, setSeedText] = useState(String(seed));
  const [rate, target, duty] = operating.split('|');
  const parsedSeed = Number.parseInt(seedText, 10);
  return (
    <Section title="Simulation state">
      <dl className="kv kv--compact">
        <dt>Plant rate</dt>
        <dd>
          {rate || '—'} %{target && target !== rate ? ` → ${target} %` : ''}
        </dd>
        <dt>Feed pump on duty</dt>
        <dd>{duty === 'B' ? 'P-102' : 'P-101'}</dd>
      </dl>
      <div className="seed-row">
        <label className="field">
          <span className="field__label">Seed</span>
          <input value={seedText} inputMode="numeric" onChange={(e) => setSeedText(e.target.value.replace(/[^0-9]/g, '').slice(0, 9))} aria-label="Simulation seed" />
        </label>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => runtime.reset(Number.isFinite(parsedSeed) && parsedSeed > 0 ? parsedSeed : seed)}
          title="Restart from the seed: clears history, baselines and incidents"
        >
          Reset
        </button>
      </div>
    </Section>
  );
}

function ScenarioButton({ scenario, active }: { scenario: ScenarioInfo; active: boolean }) {
  const runtime = useRuntime();
  const [open, setOpen] = useState(false);
  return (
    <div className={`scenario scenario--${scenario.kind}${active ? ' is-active' : ''}`}>
      <div className="scenario__row">
        <button type="button" className="scenario__trigger" onClick={() => runtime.trigger(scenario.id)} disabled={active} title={scenario.summary}>
          <span className="scenario__name">{scenario.name}</span>
          <span className="scenario__state">{active ? 'Running' : scenario.kind === 'normal' ? 'Run' : 'Inject'}</span>
        </button>
        <button type="button" className="scenario__more" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`What to expect: ${scenario.name}`}>
          {open ? '−' : '+'}
        </button>
      </div>
      {open ? (
        <div className="scenario__detail">
          <p>{scenario.summary}</p>
          <ol>
            {scenario.phases.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

function Scenarios() {
  const runtime = useRuntime();
  const active = useUi((s) => s.activeScenarios).split(',');
  const anomalies = runtime.scenarios.filter((s) => s.kind === 'anomaly');
  const normal = runtime.scenarios.filter((s) => s.kind === 'normal');
  const cyberOnly = runtime.scenarios.filter((s) => s.kind === 'cyber');
  const cyberPhysical = runtime.scenarios.filter((s) => s.kind === 'cyber_physical');
  return (
    <Section title="Scenarios">
      <p className="hint">Scenarios change the simulated plant or produce simulated OT security records. Detection and reasoning see only the resulting measurements and records.</p>
      <h4 className="subhead">Physical faults</h4>
      {anomalies.map((s) => (
        <ScenarioButton key={s.id} scenario={s} active={active.includes(s.id)} />
      ))}
      <h4 className="subhead subhead--cyber">Cyber</h4>
      {cyberOnly.map((s) => (
        <ScenarioButton key={s.id} scenario={s} active={active.includes(s.id)} />
      ))}
      <h4 className="subhead subhead--cyber">Cyber-physical</h4>
      {cyberPhysical.map((s) => (
        <ScenarioButton key={s.id} scenario={s} active={active.includes(s.id)} />
      ))}
      <h4 className="subhead">Normal operations</h4>
      {normal.map((s) => (
        <ScenarioButton key={s.id} scenario={s} active={false} />
      ))}
    </Section>
  );
}

function Layers() {
  const runtime = useRuntime();
  const layers = useUi((s) => s.layers);
  const allOn = ASSET_CATEGORIES.every((c) => layers.categories[c]);
  const counts = new Map<string, number>();
  for (const a of runtime.facility.assets) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
  return (
    <Section
      title="Layers"
      aside={
        <button type="button" className="link-button" onClick={() => runtime.setAllCategories(!allOn)}>
          {allOn ? 'Hide all' : 'Show all'}
        </button>
      }
    >
      <div className="chips">
        {ASSET_CATEGORIES.map((c) => (
          <button key={c} type="button" className={`chip${layers.categories[c] ? ' is-on' : ''}`} aria-pressed={layers.categories[c]} onClick={() => runtime.toggleCategory(c)}>
            {CATEGORY_LABEL[c]}
            <span className="chip__count">{counts.get(c) ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="toggle-grid">
        <Toggle checked={layers.relations} onChange={(v) => runtime.setLayer('relations', v)} label="Relationships" hint="Show the dependency graph as arcs. Dashes travel from supplier to consumer." />
        <Toggle checked={layers.labels} onChange={(v) => runtime.setLayer('labels', v)} label="Labels" />
        <Toggle checked={layers.sensors} onChange={(v) => runtime.setLayer('sensors', v)} label="Signal markers" />
        <Toggle checked={layers.structures} onChange={(v) => runtime.setLayer('structures', v)} label="Buildings" />
        <Toggle
          checked={layers.ot}
          onChange={(v) => runtime.setLayer('ot', v)}
          label="OT network"
          hint="Controllers and control-room hosts, dashed control links to the machines each controller drives (declared, not inferred), and network links. Devices take the colour of recent cyber events."
        />
      </div>
      {layers.relations ? (
        <div className="chips chips--relations">
          {RELATION_TYPES.map((t) => (
            <button key={t} type="button" className={`chip chip--rel chip--${t}${layers.relationTypes[t] ? ' is-on' : ''}`} aria-pressed={layers.relationTypes[t]} onClick={() => runtime.toggleRelationType(t)}>
              <span className="chip__swatch" aria-hidden="true" />
              {RELATION_LABEL[t]}
            </button>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

/** Always-visible simulation transport: the two controls a demonstration needs constantly. */
function Transport() {
  const runtime = useRuntime();
  const running = useUi((s) => s.running);
  const speed = useUi((s) => s.speed);
  return (
    <div className="transport">
      <button type="button" className={`btn${running ? '' : ' btn--primary'}`} onClick={() => runtime.setRunning(!running)} title="Pause or resume the simulation (P)">
        {running ? 'Pause' : 'Resume'}
      </button>
      <div className="segmented" role="group" aria-label="Simulation speed">
        {SPEEDS.map((s) => (
          <button key={s} type="button" className={s === speed ? 'is-active' : ''} onClick={() => runtime.setSpeed(s)} aria-pressed={s === speed}>
            ×{s}
          </button>
        ))}
      </div>
      <button type="button" className="icon-button transport__close" onClick={() => runtime.togglePanel('leftOpen')} aria-label="Hide controls" title="Hide controls">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </button>
    </div>
  );
}

const LEFT_TABS: Array<{ id: LeftTab; label: string }> = [
  { id: 'scenarios', label: 'Scenarios' },
  { id: 'sonar', label: 'Sonar' },
  { id: 'layers', label: 'Layers' },
];

export function ControlRail() {
  const runtime = useRuntime();
  const open = useUi((s) => s.leftOpen);
  const tab = useUi((s) => s.leftTab);
  return (
    <aside className={`rail rail--left${open ? ' is-open' : ''}`} aria-label="Controls">
      <Transport />
      <div className="tabs" role="tablist">
        {LEFT_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? ' is-active' : ''}`} onClick={() => runtime.setLeftTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="rail__scroll">
        {tab === 'scenarios' ? (
          <>
            <Scenarios />
            <SimulationControls />
          </>
        ) : null}
        {tab === 'sonar' ? <SonarControls /> : null}
        {tab === 'layers' ? (
          <>
            <Layers />
            <div className="rail__foot">
              <button type="button" className="btn btn--ghost" onClick={() => runtime.resetView()} title="Return the camera to the overview (R)">
                Reset view
              </button>
              <span className="hint">Drag to orbit · right-drag to pan · scroll to zoom · double-click an asset to frame it</span>
            </div>
          </>
        ) : null}
      </div>
    </aside>
  );
}
