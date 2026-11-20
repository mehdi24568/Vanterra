/**
 * Simulated OT security telemetry.
 *
 * Produces what a passive OT network sensor and the controllers' audit logs would
 * record: authentication attempts, summarised flows between hosts, and controller
 * audit entries. It produces observations only. Whether anything is notable is
 * decided by the Cyber Engine in the core, which never sees the scenario list.
 *
 * It has its own random stream, so adding it changes nothing in the physical
 * telemetry. A scenario that writes a controller parameter asks the process model
 * to apply it, through `applyControl` - the only cyber-to-physical path.
 */
import { Rng } from '../core/rng';
import type { ScenarioInfo } from '../core/types';
import type { SecurityRecord } from '../cyber/types';

export const CYBER_SCENARIOS: ScenarioInfo[] = [
  {
    id: 'ot-remote-access',
    name: 'Suspicious remote engineering access',
    kind: 'cyber',
    summary:
      'Repeated failed vendor logons on the jump host, then a remote session to the engineering workstation outside any approved window, a read of the cooling-plant controller, and an enterprise host reaching the HMI directly. No setting is changed.',
    phases: [
      'Four failed logons for vendor.remote on JMP-01',
      'Successful logon, then a remote session to EWS-01',
      'Program read from PLC-500 (no change)',
      'Enterprise host connects to HMI-01 across the zone boundary',
    ],
  },
  {
    id: 'cp-fan-setpoint',
    name: 'Unapproved fan-speed change',
    kind: 'cyber_physical',
    summary:
      'A vendor account reaches the engineering workstation through the jump host outside any approved window and lowers the cooling-tower fan speed setpoint on PLC-500 to 35 %. The process responds to the new setting.',
    phases: [
      'Remote session: jump host to engineering workstation',
      'First-seen engineering connection to PLC-500',
      'Fan speed setpoint written 100 % → 35 % (no matching change record)',
      'Fan current falls, basin temperature and chiller load rise',
    ],
  },
  {
    id: 'cp-approved-tuning',
    name: 'Approved fan-drive tuning',
    kind: 'cyber_physical',
    summary:
      'The controls engineer applies approved change CHG-1042 from the engineering workstation inside its window, lowering the fan speed setpoint to 60 %. The change is authorised; its thermal effect on the process is still real.',
    phases: [
      'Local engineering session on EWS-01 under CHG-1042',
      'Fan speed setpoint written 100 % → 60 % (matches CHG-1042)',
      'Fan current falls and basin temperature rises',
    ],
  },
];

type Step = { at: number; records: (t: number) => SecurityRecord[]; control?: { parameterId: string; value: number } };

const FAN_SP = 'PLC-500:CT401_FAN_SPEED_SP';
const PLCS = ['PLC-200', 'PLC-300', 'PLC-400', 'PLC-500', 'PLC-600'];

const auth = (host: string, identity: string, result: 'success' | 'failure', method: 'local' | 'remote', srcHost: string | null) => (t: number): SecurityRecord[] => [
  { type: 'auth', t, host, identity, result, method, srcHost },
];
const flow = (src: string, dst: string, protocol: string, bytes: number) => (t: number): SecurityRecord[] => [{ type: 'flow', t, src, dst, protocol, bytes }];
const both = (...fs: ((t: number) => SecurityRecord[])[]) => (t: number) => fs.flatMap((f) => f(t));

const SCRIPTS: Record<string, Step[]> = {
  'ot-remote-access': [
    { at: 0, records: auth('JMP-01', 'vendor.remote', 'failure', 'remote', 'ENT-01') },
    { at: 3, records: auth('JMP-01', 'vendor.remote', 'failure', 'remote', 'ENT-01') },
    { at: 6, records: auth('JMP-01', 'vendor.remote', 'failure', 'remote', 'ENT-01') },
    { at: 9, records: auth('JMP-01', 'vendor.remote', 'failure', 'remote', 'ENT-01') },
    { at: 14, records: both(flow('ENT-01', 'JMP-01', 'RDP', 182_000), auth('JMP-01', 'vendor.remote', 'success', 'remote', 'ENT-01')) },
    { at: 22, records: both(flow('JMP-01', 'EWS-01', 'RDP', 240_000), auth('EWS-01', 'vendor.remote', 'success', 'remote', 'JMP-01')) },
    {
      at: 35,
      records: both(flow('EWS-01', 'PLC-500', 'Engineering', 96_000), (t) => [
        { type: 'plc_audit', t, plcId: 'PLC-500', action: 'program_upload', parameterId: null, oldValue: null, newValue: null, identity: 'vendor.remote', srcHost: 'EWS-01' },
      ]),
    },
    { at: 50, records: flow('ENT-01', 'HMI-01', 'VNC', 64_000) },
    {
      at: 80,
      records: (t) => [
        { type: 'logoff', t, host: 'EWS-01', identity: 'vendor.remote' },
        { type: 'logoff', t, host: 'JMP-01', identity: 'vendor.remote' },
      ],
    },
  ],
  'cp-fan-setpoint': [
    { at: 0, records: both(flow('ENT-01', 'JMP-01', 'RDP', 175_000), auth('JMP-01', 'vendor.remote', 'success', 'remote', 'ENT-01')) },
    { at: 8, records: both(flow('JMP-01', 'EWS-01', 'RDP', 228_000), auth('EWS-01', 'vendor.remote', 'success', 'remote', 'JMP-01')) },
    { at: 20, records: flow('EWS-01', 'PLC-500', 'Engineering', 88_000) },
    {
      at: 26,
      records: (t) => [
        { type: 'plc_audit', t, plcId: 'PLC-500', action: 'parameter_write', parameterId: FAN_SP, oldValue: 100, newValue: 35, identity: 'vendor.remote', srcHost: 'EWS-01' },
      ],
      control: { parameterId: FAN_SP, value: 35 },
    },
    {
      at: 70,
      records: (t) => [
        { type: 'logoff', t, host: 'EWS-01', identity: 'vendor.remote' },
        { type: 'logoff', t, host: 'JMP-01', identity: 'vendor.remote' },
      ],
    },
  ],
  'cp-approved-tuning': [
    { at: 0, records: auth('EWS-01', 'eng.controls', 'success', 'local', null) },
    { at: 12, records: flow('EWS-01', 'PLC-500', 'Engineering', 91_000) },
    {
      at: 18,
      records: (t) => [
        { type: 'plc_audit', t, plcId: 'PLC-500', action: 'parameter_write', parameterId: FAN_SP, oldValue: 100, newValue: 60, identity: 'eng.controls', srcHost: 'EWS-01' },
      ],
      control: { parameterId: FAN_SP, value: 60 },
    },
    { at: 60, records: (t) => [{ type: 'logoff', t, host: 'EWS-01', identity: 'eng.controls' }] },
  ],
};

interface Running {
  id: string;
  startedAt: number;
  next: number;
}

export class CyberSimulation {
  private rng: Rng;
  private running: Running[] = [];
  private startMs: number | null = null;
  private lastPoll = -Infinity;
  private shiftLogon = false;

  constructor(
    seed: number,
    private readonly applyControl: (parameterId: string, value: number) => void,
  ) {
    this.rng = new Rng((seed ^ 0x5bd1e995) >>> 0);
  }

  reset(seed: number): void {
    this.rng = new Rng((seed ^ 0x5bd1e995) >>> 0);
    this.running = [];
    this.injected = [];
    this.startMs = null;
    this.lastPoll = -Infinity;
    this.shiftLogon = false;
  }

  get active(): string[] {
    return this.running.map((r) => r.id);
  }

  private injected: SecurityRecord[] = [];

  /**
   * Queue security records for the next step (evaluation scenarios). Their timestamps are
   * set to the step's time, so they flow through the same path as scripted activity.
   */
  inject(records: SecurityRecord[]): void {
    this.injected.push(...records);
  }

  /** A simulated engineering write: the controller's audit record plus its effect on the process. */
  engineeringWrite(write: { plcId: string; parameterId: string; oldValue: number; newValue: number; identity: string; srcHost: string }): void {
    this.injected.push({ type: 'plc_audit', t: 0, plcId: write.plcId, action: 'parameter_write', parameterId: write.parameterId, oldValue: write.oldValue, newValue: write.newValue, identity: write.identity, srcHost: write.srcHost });
    this.applyControl(write.parameterId, write.newValue);
  }

  trigger(id: string, nowMs: number): boolean {
    if (!SCRIPTS[id] || this.running.some((r) => r.id === id)) return false;
    this.running.push({ id, startedAt: nowMs, next: 0 });
    return true;
  }

  /** Records observed up to and including `nowMs`. */
  step(nowMs: number): SecurityRecord[] {
    const out: SecurityRecord[] = this.injected.map((r) => ({ ...r, t: nowMs }));
    this.injected = [];
    if (this.startMs === null) this.startMs = nowMs;
    const elapsedS = (nowMs - this.startMs) / 1000;

    // Normal background activity: shift and service logons, then periodic polling.
    if (!this.shiftLogon && elapsedS >= 5) {
      out.push({ type: 'auth', t: nowMs, host: 'HMI-01', identity: 'op.shift', result: 'success', method: 'local', srcHost: null });
      out.push({ type: 'auth', t: nowMs, host: 'HIST-01', identity: 'svc.historian', result: 'success', method: 'remote', srcHost: 'SCADA-01' });
      this.shiftLogon = true;
    }
    if (nowMs - this.lastPoll >= 5000) {
      this.lastPoll = nowMs;
      const bytes = (nominal: number) => Math.round(nominal * (1 + 0.08 * (this.rng.next() * 2 - 1)));
      for (const plc of PLCS) {
        out.push({ type: 'flow', t: nowMs, src: 'HMI-01', dst: plc, protocol: 'EtherNet/IP', bytes: bytes(12_400) });
        out.push({ type: 'flow', t: nowMs, src: 'SCADA-01', dst: plc, protocol: 'EtherNet/IP', bytes: bytes(21_800) });
      }
      out.push({ type: 'flow', t: nowMs, src: 'SCADA-01', dst: 'HIST-01', protocol: 'OPC UA', bytes: bytes(64_000) });
    }

    // Scripted scenarios.
    for (const run of this.running) {
      const script = SCRIPTS[run.id];
      while (run.next < script.length && nowMs >= run.startedAt + script[run.next].at * 1000) {
        const s = script[run.next];
        out.push(...s.records(nowMs));
        if (s.control) this.applyControl(s.control.parameterId, s.control.value);
        run.next += 1;
      }
    }
    this.running = this.running.filter((r) => r.next < SCRIPTS[r.id].length);
    return out;
  }
}
