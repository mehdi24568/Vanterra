/**
 * Cyber Engine - detection over OT security telemetry.
 *
 * Five rules turn raw records (logons, flows, controller audit entries) into cyber
 * events. An event records the rule, the record fields that satisfied it, why that is
 * notable, and what it does not show. Events with a shared identity or device are
 * grouped into cases. Nothing here decides that an event caused anything physical:
 * that question belongs to the cyber-physical assessment, which needs evidence.
 *
 *   AUTH-BURST        3+ failed logons for one account on one host within 60 s
 *   ENG-SESSION       a logon on an engineering workstation with no approved change window
 *   CONDUIT           a flow between zones that no conduit permits
 *   FIRST-SEEN        a permitted flow never seen during the learning period
 *   UNAPPROVED-CHANGE a controller write that matches no approved change record
 *
 * Approved changes and controller reads are recorded as informational events, so the
 * investigation can cite them.
 */
import type { Severity } from '../core/types';
import { SEVERITY_RANK } from '../core/types';
import { ATTACK, ATTACK_CAVEAT } from './attack';
import type { AttackContext, ChangeRecord, CyberCase, CyberEvent, OtDevice, OtModel, SecurityRecord } from './types';

export interface CyberEngineConfig {
  /** Flows seen in this many seconds after the stream starts are the communication baseline. */
  learnS: number;
  authBurstCount: number;
  authBurstWindowS: number;
  /** Same rule on the same subject is reported once per this many seconds. */
  dedupeS: number;
  /** Events this close (s) with a shared identity or device join the same case. */
  caseWindowS: number;
}

export const DEFAULT_CYBER: CyberEngineConfig = { learnS: 60, authBurstCount: 3, authBurstWindowS: 60, dedupeS: 600, caseWindowS: 900 };

export type CyberNotice = { type: 'event'; event: CyberEvent } | { type: 'case_opened'; case: CyberCase } | { type: 'case_updated'; case: CyberCase };

type Draft = Omit<CyberEvent, 'id' | 'caseId'>;

const sevRank = (s: Severity | 'info') => (s === 'info' ? 0 : SEVERITY_RANK[s]);

export class CyberEngine {
  readonly events: CyberEvent[] = [];
  readonly cases: CyberCase[] = [];
  private notices: CyberNotice[] = [];
  private seq = 0;
  private caseSeq = 0;
  private devices = new Map<string, OtDevice>();
  private learnUntil: number | null = null;
  private knownFlows = new Set<string>();
  private failures = new Map<string, number[]>();
  private lastFired = new Map<string, number>();
  /** host|identity -> session start and origin. */
  readonly sessions = new Map<string, { start: number; srcHost: string | null; end: number | null }>();

  constructor(
    readonly model: OtModel,
    private readonly config: CyberEngineConfig = DEFAULT_CYBER,
  ) {
    for (const d of model.devices) this.devices.set(d.id, d);
  }

  device(id: string): OtDevice | undefined {
    return this.devices.get(id);
  }

  event(id: string): CyberEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  caseOf(id: string): CyberCase | undefined {
    return this.cases.find((c) => c.id === id);
  }

  /** Physical assets a controller controls or monitors, from the declared model only. */
  controlledBy(plcId: string, kind?: 'controls' | 'monitors'): string[] {
    return this.model.controls.filter((c) => c.plcId === plcId && (!kind || c.kind === kind)).map((c) => c.assetId);
  }

  controllersOf(assetId: string): string[] {
    return this.model.controls.filter((c) => c.assetId === assetId && c.kind === 'controls').map((c) => c.plcId);
  }

  drain(): CyberNotice[] {
    const n = this.notices;
    this.notices = [];
    return n;
  }

  ingest(records: SecurityRecord[]): void {
    for (const r of records) {
      if (this.learnUntil === null) this.learnUntil = r.t + this.config.learnS * 1000;
      switch (r.type) {
        case 'auth':
          this.onAuth(r);
          break;
        case 'logoff': {
          const s = this.sessions.get(`${r.host}|${r.identity}`);
          if (s) s.end = r.t;
          break;
        }
        case 'flow':
          this.onFlow(r);
          break;
        case 'plc_audit':
          this.onAudit(r);
          break;
      }
    }
  }

  // ---------------------------------------------------------------- rules

  private onAuth(r: Extract<SecurityRecord, { type: 'auth' }>): void {
    const key = `${r.identity}|${r.host}`;
    if (r.result === 'failure') {
      const list = (this.failures.get(key) ?? []).filter((t) => t >= r.t - this.config.authBurstWindowS * 1000);
      list.push(r.t);
      this.failures.set(key, list);
      if (list.length >= this.config.authBurstCount && this.fresh(`AUTH-BURST|${key}`, r.t)) {
        this.emit({
          t: r.t,
          ruleId: 'AUTH-BURST',
          category: 'authentication',
          severity: 'warning',
          title: `${list.length} failed logons for ${r.identity} on ${r.host}`,
          description: `${list.length} failed logons for ${r.identity} on ${r.host} within ${this.config.authBurstWindowS} s${r.srcHost ? `, from ${r.srcHost}` : ''}.`,
          source: r.srcHost,
          destination: r.host,
          identity: r.identity,
          deviceIds: this.known([r.srcHost, r.host]),
          parameterId: null,
          changeRecordId: null,
          evidence: { identity: r.identity, host: r.host, srcHost: r.srcHost, failures: list.length, windowS: this.config.authBurstWindowS },
          rationale: `Rule AUTH-BURST: ${this.config.authBurstCount} or more failed logons for one account on one host within ${this.config.authBurstWindowS} s.`,
          limitations: [
            'Failed logons also come from expired passwords and typing errors; this does not show intent.',
            'No ATT&CK for ICS technique is assigned: the ICS matrix has no technique for password guessing.',
          ],
          attack: [],
        });
      }
      return;
    }
    this.sessions.set(`${r.host}|${r.identity}`, { start: r.t, srcHost: r.srcHost, end: null });
    const host = this.devices.get(r.host);
    if (host?.kind !== 'ews') return;
    const covering = this.model.changeRecords.filter((c) => c.identity === r.identity && c.sourceHost === r.host && r.t >= c.windowStart && r.t <= c.windowEnd);
    if (covering.length > 0 || !this.fresh(`ENG-SESSION|${key}`, r.t)) return;
    const remote = r.method === 'remote';
    this.emit({
      t: r.t,
      ruleId: 'ENG-SESSION',
      category: remote ? 'remote_access' : 'authentication',
      severity: remote ? 'warning' : 'advisory',
      title: `${remote ? 'Remote engineering session' : 'Engineering session'} on ${r.host} outside an approved window`,
      description: `${r.identity} logged on to ${r.host}${remote && r.srcHost ? ` remotely from ${r.srcHost}` : ' locally'}. No approved change record covers this account on this host at this time.`,
      source: r.srcHost,
      destination: r.host,
      identity: r.identity,
      deviceIds: this.known([r.srcHost, r.host]),
      parameterId: null,
      changeRecordId: null,
      evidence: { identity: r.identity, host: r.host, srcHost: r.srcHost, method: r.method, approvedWindows: 0 },
      rationale: 'Rule ENG-SESSION: the engineering workstation is the host that can change controller configuration; sessions on it are expected only inside an approved change window.',
      limitations: [
        'Change records can be incomplete; an unrecorded but legitimate session looks the same.',
        'The account name does not establish who was using it.',
      ],
      attack: remote ? [ATTACK.T0859, ATTACK.T0886] : [ATTACK.T0859],
    });
  }

  private onFlow(r: Extract<SecurityRecord, { type: 'flow' }>): void {
    const pair = `${r.src}>${r.dst}|${r.protocol}`;
    const learning = this.learnUntil !== null && r.t <= this.learnUntil;
    const src = this.devices.get(r.src);
    const dst = this.devices.get(r.dst);
    if (!src || !dst) return;
    const crossZone = src.zoneId !== dst.zoneId;
    const permitted = !crossZone || this.model.conduits.some((c) => c.fromZone === src.zoneId && c.toZone === dst.zoneId && c.protocols.includes(r.protocol));
    if (learning) {
      if (permitted) this.knownFlows.add(pair);
      return;
    }
    if (!permitted) {
      if (!this.fresh(`CONDUIT|${pair}`, r.t)) return;
      const toControl = dst.zoneId === 'Z-CTL';
      const fromEnterprise = this.model.zones.find((z) => z.id === src.zoneId)?.level === 'L4';
      this.emit({
        t: r.t,
        ruleId: 'CONDUIT',
        category: 'network',
        severity: toControl ? 'critical' : 'warning',
        title: `${r.protocol} from ${r.src} to ${r.dst} crosses ${this.zoneName(src.zoneId)} → ${this.zoneName(dst.zoneId)} without a conduit`,
        description: `A ${r.protocol} flow from ${r.src} (${this.zoneName(src.zoneId)}) to ${r.dst} (${this.zoneName(dst.zoneId)}). The segmentation policy has no conduit for this path.`,
        source: r.src,
        destination: r.dst,
        identity: null,
        deviceIds: [r.src, r.dst],
        parameterId: null,
        changeRecordId: null,
        evidence: { src: r.src, dst: r.dst, protocol: r.protocol, bytes: r.bytes, srcZone: src.zoneId, dstZone: dst.zoneId },
        rationale: 'Rule CONDUIT: traffic between zones must follow a declared conduit and protocol.',
        limitations: ['A flow summary shows that hosts communicated, not what was exchanged.', 'A misconfigured but legitimate tool produces the same flow.'],
        attack: fromEnterprise ? [ATTACK.T0822] : [ATTACK.T0886],
      });
      return;
    }
    if (this.knownFlows.has(pair)) return;
    const covered = this.model.changeRecords.some((c) => c.sourceHost === r.src && c.plcId === r.dst && r.t >= c.windowStart && r.t <= c.windowEnd && this.sessionActive(c.sourceHost, c.identity, r.t));
    if (!covered && this.fresh(`FIRST-SEEN|${pair}`, r.t)) {
      this.emit({
        t: r.t,
        ruleId: 'FIRST-SEEN',
        category: 'network',
        severity: 'advisory',
        title: `First-seen ${r.protocol} connection ${r.src} → ${r.dst}`,
        description: `${r.src} opened a ${r.protocol} connection to ${r.dst}. The path is permitted, but this pair was not seen while the communication baseline was learned.`,
        source: r.src,
        destination: r.dst,
        identity: null,
        deviceIds: [r.src, r.dst],
        parameterId: null,
        changeRecordId: null,
        evidence: { src: r.src, dst: r.dst, protocol: r.protocol, bytes: r.bytes },
        rationale: 'Rule FIRST-SEEN: OT traffic is highly repetitive, so a new host pair is worth a look.',
        limitations: ['New connections are normal after maintenance; first-seen does not mean unauthorised.', `The baseline is only ${this.config.learnS} s of traffic.`],
        attack: [],
      });
    }
    this.knownFlows.add(pair);
  }

  private onAudit(r: Extract<SecurityRecord, { type: 'plc_audit' }>): void {
    const param = r.parameterId ? this.model.parameters.find((p) => p.id === r.parameterId) : undefined;
    if (r.action === 'program_upload') {
      this.emit({
        t: r.t,
        ruleId: 'CONTROLLER-READ',
        category: 'controller_access',
        severity: 'info',
        title: `Program read from ${r.plcId} by ${r.identity}`,
        description: `${r.identity} read the program from ${r.plcId} via ${r.srcHost}. No configuration was changed.`,
        source: r.srcHost,
        destination: r.plcId,
        identity: r.identity,
        deviceIds: [r.srcHost, r.plcId],
        parameterId: null,
        changeRecordId: null,
        evidence: { plc: r.plcId, action: r.action, identity: r.identity, srcHost: r.srcHost },
        rationale: 'Recorded for context: controller reads are routine during maintenance and are also how configuration is studied.',
        limitations: ['A read changes nothing on the controller.'],
        attack: [ATTACK.T0845],
      });
      return;
    }
    const match = this.matchChange(r);
    const technique: AttackContext = r.action === 'parameter_write' ? ATTACK.T0836 : r.action === 'program_download' ? ATTACK.T0843 : ATTACK.T0858;
    const what = r.action === 'parameter_write' && param ? `${param.name} ${r.oldValue ?? '?'} → ${r.newValue ?? '?'} ${param.unit}` : r.action.replace('_', ' ');
    const evidence = {
      plc: r.plcId,
      action: r.action,
      parameter: r.parameterId,
      oldValue: r.oldValue,
      newValue: r.newValue,
      identity: r.identity,
      srcHost: r.srcHost,
    };
    if (match.record) {
      this.emit({
        t: r.t,
        ruleId: 'APPROVED-CHANGE',
        category: 'configuration_change',
        severity: 'info',
        title: `Approved change ${match.record.id} applied on ${r.plcId}: ${what}`,
        description: `${r.identity} changed ${r.plcId} from ${r.srcHost}. It matches ${match.record.id} (${match.record.title}): account, host, parameter, window and value range.`,
        source: r.srcHost,
        destination: r.plcId,
        identity: r.identity,
        deviceIds: [r.srcHost, r.plcId],
        parameterId: r.parameterId,
        changeRecordId: match.record.id,
        evidence: { ...evidence, changeRecord: match.record.id },
        rationale: 'Recorded for context: an authorised change can still have physical effects worth investigating.',
        limitations: ['Approval establishes that the change was planned, not that its effect was intended.'],
        attack: [],
      });
      return;
    }
    this.emit({
      t: r.t,
      ruleId: 'UNAPPROVED-CHANGE',
      category: 'configuration_change',
      severity: r.action === 'parameter_write' ? 'warning' : 'critical',
      title: `Unapproved ${r.action === 'parameter_write' ? 'setting change' : r.action.replace('_', ' ')} on ${r.plcId}: ${what}`,
      description: `${r.identity} changed ${r.plcId} from ${r.srcHost}. ${match.reason}`,
      source: r.srcHost,
      destination: r.plcId,
      identity: r.identity,
      deviceIds: [r.srcHost, r.plcId],
      parameterId: r.parameterId,
      changeRecordId: null,
      evidence: { ...evidence, mismatch: match.reason },
      rationale: 'Rule UNAPPROVED-CHANGE: controller configuration should change only under an approved change record matching account, host, parameter, window and value.',
      limitations: [
        'The record shows the change was made, not why. Change records can be filed late.',
        param && param.expectedSignals.length > 0
          ? `Whether it affected the process is a separate question, answered from ${param.affects.join(', ')} telemetry.`
          : 'This parameter has no modelled physical effect in this simulation.',
      ],
      attack: [technique],
    });
  }

  private matchChange(r: Extract<SecurityRecord, { type: 'plc_audit' }>): { record: ChangeRecord | null; reason: string } {
    const forPlc = this.model.changeRecords.filter((c) => c.plcId === r.plcId && (!r.parameterId || c.parameterIds.includes(r.parameterId)));
    if (forPlc.length === 0) return { record: null, reason: 'No change record exists for this controller and parameter.' };
    for (const c of forPlc) {
      const inWindow = r.t >= c.windowStart && r.t <= c.windowEnd;
      const inRange = !c.allowedRange || (r.newValue !== null && r.newValue >= c.allowedRange[0] && r.newValue <= c.allowedRange[1]);
      if (c.identity === r.identity && c.sourceHost === r.srcHost && inWindow && inRange) return { record: c, reason: '' };
    }
    const c = forPlc[0];
    const problems = [
      c.identity !== r.identity ? `account ${r.identity} is not ${c.identity}` : null,
      c.sourceHost !== r.srcHost ? `host ${r.srcHost} is not ${c.sourceHost}` : null,
      r.t < c.windowStart || r.t > c.windowEnd ? 'outside the approved window' : null,
      c.allowedRange && (r.newValue === null || r.newValue < c.allowedRange[0] || r.newValue > c.allowedRange[1])
        ? `value ${r.newValue} is outside the approved range ${c.allowedRange[0]}–${c.allowedRange[1]}`
        : null,
    ].filter(Boolean);
    return { record: null, reason: `Closest record ${c.id} does not match: ${problems.join('; ')}.` };
  }

  // ---------------------------------------------------------------- helpers

  private sessionActive(host: string, identity: string, t: number): boolean {
    const s = this.sessions.get(`${host}|${identity}`);
    return !!s && s.start <= t && (s.end === null || s.end >= t);
  }

  private fresh(key: string, t: number): boolean {
    const last = this.lastFired.get(key);
    if (last !== undefined && t - last < this.config.dedupeS * 1000) return false;
    this.lastFired.set(key, t);
    return true;
  }

  private known(ids: (string | null)[]): string[] {
    return [...new Set(ids.filter((x): x is string => !!x && this.devices.has(x)))];
  }

  private zoneName(id: string): string {
    return this.model.zones.find((z) => z.id === id)?.name ?? id;
  }

  private emit(d: Draft): void {
    this.seq += 1;
    const event: CyberEvent = {
      ...d,
      id: `CEV-${String(this.seq).padStart(4, '0')}`,
      caseId: null,
      limitations: d.attack.length > 0 ? [...d.limitations, ATTACK_CAVEAT] : d.limitations,
    };
    this.events.push(event);
    this.assignCase(event);
    this.notices.push({ type: 'event', event });
  }

  /** Group by shared identity or device (switches and the firewall excluded) within the case window. */
  private assignCase(e: CyberEvent): void {
    const subjects = new Set([...(e.identity ? [e.identity] : []), ...e.deviceIds]);
    const open = this.cases.find((c) => e.t - c.lastEventAt <= this.config.caseWindowS * 1000 && (c.identities.some((x) => subjects.has(x)) || c.deviceIds.some((x) => subjects.has(x))));
    if (open) {
      open.eventIds.push(e.id);
      open.lastEventAt = e.t;
      if (e.severity !== 'info' && sevRank(e.severity) > sevRank(open.severity)) open.severity = e.severity;
      for (const d of e.deviceIds) if (!open.deviceIds.includes(d)) open.deviceIds.push(d);
      if (e.identity && !open.identities.includes(e.identity)) open.identities.push(e.identity);
      e.caseId = open.id;
      this.notices.push({ type: 'case_updated', case: open });
      return;
    }
    // Informational records and lone advisories are kept as events; they open no case.
    if (sevRank(e.severity) < sevRank('warning')) return;
    this.caseSeq += 1;
    const c: CyberCase = {
      id: `CYB-${String(this.caseSeq).padStart(4, '0')}`,
      openedAt: e.t,
      lastEventAt: e.t,
      severity: e.severity as Severity,
      title: e.title,
      eventIds: [e.id],
      deviceIds: [...e.deviceIds],
      identities: e.identity ? [e.identity] : [],
    };
    this.cases.push(c);
    e.caseId = c.id;
    this.notices.push({ type: 'case_opened', case: c });
  }
}
