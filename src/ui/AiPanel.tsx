/**
 * AI investigation panel.
 *
 * Shows what each agent was asked, what it found and what it cited - findings and
 * evidence, never a reasoning trace. Everything here is labelled as AI output and
 * sits beside the deterministic assessment; none of it can change an incident.
 */
import type { ReactNode } from 'react';
import { AGENT_INFO, AGENT_ORDER } from '../agents/agents';
import { catalogueOf, evidenceKind } from '../agents/context';
import type { EvidenceCatalogue } from '../agents/context';
import type { GroundingIssue } from '../agents/grounding';
import type { AgentRun, InvestigationReport } from '../agents/report';
import type { AgentId, Claim } from '../agents/schemas';
import type { Incident } from '../core/types';
import type { AgentProgress, AiRun } from '../runtime/AiService';
import { useRuntime, useUi } from './context';
import { Section } from './primitives';

const STATUS_LABEL: Record<AgentProgress['status'], string> = {
  pending: 'Queued',
  running: 'Working',
  completed: 'Done',
  degraded: 'Done, claims removed',
  failed: 'Failed',
  skipped: 'Not needed',
};

const STANDING_LABEL = {
  evidence_consistent: 'Evidence is consistent with one explanation',
  competing_explanations: 'Competing explanations remain',
  insufficient_evidence: 'Evidence is insufficient',
} as const;

const STANCE_LABEL = { supported: 'Supported', contested: 'Contested', unsupported: 'Unsupported' } as const;

function useEvidenceNav(catalogue: EvidenceCatalogue | null) {
  const runtime = useRuntime();
  return (id: string) => {
    if (!catalogue) return;
    const kind = evidenceKind(id, catalogue);
    if (kind === 'anomaly') {
      const a = runtime.core.intelligence.anomaly(id);
      if (a) runtime.selectAsset(a.assetId, a.signalId, { fly: true, panel: false });
    } else if (kind === 'signal') runtime.selectAsset(id.slice(0, id.indexOf('.')), id, { fly: true, panel: false });
    else if (kind === 'asset') runtime.selectAsset(id, null, { fly: true, panel: false });
    else if (kind === 'hypothesis') runtime.setInvestigationTab('hypotheses');
  };
}

function Evidence({ ids, catalogue }: { ids: string[]; catalogue: EvidenceCatalogue | null }) {
  const go = useEvidenceNav(catalogue);
  if (ids.length === 0) return null;
  return (
    <span className="ai-evidence">
      {ids.slice(0, 8).map((id) => (
        <button key={id} type="button" className={`signal-chip signal-chip--${catalogue ? (evidenceKind(id, catalogue) ?? 'unknown') : 'unknown'}`} onClick={() => go(id)} title="Show this evidence">
          {id}
        </button>
      ))}
    </span>
  );
}

function ClaimRow({ claim, catalogue }: { claim: Claim; catalogue: EvidenceCatalogue | null }) {
  return (
    <li className={`ai-claim ai-claim--${claim.basis}`}>
      <span className={`epi epi--${claim.basis === 'observation' ? 'observed' : 'inference'}`}>{claim.basis === 'observation' ? 'Observation' : 'Inference'}</span>
      <span className="ai-claim__text">{claim.statement}</span>
      <Evidence ids={claim.evidence} catalogue={catalogue} />
    </li>
  );
}

function Block({ title, children, empty }: { title: string; children: ReactNode; empty?: boolean }) {
  if (empty) return null;
  return (
    <div className="ai-block">
      <h5 className="subhead">{title}</h5>
      {children}
    </div>
  );
}

function AgentRow({ id, progress, run }: { id: AgentId; progress: AgentProgress; run: AgentRun | null }) {
  const info = AGENT_INFO[id];
  const tokens = run ? run.usage.inputTokens + run.usage.outputTokens : 0;
  const reason = run?.skippedReason ?? run?.error?.message ?? null;
  return (
    <li className={`agent agent--${progress.status}`}>
      <span className="agent__dot" aria-hidden="true" />
      <div className="agent__body">
        <span className="agent__title">{info.title}</span>
        <span className="agent__role">{info.responsibility}</span>
        {reason ? <span className="agent__note">{reason}</span> : null}
      </div>
      <div className="agent__meta">
        <span className={`agent__status agent__status--${progress.status}`}>{STATUS_LABEL[progress.status]}</span>
        <span className="agent__numbers">
          {progress.latencyMs > 0 ? `${(progress.latencyMs / 1000).toFixed(1)} s` : ''}
          {progress.attempt > 1 ? ` · ${progress.attempt} calls` : ''}
          {tokens > 0 ? ` · ${tokens.toLocaleString('en-US')} tok` : ''}
        </span>
      </div>
    </li>
  );
}

function Issues({ issues }: { issues: Array<GroundingIssue & { agent: AgentId }> }) {
  if (issues.length === 0) return <p className="muted">No claim was rejected or flagged.</p>;
  return (
    <ul className="ai-issues">
      {issues.slice(0, 12).map((i, n) => (
        <li key={n} className={`ai-issue ai-issue--${i.action}`}>
          <span className="ai-issue__action">{i.action === 'rejected' ? 'Removed' : 'Flagged'}</span>
          <span className="ai-issue__text">
            {AGENT_INFO[i.agent].title}: {i.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Findings({ report, incident, catalogue }: { report: InvestigationReport; incident: Incident; catalogue: EvidenceCatalogue }) {
  const runtime = useRuntime();
  const a = report.agents;
  const orch = a.orchestrator.output;
  const ev = a.evidence_analyst.output;
  const hyp = a.hypothesis_analyst.output;
  const imp = a.impact_analyst.output;
  const plan = a.investigation_planner.output;
  const title = (key: string | null) => incident.hypotheses.find((h) => h.key === key)?.title ?? key ?? 'None';
  const issues = AGENT_ORDER.flatMap((id) => a[id].issues.map((i) => ({ ...i, agent: id })));
  const g = report.governance;

  return (
    <>
      {orch ? (
        <Section
          title={
            <>
              Final assessment <span className="epi epi--ai">AI</span>
            </>
          }
          aside={<span className="muted">{AGENT_INFO.orchestrator.title}</span>}
        >
          <p className="ai-standing">{STANDING_LABEL[orch.standing]}</p>
          <p className="ai-conclusion">{orch.conclusion.statement}</p>
          <Evidence ids={orch.conclusion.evidence} catalogue={catalogue} />
          <Block title="Key findings" empty={orch.keyFindings.length === 0}>
            <ul className="ai-claims">
              {orch.keyFindings.map((c, i) => (
                <ClaimRow key={i} claim={c} catalogue={catalogue} />
              ))}
            </ul>
          </Block>
          <Block title="What a person must verify">
            <p className="ai-verify">{orch.humanVerification}</p>
          </Block>
          <Block title="Limits of this assessment" empty={orch.limitations.length === 0}>
            <ul className="plain">
              {orch.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </Block>
        </Section>
      ) : (
        <Section title="Final assessment">
          <p className="notice">The orchestrator produced no usable conclusion ({a.orchestrator.error?.message ?? 'not run'}). The specialists&apos; findings below stand on their own.</p>
        </Section>
      )}

      <Section title="Where the agents disagreed" aside={<span className="count">{report.disagreements.length}</span>}>
        {report.disagreements.length === 0 ? (
          <p className="muted">No disagreement between agents, or with the rule-based engine, was found.</p>
        ) : (
          report.disagreements.map((d, i) => (
            <div key={i} className="ai-disagreement">
              <span className="ai-disagreement__who">
                {d.between.map((b) => AGENT_INFO[b as AgentId]?.title ?? b.replace(/_/g, ' ')).join('  vs  ')}
                <span className="muted"> · {d.source === 'cross_check' ? 'found by comparing outputs' : 'reported by the orchestrator'}</span>
              </span>
              <span className="ai-disagreement__topic">{d.topic}</span>
              <span className="ai-disagreement__resolution">{d.resolution}</span>
            </div>
          ))
        )}
      </Section>

      {hyp ? (
        <Section title="Hypothesis review" aside={<span className="muted">{AGENT_INFO.hypothesis_analyst.title}</span>}>
          <p className="hint">
            The rule-based support score and the analyst&apos;s stance are shown side by side. Neither is a probability. {hyp.agreesWithDeterministicRanking ? 'The analyst agrees with the rule-based ranking.' : 'The analyst does not agree with the rule-based ranking.'}{' '}
            {hyp.rankingNote}
          </p>
          {hyp.assessments.map((x) => {
            const det = incident.hypotheses.find((h) => h.key === x.hypothesisKey);
            return (
              <div key={x.hypothesisKey} className={`ai-hyp ai-hyp--${x.stance}${hyp.leadingHypothesisKey === x.hypothesisKey ? ' is-lead' : ''}`}>
                <div className="ai-hyp__head">
                  <button type="button" className="ai-hyp__title" onClick={() => runtime.setInvestigationTab('hypotheses')}>
                    {title(x.hypothesisKey)}
                  </button>
                  <span className="ai-hyp__scores">
                    <span title="Rule-based evidence-support score">{det ? `${Math.round(det.support * 100)} % rule-based` : '—'}</span>
                    <span className={`ai-stance ai-stance--${x.stance}`}>{STANCE_LABEL[x.stance]}</span>
                  </span>
                </div>
                <p className="ai-hyp__why">{x.rationale}</p>
                {x.supporting.length > 0 ? (
                  <ul className="ai-claims ai-claims--for">
                    {x.supporting.map((c, i) => (
                      <ClaimRow key={i} claim={c} catalogue={catalogue} />
                    ))}
                  </ul>
                ) : null}
                {x.contradicting.length > 0 ? (
                  <ul className="ai-claims ai-claims--against">
                    {x.contradicting.map((c, i) => (
                      <ClaimRow key={i} claim={c} catalogue={catalogue} />
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
          <Block title="The case against the leading explanation">
            <p>{hyp.challengeToLeading.statement}</p>
            <Evidence ids={hyp.challengeToLeading.evidence} catalogue={catalogue} />
          </Block>
          <Block title="What would separate the explanations" empty={hyp.discriminators.length === 0}>
            <ul className="plain">
              {hyp.discriminators.map((d, i) => (
                <li key={i}>
                  {d.check} <span className="muted">Separates {d.separates.map(title).join(' from ')}. {d.expectedIfFirst}</span>
                </li>
              ))}
            </ul>
          </Block>
        </Section>
      ) : null}

      {ev ? (
        <Section title="What the evidence shows" aside={<span className="muted">{AGENT_INFO.evidence_analyst.title}</span>}>
          <p>{ev.summary}</p>
          <p className="hint">Evidence quality, as judged by the analyst: {ev.evidenceQuality}.</p>
          <Block title="Observations" empty={ev.observations.length === 0}>
            <ul className="ai-claims">
              {ev.observations.map((c, i) => (
                <ClaimRow key={i} claim={c} catalogue={catalogue} />
              ))}
            </ul>
          </Block>
          <Block title="Sequence" empty={ev.sequence.length === 0}>
            <ol className="ai-sequence">
              {ev.sequence.map((s, i) => (
                <li key={i}>
                  <span className="ai-sequence__asset">{s.assetId}</span> {s.description} <Evidence ids={s.evidence} catalogue={catalogue} />
                </li>
              ))}
            </ol>
          </Block>
          <Block title="Interpretations" empty={ev.interpretations.length === 0}>
            <ul className="ai-claims">
              {ev.interpretations.map((c, i) => (
                <ClaimRow key={i} claim={c} catalogue={catalogue} />
              ))}
            </ul>
          </Block>
          <Block title="What is missing" empty={ev.gaps.length === 0 && (!orch || orch.openQuestions.length === 0)}>
            <ul className="plain">
              {ev.gaps.map((gap, i) => (
                <li key={i}>
                  {gap.description} <span className="muted">Would clarify: {gap.wouldClarify}</span> <Evidence ids={gap.relatedTo} catalogue={catalogue} />
                </li>
              ))}
              {(orch?.openQuestions ?? []).map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </Block>
        </Section>
      ) : null}

      {imp ? (
        <Section title="Downstream exposure" aside={<span className="muted">{AGENT_INFO.impact_analyst.title}</span>}>
          <p>{imp.summary}</p>
          <Block title="Exposed, not yet abnormal" empty={imp.potentiallyAffected.length === 0}>
            <ul className="plain">
              {imp.potentiallyAffected.map((p, i) => (
                <li key={i}>
                  <span className="ai-sequence__asset">{p.assetId}</span> <span className={`ai-exposure ai-exposure--${p.exposure}`}>{p.exposure}</span> {p.pathway}
                </li>
              ))}
            </ul>
          </Block>
          <Block title="Possible cascade" empty={imp.cascades.length === 0}>
            <ul className="ai-claims">
              {imp.cascades.map((c, i) => (
                <ClaimRow key={i} claim={{ statement: c.description, basis: 'inference', evidence: c.evidence }} catalogue={catalogue} />
              ))}
            </ul>
          </Block>
        </Section>
      ) : null}

      {plan ? (
        <Section title="Recommended checks" aside={<span className="muted">{AGENT_INFO.investigation_planner.title}</span>}>
          <p className="hint">Inspection and measurement only. Changing how the plant runs is an operator&apos;s decision.</p>
          <ol className="ai-checks">
            {[...plan.checks]
              .sort((x, y) => x.priority - y.priority)
              .map((c, i) => (
                <li key={i} className="ai-check">
                  <div className="ai-check__head">
                    <span className="ai-check__action">{c.action}</span>
                    <span className={`ai-value ai-value--${c.investigativeValue}`}>{c.investigativeValue} value</span>
                  </div>
                  <p className="ai-check__why">{c.rationale}</p>
                  <p className="ai-check__links">
                    On <span className="ai-sequence__asset">{c.targetAssetId}</span>
                    {c.addressesHypotheses.length > 0 ? ` · bears on ${c.addressesHypotheses.map(title).join('; ')}` : ''}
                    {c.resolvesGap ? ` · closes gap: ${c.resolvesGap}` : ''}
                  </p>
                </li>
              ))}
          </ol>
          <p className="hint">{plan.sequencingNote}</p>
        </Section>
      ) : null}

      <Section title="Governance and audit">
        <dl className="kv kv--compact">
          <dt>Claims checked</dt>
          <dd>{g.claims}</dd>
          <dt>Claims removed</dt>
          <dd>{g.claimsRejected}</dd>
          <dt>Citations checked</dt>
          <dd>
            {g.citations} ({g.invalidCitations} invalid in the accepted answers)
          </dd>
          <dt>Figures not found in evidence</dt>
          <dd>{g.figuresFlagged}</dd>
          <dt>Model calls</dt>
          <dd>{g.modelCalls}</dd>
          <dt>Tokens</dt>
          <dd>
            {report.usage.inputTokens.toLocaleString('en-US')} in · {report.usage.outputTokens.toLocaleString('en-US')} out
          </dd>
          <dt>Estimated cost</dt>
          <dd>{report.estimatedCostUsd === null ? 'not estimated' : `$${report.estimatedCostUsd.toFixed(4)}`}</dd>
          <dt>Duration</dt>
          <dd>{(report.durationMs / 1000).toFixed(1)} s</dd>
          <dt>Incident state changed</dt>
          <dd>No. An AI run cannot confirm a cause.</dd>
        </dl>
        <Block title="Validation log">
          <Issues issues={issues} />
        </Block>
        <div className="button-row">
          <button type="button" className="btn btn--ghost" onClick={() => runtime.exportAudit(incident.id)} title="Every model input, raw output and validation result for this run">
            Export audit log (JSON)
          </button>
        </div>
      </Section>
    </>
  );
}

export function AiPanel({ incident }: { incident: Incident }) {
  const runtime = useRuntime();
  const ai = useUi((s) => s.ai);
  useUi((s) => s.aiKey);
  useUi((s) => s.incidentsKey);
  const run: AiRun | undefined = runtime.aiRun(incident.id);
  const stale = runtime.aiStale(incident.id);
  const report = run?.report ?? null;
  const catalogue = run ? catalogueOf(run.context) : null;
  const running = run?.state === 'running';
  const testDouble = run?.testDouble ?? ai.testDouble;

  return (
    <div className="ai-panel">
      <Section
        title={
          <>
            AI investigation <span className="epi epi--ai">AI</span>
          </>
        }
        aside={
          <span className={`status-chip status-chip--ai-${!ai.available ? 'off' : running ? 'running' : report ? report.status : 'ready'}`}>
            {!ai.checked ? 'Checking' : !ai.available ? 'Unavailable' : running ? 'Running' : report ? report.status : 'Ready'}
          </span>
        }
      >
        {testDouble ? (
          <p className="notice notice--test">
            <strong>Scripted test provider — not a language model.</strong> The text below is assembled mechanically from the context to exercise the workflow and this interface. It is not AI reasoning.
          </p>
        ) : null}

        {!ai.available ? (
          <div className="ai-unavailable">
            <p className="ai-unavailable__title">AI investigation is unavailable</p>
            <p>{ai.reason}</p>
            <p className="hint">
              Nothing else is affected: detection, correlation, the rule-based hypotheses and the recommended checks in the other tabs are complete without it. To enable it, put an API key in <code>.env.local</code> (see <code>.env.example</code>) and restart the server.
            </p>
            <div className="button-row">
              <button type="button" className="btn btn--ghost" onClick={() => runtime.recheckAi()}>
                Check again
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="ai-intro">
              Five agents review this incident: each sees a different slice of the evidence, must cite it by ID, and is checked before anything is shown. They advise; they cannot confirm a cause or change the incident.
            </p>
            {ai.provider === 'ollama' ? (
              <p className="notice">
                Runs on this computer’s local model ({ai.model ?? 'Ollama'}). On a laptop processor a full review takes several minutes per agent, longer if memory is short. For a quick answer, use the <button type="button" className="link-button" onClick={() => runtime.setInvestigationTab('ask')}>Ask</button> tab (about a minute).
              </p>
            ) : null}
            <div className="button-row">
              <button type="button" className="btn btn--primary" onClick={() => runtime.runAiInvestigation(incident.id)} disabled={running}>
                {running ? 'Investigating…' : report || run?.error ? 'Run again' : 'Run AI investigation'}
              </button>
              {running ? (
                <button type="button" className="btn btn--ghost" onClick={() => runtime.cancelAiInvestigation(incident.id)}>
                  Cancel
                </button>
              ) : null}
              <span className="hint">
                {ai.provider}
                {ai.model ? ` · ${ai.model}` : ''} · at most {ai.maxModelCalls} model calls
              </span>
            </div>
          </>
        )}

        {run?.error && !running ? <p className="notice notice--error">{run.error} The deterministic assessment is unaffected.</p> : null}
        {stale ? <p className="notice">The incident has changed since this investigation ran ({incident.anomalyIds.length} detections now). Run it again for an up-to-date review.</p> : null}

        {run ? (
          <ol className="agents">
            {AGENT_ORDER.map((id) => (
              <AgentRow key={id} id={id} progress={run.agents[id]} run={report ? report.agents[id] : null} />
            ))}
          </ol>
        ) : ai.available ? (
          <ol className="agents agents--idle">
            {AGENT_ORDER.map((id) => (
              <AgentRow key={id} id={id} progress={{ status: 'pending', attempt: 0, latencyMs: 0 }} run={null} />
            ))}
          </ol>
        ) : null}
      </Section>

      {report && catalogue && report.status !== 'failed' ? <Findings report={report} incident={incident} catalogue={catalogue} /> : null}
    </div>
  );
}
