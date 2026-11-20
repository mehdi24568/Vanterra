/**
 * MITRE ATT&CK for ICS: defensive context for detected events.
 *
 * Source: https://attack.mitre.org (ATT&CK content v20.1). Each ID, name and tactic
 * below was checked against its technique page on attack.mitre.org on 2026-11-20.
 *
 * Scope and meaning: a mapping says what *kind* of activity an event resembles, so an
 * investigator can look up how that activity is usually examined. It never states
 * that an adversary performed the technique; legitimate engineering work produces
 * the same observations.
 */
import type { AttackContext } from './types';

export const ATTACK_SOURCE = 'MITRE ATT&CK for ICS, content v20.1 (attack.mitre.org)';

export const ATTACK: Record<string, AttackContext> = {
  T0859: { techniqueId: 'T0859', name: 'Valid Accounts', tactic: 'Persistence, Lateral Movement' },
  T0886: { techniqueId: 'T0886', name: 'Remote Services', tactic: 'Initial Access, Lateral Movement' },
  T0822: { techniqueId: 'T0822', name: 'External Remote Services', tactic: 'Initial Access' },
  T0836: { techniqueId: 'T0836', name: 'Modify Parameter', tactic: 'Impair Process Control' },
  T0843: { techniqueId: 'T0843', name: 'Program Download', tactic: 'Lateral Movement' },
  T0858: { techniqueId: 'T0858', name: 'Change Operating Mode', tactic: 'Execution, Evasion' },
  T0845: { techniqueId: 'T0845', name: 'Program Upload', tactic: 'Collection' },
};

export const ATTACK_CAVEAT =
  'Context only: the technique describes what this kind of activity can represent. It does not establish that an adversary carried it out; authorised engineering work produces the same records.';
