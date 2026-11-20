/**
 * Last gate before an AI investigation is shown: the application re-validates the
 * report it received instead of trusting the service that produced it.
 *
 *  - It must be for this incident.
 *  - Every agent output is re-checked against its strict schema, so a field that
 *    does not belong (a disposition, a "confirmed" flag) cannot ride along.
 *  - Every citation is re-checked against the context that was actually sent.
 *  - A report claiming to have confirmed anything is refused outright.
 *
 * Nothing here can change an incident. An accepted report is displayed beside the
 * deterministic assessment; confirming a cause remains an operator action.
 */
import type { Incident } from '../core/types';
import { catalogueOf, evidenceSignature } from './context';
import type { InvestigationContext } from './context';
import { ground } from './grounding';
import type { AgentRun, InvestigationReport } from './report';
import { AGENT_SCHEMAS } from './schemas';
import type { AgentId } from './schemas';

export type AcceptResult = { ok: true; report: InvestigationReport; stale: boolean } | { ok: false; reason: string };

const AGENTS: AgentId[] = ['evidence_analyst', 'impact_analyst', 'hypothesis_analyst', 'investigation_planner', 'orchestrator'];

/** Has the incident gained or lost detections since the report's evidence was collected? */
export function isStale(report: InvestigationReport, incident: Incident): boolean {
  return report.evidenceSignature !== evidenceSignature(incident.anomalyIds);
}

export function acceptReport(incident: Incident, context: InvestigationContext, candidate: unknown): AcceptResult {
  if (!candidate || typeof candidate !== 'object') return { ok: false, reason: 'Report is not an object' };
  const report = candidate as InvestigationReport;
  if (report.schemaVersion !== 1) return { ok: false, reason: 'Unsupported report version' };
  if (report.incidentId !== incident.id || report.incidentId !== context.incident.id) return { ok: false, reason: 'Report belongs to a different incident' };
  if (!report.governance || (report.governance as { confirmedByAi: unknown }).confirmedByAi !== false) {
    return { ok: false, reason: 'Report claims an AI confirmation, which is not permitted' };
  }
  if (!report.agents || typeof report.agents !== 'object') return { ok: false, reason: 'Report has no agent results' };

  const catalogue = catalogueOf(context);
  const agents = { ...report.agents } as Record<AgentId, AgentRun>;
  for (const id of AGENTS) {
    const run = agents[id];
    if (!run) return { ok: false, reason: `Report is missing ${id}` };
    if (run.output === null) continue;
    const parsed = AGENT_SCHEMAS[id].safeParse(run.output);
    if (!parsed.success) return { ok: false, reason: `${id} output does not match its schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
    const checked = ground(parsed.data, catalogue, context, 'sanitise');
    if (checked.output === null) return { ok: false, reason: `${id} output asserts certainty and was refused` };
    agents[id] = { ...run, output: checked.output, cited: checked.cited } as AgentRun;
  }
  return { ok: true, report: { ...report, agents: agents as InvestigationReport['agents'] }, stale: isStale(report, incident) };
}
