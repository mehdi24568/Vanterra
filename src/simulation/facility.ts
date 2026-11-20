/**
 * Simulated facility: "Meridian Works - Unit 3", a liquid-product process and packaging unit.
 *
 * Process in one line:
 *   feed tank -> duty/standby feed pumps -> heat exchanger (cooled by a tower/chiller loop)
 *   -> mixing reactor -> filler -> conveyor -> case packer -> conveyor -> palletiser
 * supported by a 400 V distribution system, a lube-oil skid and a plant-air compressor.
 *
 * This file is pure data: asset registry, signal list (with alarm limits) and the
 * dependency relations. In a real deployment the same structure would be loaded from
 * an asset model / engineering database through a DataSourceAdapter.
 */
import type {
  AreaDefinition,
  AssetCategory,
  AssetDefinition,
  AssetModelSpec,
  AssetRelation,
  FacilityModel,
  MeasurementType,
  RatioRuleDefinition,
  RelationType,
  SignalDefinition,
  SignalLimits,
  Vec3,
} from '../core/types';

interface SigOpts {
  limits?: SignalLimits;
  rate?: number;
  sp?: string;
  dev?: { warn: number; alarm: number };
  role?: 'setpoint';
  baseline?: boolean;
  variability?: boolean;
}

type SigFactory = (assetId: string) => SignalDefinition;

function sig(
  key: string,
  name: string,
  type: MeasurementType,
  unit: string,
  range: [number, number],
  nominal: number,
  o: SigOpts = {},
): SigFactory {
  return (assetId) => {
    const analysable = o.role !== 'setpoint' && type !== 'status';
    return {
      id: `${assetId}.${key}`,
      assetId,
      key,
      name,
      type,
      unit,
      range,
      nominal,
      limits: o.limits,
      rateLimit: o.rate,
      setpointSignalId: o.sp,
      deviation: o.dev,
      role: o.role ?? 'measurement',
      detect: { baseline: o.baseline ?? analysable, variability: o.variability ?? false },
    };
  };
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function asset(
  id: string,
  name: string,
  category: AssetCategory,
  area: string,
  position: Vec3,
  model: AssetModelSpec,
  metadata: Record<string, string | number>,
  signals: SigFactory[],
  rotationY = 0,
): AssetDefinition {
  return { id, name, category, area, position, rotationY, model, metadata, signals: signals.map((f) => f(id)) };
}

// ------------------------------------------------------------ signal groups ---

const STATUS = sig('STATUS', 'Operating status', 'status', '', [0, 2], 1, { limits: { highAlarm: 1.5 } });

const pumpSignals = (vibNom: number, brgNom: number): SigFactory[] => [
  sig('VIB', 'Bearing vibration (DE, RMS)', 'vibration', 'mm/s', [0, 20], vibNom, {
    limits: { highWarn: 4.5, highAlarm: 7.1 },
  }),
  sig('BRG_TEMP', 'Bearing temperature (DE)', 'temperature', '°C', [0, 140], brgNom, {
    limits: { highWarn: 75, highAlarm: 90 },
    rate: 5,
  }),
  STATUS,
];

const motorSignals = (iNom: number, pNom: number, range: number): SigFactory[] => [
  sig('CURRENT', 'Stator current', 'current', 'A', [0, range], iNom, {
    limits: { highWarn: +(iNom * 1.12).toFixed(1), highAlarm: +(iNom * 1.23).toFixed(1) },
    variability: true,
  }),
  sig('WIND_TEMP', 'Winding temperature', 'temperature', '°C', [0, 180], 68, {
    limits: { highWarn: 95, highAlarm: 115 },
    rate: 6,
  }),
  // Power is derived from current and voltage: recorded for energy accounting, not analysed twice.
  sig('POWER', 'Electrical power', 'power', 'kW', [0, Math.round(pNom * 1.8)], pNom, { baseline: false }),
  STATUS,
];

const VOLT_LIMITS: SignalLimits = { lowAlarm: 368, lowWarn: 380, highWarn: 420, highAlarm: 430 };

const boardSignals = (iNom: number): SigFactory[] => [
  sig('VOLT', 'Bus voltage (L-L)', 'voltage', 'V', [300, 440], 398, { limits: VOLT_LIMITS }),
  sig('CURRENT', 'Incomer current', 'current', 'A', [0, 700], iNom, {
    limits: { highWarn: +(iNom * 1.2).toFixed(0), highAlarm: +(iNom * 1.35).toFixed(0) },
  }),
  sig('BUS_TEMP', 'Incomer joint temperature', 'temperature', '°C', [0, 140], 42, {
    limits: { highWarn: 65, highAlarm: 80 },
    rate: 6,
  }),
];

// -------------------------------------------------------------------- areas ---

const areas: AreaDefinition[] = [
  { id: 'A100', name: 'TANK FARM', bounds: { minX: -46, maxX: -30, minZ: -25, maxZ: 3 } },
  { id: 'A200', name: 'PUMP HOUSE', bounds: { minX: -26, maxX: -8, minZ: -27, maxZ: -7 } },
  { id: 'A300', name: 'PROCESS HALL', bounds: { minX: -5, maxX: 20, minZ: -27, maxZ: -7 } },
  { id: 'A400', name: 'PACKAGING LINE', bounds: { minX: 5, maxX: 46, minZ: 4, maxZ: 16 } },
  { id: 'A500', name: 'COOLING PLANT', bounds: { minX: 23, maxX: 46, minZ: -27, maxZ: -5 } },
  { id: 'A600', name: 'POWER & UTILITIES', bounds: { minX: -46, maxX: -6, minZ: 10, maxZ: 24 } },
];

// ------------------------------------------------------------------- assets ---

const assets: AssetDefinition[] = [
  // --- Area 100: tank farm
  asset(
    'TK-101',
    'Feed Tank A',
    'tank',
    'A100',
    v(-38, 0, -17),
    { kind: 'tank', radius: 4.5, height: 10 },
    { Service: 'Process feed', Capacity: '630 m³', Material: 'SS 304L', Commissioned: 2018, Criticality: 'B' },
    [
      sig('LEVEL', 'Tank level', 'level', '%', [0, 100], 70, {
        limits: { lowAlarm: 20, lowWarn: 35, highWarn: 90, highAlarm: 96 },
        rate: 6,
      }),
      sig('TEMP', 'Bulk temperature', 'temperature', '°C', [0, 120], 68, { limits: { highWarn: 78, highAlarm: 85 } }),
    ],
  ),
  asset(
    'TK-102',
    'Feed Tank B (reserve)',
    'tank',
    'A100',
    v(-38, 0, -5),
    { kind: 'tank', radius: 4.5, height: 10 },
    { Service: 'Reserve feed, isolated', Capacity: '630 m³', Material: 'SS 304L', Commissioned: 2018, Criticality: 'C' },
    [sig('LEVEL', 'Tank level', 'level', '%', [0, 100], 81, { limits: { lowAlarm: 10, lowWarn: 20, highAlarm: 96 } })],
  ),

  // --- Area 200: pump house
  asset(
    'P-101',
    'Feed Pump A',
    'pump',
    'A200',
    v(-19, 0, -19),
    { kind: 'pump' },
    {
      Type: 'Centrifugal, end-suction',
      'Rated duty': '135 m³/h @ 62 m',
      Role: 'Duty',
      Bearings: '6313 C3 / 7313 BECBM',
      Commissioned: 2019,
      'Last service': '2025-09-18',
      Criticality: 'A',
    },
    pumpSignals(2.2, 56),
  ),
  asset(
    'M-101',
    'Feed Pump A Motor',
    'motor',
    'A200',
    v(-19, 0, -22.4),
    { kind: 'motor', size: 1, shaftY: 1.2 },
    { Type: 'Induction, IE3', Rating: '55 kW / 400 V', 'Full-load current': '98 A', Speed: '2970 rpm', Criticality: 'A' },
    motorSignals(86, 51, 160),
  ),
  asset(
    'P-102',
    'Feed Pump B',
    'pump',
    'A200',
    v(-13, 0, -19),
    { kind: 'pump' },
    {
      Type: 'Centrifugal, end-suction',
      'Rated duty': '135 m³/h @ 62 m',
      Role: 'Standby',
      Bearings: '6313 C3 / 7313 BECBM',
      Commissioned: 2019,
      'Last service': '2025-11-04',
      Criticality: 'A',
    },
    pumpSignals(2.0, 55),
  ),
  asset(
    'M-102',
    'Feed Pump B Motor',
    'motor',
    'A200',
    v(-13, 0, -22.4),
    { kind: 'motor', size: 1, shaftY: 1.2 },
    { Type: 'Induction, IE3', Rating: '55 kW / 400 V', 'Full-load current': '98 A', Speed: '2970 rpm', Criticality: 'A' },
    motorSignals(86, 51, 160),
  ),
  asset(
    'LS-601',
    'Lube Oil Skid',
    'utility',
    'A200',
    v(-16, 0, -11),
    { kind: 'lube_skid' },
    { Service: 'Bearing lubrication, pump trains', Oil: 'ISO VG 46', Reservoir: '400 L', 'Last oil sample': '2025-12-02', Criticality: 'B' },
    [
      sig('OIL_P', 'Supply header pressure', 'pressure', 'bar', [0, 5], 2.4, { limits: { lowAlarm: 1.4, lowWarn: 1.8 } }),
      sig('OIL_TEMP', 'Supply temperature', 'temperature', '°C', [0, 100], 45, {
        limits: { highWarn: 60, highAlarm: 70 },
        rate: 4,
      }),
    ],
  ),
  asset(
    'PL-100',
    'Suction Header',
    'pipeline',
    'A200',
    v(-26, 1.2, -16.2),
    {
      kind: 'pipeline',
      radius: 0.3,
      paths: [
        [v(-33, 1.2, -17), v(-26, 1.2, -17), v(-26, 1.2, -16.2), v(-13, 1.2, -16.2), v(-13, 1.2, -17.4)],
        [v(-19, 1.2, -16.2), v(-19, 1.2, -17.4)],
        [v(-33, 1.2, -5), v(-29, 1.2, -5), v(-29, 1.2, -17)],
      ],
    },
    { Service: 'Process feed, suction', Size: 'DN 200', Material: 'SS 316L', Length: '34 m' },
    [sig('PRESS', 'Suction pressure', 'pressure', 'bar', [0, 3], 1.08, { limits: { lowAlarm: 0.5, lowWarn: 0.7 } })],
  ),
  asset(
    'PL-110',
    'Discharge Header',
    'pipeline',
    'A200',
    v(-10, 4.2, -19),
    {
      kind: 'pipeline',
      radius: 0.26,
      paths: [
        [v(-19, 2.2, -19), v(-19, 4.2, -19), v(-2.2, 4.2, -19), v(-2.2, 3.3, -19)],
        [v(-13, 2.2, -19), v(-13, 4.2, -19)],
      ],
    },
    { Service: 'Process feed, discharge', Size: 'DN 150', Material: 'SS 316L', Length: '21 m', 'Design pressure': '10 bar' },
    [
      sig('PRESS', 'Discharge pressure', 'pressure', 'bar', [0, 10], 6.2, {
        limits: { lowAlarm: 4.6, lowWarn: 5.4, highWarn: 7.4, highAlarm: 8.2 },
        variability: true,
      }),
      sig('FLOW', 'Feed flow', 'flow', 'm³/h', [0, 160], 120, {
        sp: 'PL-110.FLOW_SP',
        dev: { warn: 0.06, alarm: 0.15 },
        variability: true,
      }),
      sig('FLOW_SP', 'Feed flow demand', 'flow', 'm³/h', [0, 160], 120, { role: 'setpoint' }),
    ],
  ),

  // --- Area 300: process hall
  asset(
    'HX-201',
    'Process Cooler',
    'heat_exchanger',
    'A300',
    v(0, 0, -19),
    { kind: 'heat_exchanger' },
    { Type: 'Shell & tube, 1-2 pass', Duty: '4.6 MW', Area: '182 m²', 'Last cleaned': '2025-06-11', Criticality: 'A' },
    [
      sig('T_OUT', 'Process outlet temperature', 'temperature', '°C', [0, 100], 34.9, {
        limits: { highWarn: 38.5, highAlarm: 42 },
        rate: 4,
      }),
      sig('DP', 'Tube-side differential pressure', 'pressure', 'bar', [0, 3], 1.1, {
        limits: { highWarn: 1.6, highAlarm: 2.0 },
      }),
    ],
  ),
  asset(
    'PL-120',
    'Reactor Feed Line',
    'pipeline',
    'A300',
    v(6, 5, -18),
    {
      kind: 'pipeline',
      radius: 0.24,
      paths: [[v(2.2, 3.3, -19), v(2.2, 5, -19), v(6, 5, -19), v(6, 5, -17), v(9, 5, -17)]],
    },
    { Service: 'Cooled process feed', Size: 'DN 150', Material: 'SS 316L', Length: '12 m' },
    [sig('PRESS', 'Line pressure', 'pressure', 'bar', [0, 10], 4.9, { limits: { lowAlarm: 3.2, lowWarn: 4.0 } })],
  ),
  asset(
    'RX-301',
    'Mixing Reactor',
    'reactor',
    'A300',
    v(12, 0, -17),
    { kind: 'reactor', radius: 3, height: 7 },
    { Type: 'Jacketed, agitated', Volume: '160 m³', Agitator: 'Pitched-blade, 45 rpm', 'Design temp': '90 °C', Criticality: 'A' },
    [
      sig('LEVEL', 'Vessel level', 'level', '%', [0, 100], 62, {
        limits: { lowAlarm: 30, lowWarn: 45, highWarn: 80, highAlarm: 90 },
        rate: 8,
      }),
      sig('TEMP', 'Batch temperature', 'temperature', '°C', [0, 100], 44.4, {
        limits: { highWarn: 47.5, highAlarm: 51 },
        rate: 3,
      }),
    ],
  ),
  asset(
    'M-301',
    'Agitator Motor',
    'motor',
    'A300',
    v(12, 7.9, -17),
    { kind: 'motor', size: 0.9, shaftY: 0, vertical: true },
    { Type: 'Induction, vertical', Rating: '37 kW / 400 V', 'Full-load current': '66 A', Gearbox: 'Helical-bevel 33:1', Criticality: 'A' },
    motorSignals(54, 32, 100),
  ),
  asset(
    'PL-130',
    'Product Transfer Line',
    'pipeline',
    'A300',
    v(12, 3.6, -4),
    {
      kind: 'pipeline',
      radius: 0.22,
      paths: [[v(12, 0.7, -17), v(12, 0.7, -12.5), v(12, 3.6, -12.5), v(12, 3.6, 3), v(10, 3.6, 3), v(10, 3.6, 9.0)]],
    },
    { Service: 'Finished product to filler', Size: 'DN 125', Material: 'SS 316L', Length: '31 m' },
    [
      sig('FLOW', 'Transfer flow', 'flow', 'm³/h', [0, 160], 120),
      sig('PRESS', 'Line pressure', 'pressure', 'bar', [0, 5], 1.94, { limits: { lowAlarm: 1.2, lowWarn: 1.5 } }),
    ],
  ),

  // --- Area 400: packaging line
  asset(
    'FL-310',
    'Rotary Filler',
    'production',
    'A400',
    v(10, 0, 10),
    { kind: 'filler' },
    { Type: '24-valve rotary filler', 'Rated output': '260 units/min', Format: '5 L container', Criticality: 'A' },
    [
      sig('RATE', 'Fill rate', 'rate', 'u/min', [0, 320], 240, { sp: 'FL-310.RATE_SP', dev: { warn: 0.06, alarm: 0.15 } }),
      sig('RATE_SP', 'Fill rate target', 'rate', 'u/min', [0, 320], 240, { role: 'setpoint' }),
      sig('AIR_P', 'Pneumatic supply pressure', 'pressure', 'bar', [0, 10], 6.6, { limits: { lowAlarm: 5.2, lowWarn: 5.8 } }),
      sig('AVAIL', 'Availability (5 min)', 'availability', '%', [0, 100], 100, {
        limits: { lowAlarm: 80, lowWarn: 92 },
        baseline: false,
      }),
    ],
  ),
  asset(
    'CV-320',
    'Transfer Conveyor A',
    'conveyor',
    'A400',
    v(17.5, 0, 10),
    { kind: 'conveyor', length: 10 },
    { Type: 'Modular belt', Length: '10 m', 'Design speed': '0.8 m/s', Criticality: 'B' },
    [
      sig('SPEED', 'Belt speed', 'speed', 'm/s', [0, 1.5], 0.8, { limits: { lowAlarm: 0.6, lowWarn: 0.72 } }),
      sig('VIB', 'Drive vibration (RMS)', 'vibration', 'mm/s', [0, 15], 1.6, { limits: { highWarn: 3.5, highAlarm: 5.5 } }),
    ],
  ),
  asset(
    'M-320',
    'Conveyor A Drive Motor',
    'motor',
    'A400',
    v(17.5, 0, 12.1),
    { kind: 'motor', size: 0.6, shaftY: 1.0 },
    { Type: 'Geared induction', Rating: '15 kW / 400 V', 'Full-load current': '27 A', Criticality: 'B' },
    motorSignals(22, 13, 45),
    Math.PI,
  ),
  asset(
    'PK-330',
    'Case Packer',
    'production',
    'A400',
    v(25.5, 0, 10),
    { kind: 'packer' },
    { Type: 'Wrap-around case packer', 'Rated output': '24 cases/min', Format: '12 units/case', Criticality: 'A' },
    [
      sig('RATE', 'Pack rate', 'rate', 'c/min', [0, 30], 20),
      sig('AVAIL', 'Availability (5 min)', 'availability', '%', [0, 100], 100, {
        limits: { lowAlarm: 80, lowWarn: 92 },
        baseline: false,
      }),
    ],
  ),
  asset(
    'CV-340',
    'Transfer Conveyor B',
    'conveyor',
    'A400',
    v(33, 0, 10),
    { kind: 'conveyor', length: 9.5 },
    { Type: 'Roller, powered', Length: '9.5 m', 'Design speed': '0.8 m/s', Criticality: 'B' },
    [
      sig('SPEED', 'Belt speed', 'speed', 'm/s', [0, 1.5], 0.8, { limits: { lowAlarm: 0.6, lowWarn: 0.72 } }),
      sig('VIB', 'Drive vibration (RMS)', 'vibration', 'mm/s', [0, 15], 1.6, { limits: { highWarn: 3.5, highAlarm: 5.5 } }),
    ],
  ),
  asset(
    'M-340',
    'Conveyor B Drive Motor',
    'motor',
    'A400',
    v(33, 0, 12.1),
    { kind: 'motor', size: 0.6, shaftY: 1.0 },
    { Type: 'Geared induction', Rating: '15 kW / 400 V', 'Full-load current': '27 A', Criticality: 'B' },
    motorSignals(22, 13, 45),
    Math.PI,
  ),
  asset(
    'PZ-350',
    'Palletiser',
    'production',
    'A400',
    v(41, 0, 10),
    { kind: 'palletiser' },
    { Type: 'Layer palletiser, gantry', 'Rated output': '24 pallets/h', Pattern: '60 cases/pallet', Criticality: 'B' },
    [
      sig('RATE', 'Pallet rate', 'rate', 'p/h', [0, 30], 20),
      sig('AVAIL', 'Availability (5 min)', 'availability', '%', [0, 100], 100, {
        limits: { lowAlarm: 80, lowWarn: 92 },
        baseline: false,
      }),
    ],
  ),

  // --- Area 500: cooling plant
  asset(
    'CT-401',
    'Cooling Tower',
    'cooling',
    'A500',
    v(39, 0, -20),
    { kind: 'cooling_tower' },
    { Type: 'Induced-draft, counterflow', Duty: '5.2 MW', Fan: '30 kW axial, 4.2 m', 'Design approach': '6 K', Criticality: 'A' },
    [
      sig('FAN_CURRENT', 'Fan motor current', 'current', 'A', [0, 70], 38, {
        limits: { lowAlarm: 5, lowWarn: 20, highWarn: 46, highAlarm: 52 },
      }),
      sig('BASIN_TEMP', 'Basin water temperature', 'temperature', '°C', [0, 60], 24, {
        limits: { highWarn: 29, highAlarm: 33 },
        rate: 4,
      }),
      sig('FAN_VIB', 'Fan gearbox vibration (RMS)', 'vibration', 'mm/s', [0, 15], 2.4, {
        limits: { highWarn: 5, highAlarm: 8 },
      }),
      STATUS,
    ],
  ),
  asset(
    'P-401',
    'Cooling Water Pump',
    'pump',
    'A500',
    v(30, 0, -20),
    { kind: 'pump' },
    {
      Type: 'Centrifugal, end-suction',
      'Rated duty': '220 m³/h @ 38 m',
      Role: 'Duty',
      Commissioned: 2019,
      'Last service': '2025-08-27',
      Criticality: 'A',
    },
    pumpSignals(2.0, 54),
    Math.PI / 2,
  ),
  asset(
    'M-401',
    'Cooling Water Pump Motor',
    'motor',
    'A500',
    v(26.6, 0, -20),
    { kind: 'motor', size: 0.95, shaftY: 1.2 },
    { Type: 'Induction, IE3', Rating: '45 kW / 400 V', 'Full-load current': '80 A', Speed: '1480 rpm', Criticality: 'A' },
    motorSignals(64, 38, 120),
    Math.PI / 2,
  ),
  asset(
    'CH-402',
    'Trim Chiller',
    'cooling',
    'A500',
    v(30, 0, -10),
    { kind: 'chiller' },
    { Type: 'Water-cooled screw chiller', Capacity: '1.9 MW', Refrigerant: 'R-1234ze', 'Leaving setpoint': '22 °C', Criticality: 'B' },
    [
      sig('COMP_CURRENT', 'Compressor current', 'current', 'A', [0, 200], 69, {
        limits: { highWarn: 138, highAlarm: 148 },
      }),
      sig('LOAD', 'Capacity utilisation', 'load', '%', [0, 100], 25, { limits: { highWarn: 90, highAlarm: 98 } }),
      sig('POWER', 'Electrical power', 'power', 'kW', [0, 120], 41, { baseline: false }),
    ],
  ),
  asset(
    'PL-400',
    'CW Circulation Line',
    'pipeline',
    'A500',
    v(30, 3.8, -17),
    {
      kind: 'pipeline',
      radius: 0.3,
      paths: [
        [v(35.2, 1.2, -20), v(31.6, 1.2, -20)],
        [v(30, 2.2, -20), v(30, 3.8, -20), v(30, 3.8, -14.5), v(31.6, 3.8, -14.5), v(31.6, 1.1, -14.5), v(31.6, 1.1, -11.8)],
      ],
    },
    { Service: 'Cooling water, tower to chiller', Size: 'DN 250', Material: 'Carbon steel', Length: '17 m' },
    [sig('PRESS', 'Pump discharge pressure', 'pressure', 'bar', [0, 6], 3.4, { limits: { lowAlarm: 2.0, lowWarn: 2.6 } })],
  ),
  asset(
    'PL-410',
    'CW Supply Line',
    'pipeline',
    'A500',
    v(13, 6, -12.6),
    {
      kind: 'pipeline',
      radius: 0.28,
      paths: [
        [
          v(28.4, 1.1, -11.8),
          v(28.4, 1.1, -12.6),
          v(24.5, 1.1, -12.6),
          v(24.5, 6, -12.6),
          v(1.5, 6, -12.6),
          v(1.5, 6, -17.3),
          v(1.5, 1.8, -17.3),
        ],
      ],
    },
    { Service: 'Cooling water supply to HX-201', Size: 'DN 250', Material: 'Carbon steel', Length: '41 m' },
    [
      sig('TEMP', 'Supply temperature', 'temperature', '°C', [0, 60], 22, {
        limits: { highWarn: 24.5, highAlarm: 27 },
        rate: 3,
      }),
      sig('FLOW', 'Cooling water flow', 'flow', 'm³/h', [0, 300], 200, { limits: { lowAlarm: 140, lowWarn: 170 } }),
    ],
  ),
  asset(
    'PL-420',
    'CW Return Line',
    'pipeline',
    'A500',
    v(19, 7, -25.5),
    {
      kind: 'pipeline',
      radius: 0.28,
      paths: [
        [
          v(-1.5, 1.8, -20.7),
          v(-1.5, 7, -20.7),
          v(-1.5, 7, -25.5),
          v(39, 7, -25.5),
          v(39, 5.6, -25.5),
          v(39, 5.6, -23.5),
        ],
      ],
    },
    { Service: 'Cooling water return to CT-401', Size: 'DN 250', Material: 'Carbon steel', Length: '53 m' },
    [sig('TEMP', 'Return temperature', 'temperature', '°C', [0, 80], 41.9, { limits: { highWarn: 46, highAlarm: 50 }, rate: 4 })],
  ),

  // --- Area 600: power & utilities
  asset(
    'TX-501',
    'Distribution Transformer',
    'electrical',
    'A600',
    v(-40, 0, 17),
    { kind: 'transformer' },
    { Type: 'Oil-immersed, ONAN', Rating: '1000 kVA, 11 / 0.4 kV', Vector: 'Dyn11', 'Last oil test': '2025-10-21', Criticality: 'A' },
    [
      sig('LOAD', 'Active load', 'power', 'kW', [0, 700], 330, { limits: { highWarn: 520, highAlarm: 600 } }),
      sig('OIL_TEMP', 'Top-oil temperature', 'temperature', '°C', [0, 120], 58, {
        limits: { highWarn: 80, highAlarm: 92 },
        rate: 4,
      }),
      sig('LV_VOLT', 'LV terminal voltage (L-L)', 'voltage', 'V', [300, 440], 399, { limits: VOLT_LIMITS }),
    ],
  ),
  asset(
    'MCC-510',
    'Motor Control Centre A',
    'electrical',
    'A600',
    v(-30, 0, 17),
    { kind: 'switchgear', sections: 6 },
    { Type: 'LV MCC, form 4b', Rating: '800 A / 400 V', Feeds: 'Pump house, cooling plant', Criticality: 'A' },
    boardSignals(322),
  ),
  asset(
    'MCC-520',
    'Motor Control Centre B',
    'electrical',
    'A600',
    v(-21, 0, 17),
    { kind: 'switchgear', sections: 6 },
    { Type: 'LV MCC, form 4b', Rating: '630 A / 400 V', Feeds: 'Process hall, packaging line', Criticality: 'A' },
    boardSignals(246),
  ),
  asset(
    'AC-610',
    'Plant Air Compressor',
    'utility',
    'A600',
    v(-12, 0, 17),
    { kind: 'compressor' },
    { Type: 'Oil-injected rotary screw', Rating: '37 kW, 6.2 m³/min', 'Service hours': 18420, 'Next service': '20,000 h', Criticality: 'B' },
    [
      sig('DISCH_P', 'Discharge pressure', 'pressure', 'bar', [0, 10], 7.0, { limits: { lowAlarm: 5.6, lowWarn: 6.2 } }),
      sig('CURRENT', 'Motor current', 'current', 'A', [0, 110], 61, { limits: { highWarn: 68, highAlarm: 74 } }),
      sig('DISCH_TEMP', 'Discharge temperature', 'temperature', '°C', [0, 140], 78, {
        limits: { highWarn: 95, highAlarm: 105 },
        rate: 6,
      }),
    ],
  ),
];

// ---------------------------------------------------------------- relations ---

let relSeq = 0;
function rel(from: string, to: string, type: RelationType, medium: string, description: string): AssetRelation {
  relSeq += 1;
  return { id: `R${String(relSeq).padStart(3, '0')}`, from, to, type, medium, description };
}

const relations: AssetRelation[] = [
  // process flow
  rel('TK-101', 'PL-100', 'process', 'process fluid', 'Feed tank outlet to suction header'),
  rel('TK-102', 'PL-100', 'process', 'process fluid', 'Reserve tank tie-in (normally isolated)'),
  rel('PL-100', 'P-101', 'process', 'process fluid', 'Suction to feed pump A'),
  rel('PL-100', 'P-102', 'process', 'process fluid', 'Suction to feed pump B'),
  rel('P-101', 'PL-110', 'process', 'process fluid', 'Pump A discharge'),
  rel('P-102', 'PL-110', 'process', 'process fluid', 'Pump B discharge'),
  rel('PL-110', 'HX-201', 'process', 'process fluid', 'Hot feed to process cooler (tube side)'),
  rel('HX-201', 'PL-120', 'process', 'process fluid', 'Cooled feed leaving the cooler'),
  rel('PL-120', 'RX-301', 'process', 'process fluid', 'Reactor feed'),
  rel('RX-301', 'PL-130', 'process', 'process fluid', 'Reactor bottom outlet'),
  rel('PL-130', 'FL-310', 'process', 'process fluid', 'Product supply to filler bowl'),
  rel('FL-310', 'CV-320', 'process', 'product units', 'Filled containers'),
  rel('CV-320', 'PK-330', 'process', 'product units', 'Infeed to case packer'),
  rel('PK-330', 'CV-340', 'process', 'product units', 'Packed cases'),
  rel('CV-340', 'PZ-350', 'process', 'product units', 'Infeed to palletiser'),
  // mechanical drives
  rel('M-101', 'P-101', 'mechanical', 'shaft', 'Direct-coupled drive'),
  rel('M-102', 'P-102', 'mechanical', 'shaft', 'Direct-coupled drive'),
  rel('M-301', 'RX-301', 'mechanical', 'shaft', 'Agitator drive through gearbox'),
  rel('M-320', 'CV-320', 'mechanical', 'shaft', 'Geared belt drive'),
  rel('M-340', 'CV-340', 'mechanical', 'shaft', 'Geared roller drive'),
  rel('M-401', 'P-401', 'mechanical', 'shaft', 'Direct-coupled drive'),
  // cooling circuit
  rel('CT-401', 'P-401', 'cooling', 'cooling water', 'Basin outlet to circulation pump'),
  rel('P-401', 'PL-400', 'cooling', 'cooling water', 'Circulation pump discharge'),
  rel('PL-400', 'CH-402', 'cooling', 'cooling water', 'Tower water to trim chiller'),
  rel('CH-402', 'PL-410', 'cooling', 'cooling water', 'Chilled supply leaving the chiller'),
  rel('PL-410', 'HX-201', 'cooling', 'cooling water', 'Cooling water to process cooler (shell side)'),
  rel('HX-201', 'PL-420', 'cooling', 'cooling water', 'Warm return from process cooler'),
  rel('PL-420', 'CT-401', 'cooling', 'cooling water', 'Return to tower distribution'),
  // electrical supply
  rel('TX-501', 'MCC-510', 'electrical', '400 V supply', 'LV feeder 1'),
  rel('TX-501', 'MCC-520', 'electrical', '400 V supply', 'LV feeder 2'),
  rel('MCC-510', 'M-101', 'electrical', '400 V supply', 'Starter 510-03'),
  rel('MCC-510', 'M-102', 'electrical', '400 V supply', 'Starter 510-04'),
  rel('MCC-510', 'M-401', 'electrical', '400 V supply', 'Starter 510-06'),
  rel('MCC-510', 'CT-401', 'electrical', '400 V supply', 'Tower fan starter 510-08'),
  rel('MCC-510', 'CH-402', 'electrical', '400 V supply', 'Chiller feeder 510-10'),
  rel('MCC-510', 'LS-601', 'electrical', '400 V supply', 'Lube skid feeder 510-12'),
  rel('MCC-520', 'M-301', 'electrical', '400 V supply', 'Starter 520-02'),
  rel('MCC-520', 'M-320', 'electrical', '400 V supply', 'Drive 520-05'),
  rel('MCC-520', 'M-340', 'electrical', '400 V supply', 'Drive 520-06'),
  rel('MCC-520', 'FL-310', 'electrical', '400 V supply', 'Filler feeder 520-08'),
  rel('MCC-520', 'PK-330', 'electrical', '400 V supply', 'Packer feeder 520-09'),
  rel('MCC-520', 'PZ-350', 'electrical', '400 V supply', 'Palletiser feeder 520-10'),
  rel('MCC-520', 'AC-610', 'electrical', '400 V supply', 'Compressor starter 520-12'),
  // utility services
  rel('LS-601', 'P-101', 'utility', 'lube oil', 'Bearing lubrication supply'),
  rel('LS-601', 'P-102', 'utility', 'lube oil', 'Bearing lubrication supply'),
  rel('LS-601', 'P-401', 'utility', 'lube oil', 'Bearing lubrication supply'),
  rel('AC-610', 'FL-310', 'utility', 'compressed air', 'Valve and actuator air'),
  rel('AC-610', 'PK-330', 'utility', 'compressed air', 'Actuator air'),
  rel('AC-610', 'PZ-350', 'utility', 'compressed air', 'Gripper and actuator air'),
];

// ---------------------------------------------------------- composite rules ---

const ratioRules: RatioRuleDefinition[] = [
  {
    id: 'P-101.SPEC_CURRENT',
    assetId: 'P-101',
    name: 'Motor current per unit of delivered flow',
    numeratorSignalId: 'M-101.CURRENT',
    denominatorSignalId: 'PL-110.FLOW',
    enableSignalId: 'P-101.STATUS',
    enableValue: 1,
    warnPct: 10,
    alarmPct: 25,
    explanation: 'The drive is drawing more current for the flow actually delivered than it did at baseline.',
  },
  {
    id: 'P-102.SPEC_CURRENT',
    assetId: 'P-102',
    name: 'Motor current per unit of delivered flow',
    numeratorSignalId: 'M-102.CURRENT',
    denominatorSignalId: 'PL-110.FLOW',
    enableSignalId: 'P-102.STATUS',
    enableValue: 1,
    warnPct: 10,
    alarmPct: 25,
    explanation: 'The drive is drawing more current for the flow actually delivered than it did at baseline.',
  },
];

export const FACILITY: FacilityModel = {
  id: 'meridian-u3',
  name: 'Meridian Works · Unit 3',
  description: 'Liquid-product process and packaging unit (simulated).',
  areas,
  assets,
  relations,
  ratioRules,
  sonarOrigin: v(2, 0, -1),
};

/** Tags whose raw readings arrive in a non-canonical unit (exercises normalisation). */
export const SOURCE_UNIT_OVERRIDES: Record<string, string> = {
  'AC-610.DISCH_P': 'psi',
  'TX-501.OIL_TEMP': 'degF',
};
