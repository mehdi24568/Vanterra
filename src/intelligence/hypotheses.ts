/**
 * Deterministic, rule-based reasoner.
 *
 * A hypothesis template is a named failure mechanism plus a list of weighted
 * evidence criteria - things that should be visible in the telemetry if the
 * mechanism were at work (supports), and things that should *not* be (contradicts).
 * Criteria are expressed relative to a focal asset through the dependency graph
 * ("the motor that drives it", "the line it discharges into"), so templates are
 * reusable across assets and are not tied to particular tags.
 *
 * The score is the share of weighted supporting evidence observed, minus observed
 * contradicting evidence. It is an evidence-support score, never a probability,
 * and nothing in here can mark a hypothesis as confirmed.
 */
import type {
  Anomaly,
  AnomalyDirection,
  AnomalyKind,
  AssetDefinition,
  CriterionResult,
  HypothesisAssessment,
  RelationType,
  SupportBand,
} from '../core/types';
import { SEVERITY_RANK } from '../core/types';
import { clamp, formatValue } from '../core/format';
import type { AssetGraph } from '../graph/AssetGraph';
import type { ReasoningContext, ReasoningProvider } from './reasoning';

interface Ctx extends ReasoningContext {
  focal: string;
}

type Sel = (c: Ctx) => string[];

interface Evidence {
  observed: boolean;
  detail: string;
  anomalyIds: string[];
  signalIds: string[];
}

interface CriterionDef {
  id: string;
  role: 'supports' | 'contradicts';
  weight: number;
  key?: boolean;
  description: string;
  test: (c: Ctx) => Evidence;
}

interface Template {
  id: string;
  appliesTo: (asset: AssetDefinition, graph: AssetGraph) => boolean;
  title: (c: Ctx) => string;
  mechanism: string;
  criteria: CriterionDef[];
  unknowns: string[];
  verification: string;
  investigation: (c: Ctx) => string[];
}

interface Match {
  keys?: string[];
  directions?: AnomalyDirection[];
  kinds?: AnomalyKind[];
}

// --------------------------------------------------------------- selectors ---

const self: Sel = (c) => [c.focal];

/** Assets reachable from the focal asset along one relation type, up to `depth` steps. */
function walk(type: RelationType, dir: 'down' | 'up', depth: number): Sel {
  return (c) => {
    const seen = new Set<string>();
    let frontier = [c.focal];
    for (let i = 0; i < depth; i++) {
      const next: string[] = [];
      for (const id of frontier) {
        const nbs = dir === 'down' ? c.graph.consumers(id, type) : c.graph.suppliers(id, type);
        for (const n of nbs) {
          if (n !== c.focal && !seen.has(n)) {
            seen.add(n);
            next.push(n);
          }
        }
      }
      frontier = next;
    }
    return [...seen];
  };
}

/** Other consumers of the focal asset's suppliers (machines sharing a supply). */
function siblings(type: RelationType): Sel {
  return (c) => {
    const res = new Set<string>();
    for (const s of c.graph.suppliers(c.focal, type)) {
      for (const k of c.graph.consumers(s, type)) if (k !== c.focal) res.add(k);
    }
    return [...res];
  };
}

const keyOf = (signalId: string) => signalId.slice(signalId.indexOf('.') + 1);
const unique = <T>(xs: T[]) => [...new Set(xs)];
const tagName = (c: Ctx, id: string) => {
  const a = c.graph.asset(id);
  return a ? `${id} ${a.name}` : id;
};
const list = (ids: string[]) => (ids.length ? ids.join(', ') : 'n/a');

// ---------------------------------------------------------------- evidence ---

function find(c: Ctx, assets: string[], m: Match): Anomaly[] {
  return c.anomalies.filter((a) => {
    if (!assets.includes(a.assetId)) return false;
    if (m.kinds && !m.kinds.includes(a.kind)) return false;
    if (!m.kinds && a.kind === 'composite') return false;
    if (m.directions && !m.directions.includes(a.direction)) return false;
    if (m.keys && a.kind !== 'composite' && !m.keys.includes(keyOf(a.signalId))) return false;
    return true;
  });
}

function summarise(found: Anomaly[]): string {
  // One line per signal, keeping the most severe anomaly on each.
  const bySignal = new Map<string, Anomaly>();
  for (const a of found) {
    const k = a.kind === 'composite' ? `${a.assetId}#${a.id}` : a.signalId;
    const prev = bySignal.get(k);
    if (!prev || SEVERITY_RANK[a.severity] > SEVERITY_RANK[prev.severity]) bySignal.set(k, a);
  }
  return [...bySignal.values()]
    .slice(0, 4)
    .map((a) => {
      if (a.kind === 'composite') return `${a.assetId}: ${a.message.toLowerCase()} (+${a.observed.peak.toFixed(0)} %)`;
      const base = a.observed.baselineMean !== undefined ? `, baseline ${formatValue(a.observed.baselineMean)}` : '';
      const state = a.status === 'cleared' ? ', since cleared' : '';
      return `${a.signalId} ${a.direction} (${formatValue(a.observed.peak, a.unit)}${base}${state})`;
    })
    .join('; ');
}

function candidateSignals(c: Ctx, assets: string[], keys: string[] | undefined): string[] {
  if (!keys) return [];
  const out: string[] = [];
  for (const id of assets) for (const k of keys) if (c.signal(`${id}.${k}`)) out.push(`${id}.${k}`);
  return out;
}

/** Evidence: at least one matching anomaly on at least `minAssets` of the selected assets. */
function seen(sel: Sel, m: Match, minAssets = 1): (c: Ctx) => Evidence {
  return (c) => {
    const assets = sel(c);
    const found = find(c, assets, m);
    const ok = found.length > 0 && new Set(found.map((a) => a.assetId)).size >= minAssets;
    if (ok) {
      return {
        observed: true,
        detail: summarise(found),
        anomalyIds: found.map((a) => a.id),
        signalIds: unique(found.flatMap((a) => a.signalIds)),
      };
    }
    const checked = candidateSignals(c, assets, m.keys);
    return {
      observed: false,
      detail: checked.length ? `Not detected on ${checked.join(', ')}` : `Not detected on ${list(assets)}`,
      anomalyIds: [],
      signalIds: checked,
    };
  };
}

function anyOf(...tests: Array<(c: Ctx) => Evidence>): (c: Ctx) => Evidence {
  return (c) => {
    const results = tests.map((t) => t(c));
    const hits = results.filter((r) => r.observed);
    if (hits.length > 0) {
      return {
        observed: true,
        detail: hits.map((h) => h.detail).join('; '),
        anomalyIds: unique(hits.flatMap((h) => h.anomalyIds)),
        signalIds: unique(hits.flatMap((h) => h.signalIds)),
      };
    }
    return {
      observed: false,
      detail: results.map((r) => r.detail).join('; '),
      anomalyIds: [],
      signalIds: unique(results.flatMap((r) => r.signalIds)),
    };
  };
}

type NormalMode = 'within' | 'not_low';

function isNormal(c: Ctx, signalId: string, mode: NormalMode = 'within'): boolean {
  const b = c.baseline(signalId);
  if (!b || !b.ready) return false;
  const z = c.zScore(signalId);
  if (mode === 'not_low') return z > -2.5;
  if (Math.abs(z) >= 2.5) return false;
  if (c.hasActiveAnomaly(signalId)) return false;
  return true;
}

/**
 * Evidence: every listed signal exists, has a baseline, and currently sits within it
 * ('within'), or at least is not below it ('not_low').
 */
function normal(sel: Sel, keys: string[], mode: NormalMode = 'within'): (c: Ctx) => Evidence {
  return (c) => {
    const ids = candidateSignals(c, sel(c), keys);
    if (ids.length === 0) return { observed: false, detail: 'No applicable signals available', anomalyIds: [], signalIds: [] };
    const bad = ids.filter((id) => !isNormal(c, id, mode));
    if (bad.length > 0) {
      return { observed: false, detail: `Abnormal or not assessable: ${bad.join(', ')}`, anomalyIds: [], signalIds: ids };
    }
    const detail = ids
      .slice(0, 4)
      .map((id) => `${id} ${formatValue(c.latest(id), c.signal(id)?.unit)} (${c.zScore(id).toFixed(1)}σ from baseline)`)
      .join('; ');
    return { observed: true, detail, anomalyIds: [], signalIds: ids };
  };
}

/** Evidence: a listed signal currently reads more than `frac` above its design value. */
function aboveDesign(sel: Sel, keys: string[], frac: number): (c: Ctx) => Evidence {
  return (c) => {
    const ids = candidateSignals(c, sel(c), keys);
    const high = ids.filter((id) => {
      const def = c.signal(id);
      const v = c.latest(id);
      return def !== undefined && v !== undefined && def.nominal > 0 && v > def.nominal * (1 + frac);
    });
    return {
      observed: high.length > 0,
      detail: high.length
        ? high.map((id) => `${id} ${formatValue(c.latest(id), c.signal(id)?.unit)} vs design ${formatValue(c.signal(id)?.nominal)}`).join('; ')
        : ids.length
          ? `${ids.join(', ')} at or below design value`
          : 'No applicable signals available',
      anomalyIds: [],
      signalIds: ids,
    };
  };
}

/** How much an anomaly has grown since detection, relative to its initial excursion. */
function growth(a: Anomaly): number | null {
  const base = a.observed.baselineMean;
  if (base === undefined) return null;
  const d0 = a.observed.valueAtOpen - base;
  if (Math.abs(d0) < 1e-9) return null;
  const dPeak = a.observed.peak - base;
  const dNow = a.observed.value - base;
  return (Math.abs(dPeak) > Math.abs(dNow) ? dPeak : dNow) / d0;
}

function trendTest(keys: string[], mode: 'progressive' | 'stable'): (c: Ctx) => Evidence {
  return (c) => {
    const found = find(c, [c.focal], { keys }).filter((a) => growth(a) !== null);
    if (found.length === 0) return { observed: false, detail: 'No trend information yet', anomalyIds: [], signalIds: [] };
    const best = found.reduce((p, a) => ((growth(a) ?? 0) > (growth(p) ?? 0) ? a : p));
    const g = growth(best) ?? 1;
    const ageS = (c.now - best.startedAt) / 1000;
    const observed = mode === 'progressive' ? g >= 1.6 : ageS >= 30 && g < 1.3;
    const detail =
      mode === 'progressive'
        ? `${best.signalId} excursion is ${g.toFixed(1)}× its size at detection (${ageS.toFixed(0)} s ago)`
        : ageS < 30
          ? `${best.signalId}: too early to judge (${ageS.toFixed(0)} s since detection)`
          : `${best.signalId} excursion is ${g.toFixed(1)}× its size at detection`;
    return { observed, detail, anomalyIds: observed ? [best.id] : [], signalIds: [best.signalId] };
  };
}

// --------------------------------------------------------------- templates ---

const HIGHISH: AnomalyDirection[] = ['high', 'rising'];
const VIB_ABNORMAL = seen(self, { keys: ['VIB'], directions: ['high', 'rising', 'unstable'] });
const BRG_HOT = seen(self, { keys: ['BRG_TEMP'], directions: HIGHISH });
const DRIVER_CURRENT = seen(walk('mechanical', 'up', 1), { keys: ['CURRENT'], directions: ['high', 'unstable'] });
const SPEC_CURRENT = seen(self, { kinds: ['composite'] });
const DISCHARGE_WEAK = seen(walk('process', 'down', 1), { keys: ['PRESS'], directions: ['low', 'unstable'] });
const FLOW_DEFICIT = seen(walk('process', 'down', 1), { keys: ['FLOW'], directions: ['low'] });

const isPump = (a: AssetDefinition) => a.category === 'pump';
const hasKey = (a: AssetDefinition, key: string) => a.signals.some((s) => s.key === key);

function alternates(c: Ctx): string[] {
  const res = new Set<string>();
  for (const d of c.graph.consumers(c.focal, 'process')) {
    for (const s of c.graph.suppliers(d, 'process')) {
      if (s !== c.focal && c.graph.asset(s)?.category === 'pump') res.add(s);
    }
  }
  return [...res];
}

const TEMPLATES: Template[] = [
  {
    id: 'bearing_wear',
    appliesTo: (a, g) => isPump(a) && g.consumers(a.id, 'process').length > 0,
    title: (c) => `Bearing or rotating-element degradation in ${tagName(c, c.focal)}`,
    mechanism:
      'Mechanical wear raises vibration first; friction then heats the bearing. As clearances open the pump loses head and efficiency, so the driver works harder for less delivered flow.',
    criteria: [
      { id: 'vib', role: 'supports', weight: 3, key: true, description: 'Vibration on the pump is abnormal', test: VIB_ABNORMAL },
      {
        id: 'vib_progressive',
        role: 'supports',
        weight: 1.5,
        description: 'Vibration has kept growing since detection (progressive, not a step change)',
        test: trendTest(['VIB'], 'progressive'),
      },
      { id: 'brg_temp', role: 'supports', weight: 3, key: true, description: 'Bearing temperature is high or rising', test: BRG_HOT },
      {
        id: 'driver_load',
        role: 'supports',
        weight: 1.5,
        description: 'Driver draws more current, or more current per unit of flow',
        test: anyOf(DRIVER_CURRENT, SPEC_CURRENT),
      },
      { id: 'discharge', role: 'supports', weight: 1, description: 'Discharge pressure is low or unstable', test: DISCHARGE_WEAK },
      { id: 'flow', role: 'supports', weight: 1, description: 'Delivered flow is below demand', test: FLOW_DEFICIT },
      {
        id: 'lube_abnormal',
        role: 'contradicts',
        weight: 2,
        description: 'Lubrication supply is abnormal (would point to a lubrication cause first)',
        test: seen(walk('utility', 'up', 1), { keys: ['OIL_P', 'OIL_TEMP'] }),
      },
    ],
    unknowns: [
      'Vibration is overall RMS only - there is no spectrum, so bearing defect frequencies cannot be checked.',
      'No oil-debris or acoustic-emission data is available.',
    ],
    verification: 'Vibration spectrum / envelope analysis at the bearings, followed by physical inspection.',
    investigation: (c) => {
      const alt = alternates(c);
      return [
        `Take a vibration spectrum at the ${c.focal} drive-end and non-drive-end bearings; look for defect frequencies and a raised noise floor.`,
        `Check ${c.focal} bearing housing temperature locally (contact probe or IR) against the transmitter reading.`,
        `Inspect lubricant condition at ${c.focal}: level, colour and debris.`,
        alt.length
          ? `Prepare ${list(alt)} for a duty changeover so ${c.focal} is not run to failure.`
          : `Plan a controlled shutdown of ${c.focal}; no standby unit is recorded in the asset model.`,
      ];
    },
  },
  {
    id: 'cavitation',
    appliesTo: (a, g) => isPump(a) && g.suppliers(a.id, 'process').length > 0,
    title: (c) => `Cavitation or suction starvation at ${tagName(c, c.focal)}`,
    mechanism:
      'Insufficient suction head lets vapour bubbles form and collapse in the impeller, producing vibration, noisy unstable discharge pressure and reduced flow.',
    criteria: [
      {
        id: 'suction_low',
        role: 'supports',
        weight: 3,
        key: true,
        description: 'Suction pressure is low',
        test: seen(walk('process', 'up', 1), { keys: ['PRESS'], directions: ['low', 'falling', 'unstable'] }),
      },
      {
        id: 'tank_low',
        role: 'supports',
        weight: 2,
        description: 'Feed tank level is low or falling',
        test: seen(walk('process', 'up', 2), { keys: ['LEVEL'], directions: ['low', 'falling'] }),
      },
      { id: 'vib', role: 'supports', weight: 2, key: true, description: 'Vibration on the pump is abnormal', test: VIB_ABNORMAL },
      { id: 'discharge', role: 'supports', weight: 2, description: 'Discharge pressure is low or unstable', test: DISCHARGE_WEAK },
      { id: 'flow', role: 'supports', weight: 1, description: 'Delivered flow is below demand', test: FLOW_DEFICIT },
      {
        id: 'suction_normal',
        role: 'contradicts',
        weight: 3,
        description: 'Suction pressure is not low (at or above its baseline)',
        test: normal(walk('process', 'up', 1), ['PRESS'], 'not_low'),
      },
      {
        id: 'brg_heating',
        role: 'contradicts',
        weight: 1.5,
        description: 'Bearing temperature is rising (not typical of cavitation alone)',
        test: BRG_HOT,
      },
    ],
    unknowns: ['Fluid vapour pressure and NPSH margin are not modelled by the engine.'],
    verification: 'Local suction gauge reading compared with NPSH required; listen for crackling at the casing.',
    investigation: (c) => [
      `Read suction pressure at ${c.focal} locally and compare with the NPSH required at current flow.`,
      `Check the suction strainer differential pressure and the position of suction isolation valves upstream of ${c.focal}.`,
    ],
  },
  {
    id: 'lube_loss',
    appliesTo: (a, g) => isPump(a) && g.suppliers(a.id, 'utility').length > 0,
    title: (c) => `Loss of lubrication to ${tagName(c, c.focal)} bearings`,
    mechanism:
      'Reduced oil supply pressure or degraded oil starves the bearings of cooling and film thickness; temperature rises on every bearing fed from the same system.',
    criteria: [
      {
        id: 'lube_supply',
        role: 'supports',
        weight: 3,
        key: true,
        description: 'Lube oil supply pressure or temperature is abnormal',
        test: seen(walk('utility', 'up', 1), { keys: ['OIL_P', 'OIL_TEMP'] }),
      },
      { id: 'brg_temp', role: 'supports', weight: 2, key: true, description: 'Bearing temperature is high or rising', test: BRG_HOT },
      { id: 'vib', role: 'supports', weight: 1, description: 'Vibration on the pump is abnormal', test: VIB_ABNORMAL },
      {
        id: 'siblings_hot',
        role: 'supports',
        weight: 2,
        description: 'Other bearings on the same lube system are also heating',
        test: seen(siblings('utility'), { keys: ['BRG_TEMP'], directions: HIGHISH }),
      },
      {
        id: 'supply_normal',
        role: 'contradicts',
        weight: 3,
        description: 'Lube oil supply pressure and temperature are within their baselines',
        test: normal(walk('utility', 'up', 1), ['OIL_P', 'OIL_TEMP']),
      },
    ],
    unknowns: ['Oil flow to the individual bearing is not measured - a blocked local feed line would not show at the skid.'],
    verification: 'Oil flow sight-glass at the bearing and a lube oil sample.',
    investigation: (c) => [
      `Check the oil flow sight-glass and feed line at ${c.focal}; confirm oil is reaching the bearing.`,
      `Verify filter differential pressure and reservoir level at ${list(walk('utility', 'up', 1)(c))}.`,
    ],
  },
  {
    id: 'misalignment',
    appliesTo: (a, g) => isPump(a) && g.suppliers(a.id, 'mechanical').length > 0,
    title: (c) => `Shaft misalignment or coupling fault between ${list(walk('mechanical', 'up', 1)(c))} and ${c.focal}`,
    mechanism:
      'Misalignment loads the bearings cyclically: vibration steps up and bearings run warmer, but the hydraulic performance of the pump is normally unaffected.',
    criteria: [
      { id: 'vib', role: 'supports', weight: 3, key: true, description: 'Vibration on the pump is abnormal', test: VIB_ABNORMAL },
      {
        id: 'vib_stable',
        role: 'supports',
        weight: 2,
        description: 'Vibration stepped up and has stayed level since',
        test: trendTest(['VIB'], 'stable'),
      },
      { id: 'brg_temp', role: 'supports', weight: 1.5, description: 'Bearing temperature is high or rising', test: BRG_HOT },
      { id: 'driver_current', role: 'supports', weight: 1, description: 'Driver current is elevated', test: DRIVER_CURRENT },
      {
        id: 'hydraulic_loss',
        role: 'contradicts',
        weight: 2,
        description: 'Hydraulic performance has degraded (not expected from misalignment alone)',
        test: anyOf(DISCHARGE_WEAK, FLOW_DEFICIT),
      },
    ],
    unknowns: [
      'No axial vibration or phase measurement, which is what distinguishes misalignment.',
      'Maintenance history (for example a recent re-coupling) is not available to the engine.',
    ],
    verification: 'Laser or dial-indicator alignment check with the machine stopped and locked out.',
    investigation: (c) => [
      `Check coupling alignment between ${list(walk('mechanical', 'up', 1)(c))} and ${c.focal}; inspect the coupling element, hold-down bolts and soft foot.`,
    ],
  },
  {
    id: 'motor_fault',
    appliesTo: (a) => a.category === 'motor',
    title: (c) => `Electrical or winding fault in ${tagName(c, c.focal)}`,
    mechanism:
      'A developing stator or rotor fault raises current and winding temperature on one motor, without a matching change in the machine it drives or in its supply.',
    criteria: [
      {
        id: 'current',
        role: 'supports',
        weight: 2,
        key: true,
        description: 'Stator current is elevated or unstable',
        test: seen(self, { keys: ['CURRENT'], directions: ['high', 'unstable'] }),
      },
      {
        id: 'winding',
        role: 'supports',
        weight: 3,
        description: 'Winding temperature is high or rising',
        test: seen(self, { keys: ['WIND_TEMP'], directions: HIGHISH }),
      },
      {
        id: 'load_side',
        role: 'contradicts',
        weight: 3,
        description: 'The driven machine shows mechanical anomalies (a load-side origin is more likely)',
        test: anyOf(
          seen(walk('mechanical', 'down', 1), { keys: ['VIB', 'BRG_TEMP'] }),
          seen(walk('mechanical', 'down', 1), { kinds: ['composite'] }),
        ),
      },
      {
        id: 'supply_low',
        role: 'contradicts',
        weight: 3,
        description: 'Supply voltage at the feeding board is low (explains higher current on a constant-power load)',
        test: seen(walk('electrical', 'up', 1), { keys: ['VOLT'], directions: ['low', 'falling'] }),
      },
      {
        id: 'siblings_same',
        role: 'contradicts',
        weight: 2,
        description: 'Other consumers on the same board show the same current rise',
        test: seen(siblings('electrical'), { keys: ['CURRENT'], directions: ['high'] }),
      },
    ],
    unknowns: ['No per-phase currents or insulation-resistance data, so phase imbalance cannot be assessed.'],
    verification: 'Per-phase current and voltage measurement at the starter; insulation resistance test.',
    investigation: (c) => [
      `Measure per-phase currents and voltage balance at the ${c.focal} starter.`,
      `Schedule an insulation-resistance test of ${c.focal} at the next opportunity.`,
    ],
  },
  {
    id: 'tower_airflow_loss',
    appliesTo: (a) => hasKey(a, 'FAN_CURRENT'),
    title: (c) => `Loss of airflow at ${tagName(c, c.focal)} (fan failure)`,
    mechanism:
      'Without forced draught the tower rejects far less heat. Basin temperature climbs, the trim chiller loads up until it saturates, and warmer cooling water then reaches the process.',
    criteria: [
      {
        id: 'fan',
        role: 'supports',
        weight: 3,
        key: true,
        description: 'Fan reports a trip, or fan current / vibration has collapsed',
        test: anyOf(
          seen(self, { keys: ['STATUS'], directions: ['high'] }),
          seen(self, { keys: ['FAN_CURRENT', 'FAN_VIB'], directions: ['low', 'falling'] }),
        ),
      },
      {
        id: 'basin',
        role: 'supports',
        weight: 3,
        key: true,
        description: 'Basin water temperature is high or rising',
        test: seen(self, { keys: ['BASIN_TEMP'], directions: HIGHISH }),
      },
      {
        id: 'chiller',
        role: 'supports',
        weight: 1.5,
        description: 'Downstream chiller is loading up',
        test: seen(walk('cooling', 'down', 3), { keys: ['LOAD', 'COMP_CURRENT'], directions: HIGHISH }),
      },
      {
        id: 'cws',
        role: 'supports',
        weight: 1.5,
        description: 'Cooling-water supply temperature is high or rising',
        test: seen(walk('cooling', 'down', 4), { keys: ['TEMP'], directions: HIGHISH }),
      },
      {
        id: 'process',
        role: 'supports',
        weight: 1,
        description: 'Process cooler outlet temperature is high or rising',
        test: seen(walk('cooling', 'down', 5), { keys: ['T_OUT'], directions: HIGHISH }),
      },
    ],
    unknowns: ['Ambient wet-bulb temperature is not measured, so a weather-driven rise cannot be excluded by the engine.'],
    verification: 'Local inspection of the fan drive: starter trip flag, gearbox, blades.',
    investigation: (c) => [
      `Check the ${c.focal} fan starter at ${list(walk('electrical', 'up', 1)(c))} for a trip indication and its cause (overload, earth fault).`,
      `Inspect the ${c.focal} fan mechanically before any restart: gearbox, blades, obstruction.`,
      'Consider reducing throughput (heat load) if cooling-water supply temperature keeps rising.',
    ],
  },
  {
    id: 'cw_circulation_loss',
    appliesTo: (a, g) => isPump(a) && g.outgoing(a.id).some((r) => r.type === 'cooling'),
    title: (c) => `Loss of cooling-water circulation at ${tagName(c, c.focal)}`,
    mechanism: 'A failing circulation pump reduces cooling-water flow; less heat is removed in the process cooler even though supply temperature is normal.',
    criteria: [
      {
        id: 'flow_low',
        role: 'supports',
        weight: 3,
        key: true,
        description: 'Cooling-water flow is low',
        test: seen(walk('cooling', 'down', 3), { keys: ['FLOW'], directions: ['low', 'falling'] }),
      },
      {
        id: 'press_low',
        role: 'supports',
        weight: 2,
        key: true,
        description: 'Circulation pump discharge pressure is low',
        test: seen(walk('cooling', 'down', 1), { keys: ['PRESS'], directions: ['low', 'falling', 'unstable'] }),
      },
      {
        id: 'pump_mech',
        role: 'supports',
        weight: 2,
        description: 'The circulation pump or its driver shows anomalies',
        test: anyOf(seen(self, { keys: ['VIB', 'BRG_TEMP', 'STATUS'] }), DRIVER_CURRENT),
      },
      {
        id: 'process',
        role: 'supports',
        weight: 1,
        key: true,
        description: 'Process cooler outlet temperature is high or rising',
        test: seen(walk('cooling', 'down', 4), { keys: ['T_OUT'], directions: HIGHISH }),
      },
      {
        id: 'flow_normal',
        role: 'contradicts',
        weight: 3,
        description: 'Cooling-water flow and pump discharge pressure are within their baselines',
        test: normal(walk('cooling', 'down', 3), ['FLOW', 'PRESS']),
      },
    ],
    unknowns: [],
    verification: 'Local flow / pressure reading at the pump discharge.',
    investigation: (c) => [`Confirm cooling-water flow and discharge pressure at ${c.focal} locally.`],
  },
  {
    id: 'chiller_fault',
    appliesTo: (a) => hasKey(a, 'COMP_CURRENT'),
    title: (c) => `Capacity fault in ${tagName(c, c.focal)}`,
    mechanism: 'A chiller that trips or unloads stops trimming the supply temperature; cooling water leaves it warmer while the chiller itself draws little power.',
    criteria: [
      {
        id: 'cws',
        role: 'supports',
        weight: 3,
        key: true,
        description: 'Cooling-water supply temperature is high or rising',
        test: seen(walk('cooling', 'down', 1), { keys: ['TEMP'], directions: HIGHISH }),
      },
      {
        id: 'unloaded',
        role: 'supports',
        weight: 3,
        description: 'Chiller load or compressor current has dropped',
        test: seen(self, { keys: ['LOAD', 'COMP_CURRENT'], directions: ['low', 'falling'] }),
      },
      {
        id: 'loaded',
        role: 'contradicts',
        weight: 2,
        description: 'Chiller is running at high load (it is responding, not failing)',
        test: seen(self, { keys: ['LOAD', 'COMP_CURRENT'], directions: HIGHISH }),
      },
      {
        id: 'inlet_hot',
        role: 'contradicts',
        weight: 2,
        description: 'Water arriving from the tower is already too warm',
        test: seen(walk('cooling', 'up', 3), { keys: ['BASIN_TEMP'], directions: HIGHISH }),
      },
    ],
    unknowns: ['Refrigerant-side pressures and the chiller alarm log are not available to the engine.'],
    verification: 'Chiller controller alarm history and refrigerant circuit readings.',
    investigation: (c) => [`Review the ${c.focal} controller alarm log and leaving-water setpoint.`],
  },
  {
    id: 'hx_fouling',
    appliesTo: (a) => a.category === 'heat_exchanger',
    title: (c) => `Fouling of ${tagName(c, c.focal)}`,
    mechanism: 'Deposits reduce heat transfer and restrict the tube bundle: outlet temperature creeps up together with differential pressure, typically over days rather than minutes.',
    criteria: [
      {
        id: 't_out',
        role: 'supports',
        weight: 2,
        key: true,
        description: 'Process outlet temperature is high or rising',
        test: seen(self, { keys: ['T_OUT'], directions: HIGHISH }),
      },
      {
        id: 'dp',
        role: 'supports',
        weight: 3,
        description: 'Differential pressure across the exchanger is high',
        test: seen(self, { keys: ['DP'], directions: HIGHISH }),
      },
      {
        id: 'cws_hot',
        role: 'contradicts',
        weight: 3,
        description: 'Cooling-water supply temperature is elevated (explains reduced heat removal without fouling)',
        test: seen(walk('cooling', 'up', 1), { keys: ['TEMP'], directions: HIGHISH }),
      },
      {
        id: 'rapid',
        role: 'contradicts',
        weight: 3,
        description: 'The change happened within minutes (fouling develops over days)',
        test: seen(self, { keys: ['T_OUT', 'DP'], kinds: ['rate_of_change'] }),
      },
      {
        id: 'flow_high',
        role: 'contradicts',
        weight: 3,
        description: 'Process flow through the exchanger is above its design value (higher throughput raises both readings)',
        test: aboveDesign(walk('process', 'up', 1), ['FLOW'], 0.05),
      },
    ],
    unknowns: ['There is no shell-side differential pressure measurement.'],
    verification: 'Long-term trend of approach temperature and differential pressure; inspection at the next outage.',
    investigation: (c) => [`Trend ${c.focal} approach temperature and differential pressure over the past weeks.`],
  },
  {
    id: 'mcc_joint',
    appliesTo: (a) => a.category === 'electrical' && hasKey(a, 'BUS_TEMP'),
    title: (c) => `High-resistance connection at the ${tagName(c, c.focal)} incomer`,
    mechanism:
      'A deteriorating bolted joint or contact adds series resistance: voltage is lost across it and dissipated as heat at the joint. Constant-power loads downstream draw more current to compensate.',
    criteria: [
      {
        id: 'volt_low',
        role: 'supports',
        weight: 3,
        key: true,
        description: 'Bus voltage at this board is low',
        test: seen(self, { keys: ['VOLT'], directions: ['low', 'falling'] }),
      },
      {
        id: 'joint_hot',
        role: 'supports',
        weight: 3,
        key: true,
        description: 'Incomer joint temperature is high or rising',
        test: seen(self, { keys: ['BUS_TEMP'], directions: HIGHISH }),
      },
      {
        id: 'consumers',
        role: 'supports',
        weight: 2,
        description: 'Two or more consumers fed from this board draw more current',
        test: seen(walk('electrical', 'down', 1), { keys: ['CURRENT'], directions: ['high'] }, 2),
      },
      {
        id: 'localised',
        role: 'supports',
        weight: 2,
        description: 'Voltage at the transformer and at the neighbouring board is normal (the drop is local to this board)',
        test: (c) => {
          const up = normal(walk('electrical', 'up', 1), ['LV_VOLT'])(c);
          const side = normal(siblings('electrical'), ['VOLT'])(c);
          return {
            observed: up.observed && side.observed,
            detail: [up.detail, side.detail].join('; '),
            anomalyIds: [],
            signalIds: unique([...up.signalIds, ...side.signalIds]),
          };
        },
      },
      {
        id: 'upstream_low',
        role: 'contradicts',
        weight: 3,
        description: 'Voltage is also low at the transformer terminals (an upstream cause)',
        test: seen(walk('electrical', 'up', 1), { keys: ['LV_VOLT'], directions: ['low', 'falling'] }),
      },
      {
        id: 'volt_normal',
        role: 'contradicts',
        weight: 3,
        description: 'Bus voltage at this board is within its baseline (no voltage is being lost across the joint)',
        test: normal(self, ['VOLT']),
      },
    ],
    unknowns: ['No thermal imaging or per-phase voltages; the joint temperature is a single-point measurement.'],
    verification: 'Thermographic survey of the incomer and a micro-ohm test of the joint, with the board made safe.',
    investigation: (c) => [
      `Carry out a thermographic scan of the ${c.focal} incomer, busbar joints and cable terminations.`,
      `Compare line voltages at ${list(walk('electrical', 'up', 1)(c))} LV terminals and at the ${c.focal} bus to locate the voltage drop.`,
      `Plan load reduction on ${c.focal}: a heating joint can fail abruptly.`,
      'Do not open live compartments; apply site electrical safety rules.',
    ],
  },
  {
    id: 'upstream_supply_sag',
    appliesTo: (a) => hasKey(a, 'LV_VOLT'),
    title: (c) => `Supply voltage depression upstream of ${tagName(c, c.focal)}`,
    mechanism: 'A grid or transformer problem lowers the LV voltage at source, so every board fed from the transformer sees the same depression.',
    criteria: [
      {
        id: 'board_low',
        role: 'supports',
        weight: 1.5,
        key: true,
        description: 'A board fed from this transformer has low voltage',
        test: seen(walk('electrical', 'down', 1), { keys: ['VOLT'], directions: ['low', 'falling'] }),
      },
      {
        id: 'lv_low',
        role: 'supports',
        weight: 3,
        description: 'Voltage at the transformer LV terminals is low',
        test: seen(self, { keys: ['LV_VOLT'], directions: ['low', 'falling'] }),
      },
      {
        id: 'all_boards',
        role: 'supports',
        weight: 3,
        description: 'Every board fed from this transformer has low voltage',
        test: (c) => {
          const boards = walk('electrical', 'down', 1)(c).filter((id) => c.signal(`${id}.VOLT`));
          const low = boards.filter((id) => find(c, [id], { keys: ['VOLT'], directions: ['low', 'falling'] }).length > 0);
          const observed = boards.length > 1 && low.length === boards.length;
          return {
            observed,
            detail: `${low.length} of ${boards.length} boards show low voltage`,
            anomalyIds: observed ? find(c, boards, { keys: ['VOLT'] }).map((a) => a.id) : [],
            signalIds: boards.map((id) => `${id}.VOLT`),
          };
        },
      },
      {
        id: 'board_normal',
        role: 'contradicts',
        weight: 3,
        description: 'At least one board on the same transformer has normal voltage',
        test: (c) => {
          const boards = walk('electrical', 'down', 1)(c).filter((id) => c.signal(`${id}.VOLT`));
          const ok = boards.filter((id) => isNormal(c, `${id}.VOLT`));
          return {
            observed: ok.length > 0,
            detail: ok.length
              ? ok.map((id) => `${id}.VOLT ${formatValue(c.latest(`${id}.VOLT`), 'V')} within baseline`).join('; ')
              : 'No board with normal voltage',
            anomalyIds: [],
            signalIds: boards.map((id) => `${id}.VOLT`),
          };
        },
      },
    ],
    unknowns: ['HV-side voltage and tap-changer position are not measured.'],
    verification: 'HV supply voltage and tap position at the transformer.',
    investigation: (c) => [`Check HV supply voltage and tap position at ${c.focal}.`],
  },
];

// ---------------------------------------------------------------- reasoner ---

function band(support: number): SupportBand {
  if (support >= 0.75) return 'strong';
  if (support >= 0.5) return 'moderate';
  if (support >= 0.25) return 'limited';
  return 'weak';
}

function evaluateTemplate(t: Template, c: Ctx): HypothesisAssessment | null {
  const criteria: CriterionResult[] = t.criteria.map((def) => {
    const ev = def.test(c);
    return {
      id: def.id,
      role: def.role,
      description: def.description,
      weight: def.weight,
      state: ev.observed ? 'observed' : 'not_observed',
      key: def.key === true,
      detail: ev.detail,
      anomalyIds: ev.anomalyIds,
      signalIds: ev.signalIds,
    };
  });
  // A template only enters the discussion when one of its entry conditions is actually observed.
  if (!criteria.some((k) => k.key && k.role === 'supports' && k.state === 'observed')) return null;
  let total = 0;
  let got = 0;
  let against = 0;
  for (const k of criteria) {
    if (k.role === 'supports') {
      total += k.weight;
      if (k.state === 'observed') got += k.weight;
    } else if (k.state === 'observed') against += k.weight;
  }
  const support = clamp((got - against) / total, 0, 1);
  return {
    key: `${t.id}@${c.focal}`,
    templateId: t.id,
    focalAssetId: c.focal,
    title: t.title(c),
    mechanism: t.mechanism,
    support,
    band: band(support),
    criteria,
    unknowns: t.unknowns,
    verification: t.verification,
    investigation: t.investigation(c),
    alsoEvaluatedFor: [],
    disposition: 'unverified',
    dispositionAt: null,
  };
}

export class RuleBasedReasoner implements ReasoningProvider {
  readonly id = 'local-rules-v1';
  readonly label = 'Deterministic rule-based reasoner (local)';

  /** Templates known to this reasoner (exposed for documentation and tests). */
  static templateIds(): string[] {
    return TEMPLATES.map((t) => t.id);
  }

  assess(ctx: ReasoningContext): HypothesisAssessment[] {
    const incidentAssets = new Set(ctx.anomalies.map((a) => a.assetId));
    const onset = new Map<string, number>();
    for (const a of ctx.anomalies) onset.set(a.assetId, Math.min(onset.get(a.assetId) ?? Infinity, a.startedAt));

    const best = new Map<string, HypothesisAssessment>();
    const others = new Map<string, string[]>();
    const rank = (h: HypothesisAssessment) =>
      h.support * 1000 + (h.focalAssetId === ctx.originAssetId ? 5 : 0) + (incidentAssets.has(h.focalAssetId) ? 2 : 0);

    for (const t of TEMPLATES) {
      for (const asset of ctx.graph.assets) {
        if (!t.appliesTo(asset, ctx.graph)) continue;
        const h = evaluateTemplate(t, { ...ctx, focal: asset.id });
        if (!h) continue;
        const prev = best.get(t.id);
        if (!prev) {
          best.set(t.id, h);
        } else if (rank(h) > rank(prev) || (rank(h) === rank(prev) && (onset.get(h.focalAssetId) ?? Infinity) < (onset.get(prev.focalAssetId) ?? Infinity))) {
          others.set(t.id, [...(others.get(t.id) ?? []), prev.focalAssetId]);
          best.set(t.id, h);
        } else {
          others.set(t.id, [...(others.get(t.id) ?? []), h.focalAssetId]);
        }
      }
    }
    const result = [...best.values()];
    for (const h of result) h.alsoEvaluatedFor = others.get(h.templateId) ?? [];
    result.sort((a, b) => rank(b) - rank(a));
    return result.slice(0, 6);
  }
}
