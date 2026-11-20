/**
 * Cyber layer: the operational-technology (OT) model and security events.
 *
 * Every relationship between the cyber and physical worlds is declared here as
 * data - which controller controls which machine, which parameter affects which
 * signals, which zones may talk to which. Nothing in the investigation engine
 * infers a link that is not in this model or in an observed record.
 */
import type { Severity } from '../core/types';

// ---------------------------------------------------------------- the OT model

export type ZoneLevel = 'L1' | 'L2' | 'L3' | 'DMZ' | 'L4';

export interface NetworkZone {
  id: string;
  name: string;
  level: ZoneLevel;
  /** Simulated address range, for display only. */
  subnet: string;
  description: string;
}

export type OtDeviceKind = 'plc' | 'hmi' | 'scada' | 'ews' | 'historian' | 'jump_host' | 'switch' | 'firewall' | 'enterprise';

export interface OtDevice {
  id: string;
  name: string;
  kind: OtDeviceKind;
  zoneId: string;
  /** Simulated address. Not a real host. */
  address: string;
  /** Physical area the device is installed in (for the spatial view), if any. */
  areaId: string | null;
  position: { x: number; y: number; z: number } | null;
  vendorModel: string;
  description: string;
}

/** A controller output or setting that can be written from an engineering tool. */
export interface ControlParameter {
  id: string;
  plcId: string;
  name: string;
  unit: string;
  nominal: number;
  /** Physical assets this parameter acts on. Explicit; never inferred. */
  affects: string[];
  /** Signals expected to move if this parameter is changed, with the expected direction for a decrease. */
  expectedSignals: { signalId: string; whenDecreased: 'low' | 'high' }[];
  description: string;
}

/** Explicit cyber-physical relationship. */
export interface ControlRelation {
  plcId: string;
  assetId: string;
  kind: 'controls' | 'monitors';
}

/** An allowed communication path between zones (or specific devices). Anything else is a violation. */
export interface Conduit {
  id: string;
  fromZone: string;
  toZone: string;
  protocols: string[];
  description: string;
}

export interface Identity {
  id: string;
  role: 'operator' | 'controls_engineer' | 'vendor_support' | 'service';
  description: string;
  /** Hosts this identity normally uses. */
  usualHosts: string[];
}

export interface ChangeRecord {
  id: string;
  title: string;
  plcId: string;
  parameterIds: string[];
  identity: string;
  sourceHost: string;
  /** Approved window, plant time (epoch ms). */
  windowStart: number;
  windowEnd: number;
  /** Approved range for the new value, if the change is a parameter write. */
  allowedRange: [number, number] | null;
  approvedBy: string;
}

export interface OtModel {
  zones: NetworkZone[];
  devices: OtDevice[];
  links: { from: string; to: string }[];
  conduits: Conduit[];
  controls: ControlRelation[];
  parameters: ControlParameter[];
  identities: Identity[];
  changeRecords: ChangeRecord[];
}

// --------------------------------------------------------- raw security records

/**
 * What a simulated OT security sensor and the controllers' audit logs would record.
 * These are observations, not detections: the Cyber Engine decides what is notable.
 */
export type SecurityRecord =
  | { type: 'auth'; t: number; host: string; identity: string; result: 'success' | 'failure'; method: 'local' | 'remote'; srcHost: string | null }
  | { type: 'logoff'; t: number; host: string; identity: string }
  | { type: 'flow'; t: number; src: string; dst: string; protocol: string; bytes: number }
  | {
      type: 'plc_audit';
      t: number;
      plcId: string;
      action: 'parameter_write' | 'program_upload' | 'program_download' | 'mode_change';
      parameterId: string | null;
      oldValue: number | null;
      newValue: number | null;
      identity: string;
      srcHost: string;
    };

// --------------------------------------------------------------- cyber events

export type CyberEventCategory = 'authentication' | 'remote_access' | 'network' | 'configuration_change' | 'controller_access';

export interface AttackContext {
  techniqueId: string;
  name: string;
  tactic: string;
}

/** A detection by the Cyber Engine: an observation that satisfied a rule. Not an incident. */
export interface CyberEvent {
  id: string;
  t: number;
  ruleId: string;
  category: CyberEventCategory;
  severity: Severity | 'info';
  title: string;
  description: string;
  source: string | null;
  destination: string | null;
  identity: string | null;
  /** OT devices involved (source, destination, controller). */
  deviceIds: string[];
  parameterId: string | null;
  /** Approved change record this event matched, if any. */
  changeRecordId: string | null;
  /** The raw record fields that satisfied the rule. */
  evidence: Record<string, string | number | null>;
  rationale: string;
  limitations: string[];
  /** Defensive context only: what this kind of activity can represent. Never proof. */
  attack: AttackContext[];
  caseId: string | null;
}

export interface CyberCase {
  id: string;
  openedAt: number;
  lastEventAt: number;
  severity: Severity;
  title: string;
  eventIds: string[];
  deviceIds: string[];
  identities: string[];
}
