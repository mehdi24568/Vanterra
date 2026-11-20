/**
 * Browser-side client of the AI service.
 *
 * It builds the investigation context from the live engines, posts it, follows the
 * progress stream, and re-validates the returned report before anything is shown.
 * It holds reports beside the incidents; it has no way to change one.
 */
import { acceptReport, isStale } from '../agents/acceptReport';
import { AGENT_ORDER } from '../agents/agents';
import { buildInvestigationContext } from '../agents/buildContext';
import type { InvestigationContext } from '../agents/context';
import type { AgentStatus, InvestigationReport, PlanStep, RunEvent } from '../agents/report';
import type { AgentId } from '../agents/schemas';
import type { AtlasCore } from './AtlasCore';

export interface AiAvailability {
  checked: boolean;
  available: boolean;
  provider: string;
  model: string | null;
  testDouble: boolean;
  reason: string | null;
  maxModelCalls: number;
}

export interface AgentProgress {
  status: 'pending' | 'running' | AgentStatus;
  attempt: number;
  latencyMs: number;
}

export interface AiRun {
  incidentId: string;
  state: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt: number | null;
  plan: PlanStep[];
  agents: Record<AgentId, AgentProgress>;
  context: InvestigationContext;
  report: InvestigationReport | null;
  error: string | null;
  provider: string;
  model: string | null;
  testDouble: boolean;
}

/** One question and its answer in "Ask Vanterra". */
export interface AskMessage {
  id: number;
  question: string;
  /** engine: answered instantly from the deterministic assessment; model: answered by the AI and checked. */
  source: 'engine' | 'model';
  state: 'pending' | 'answered' | 'rejected' | 'failed';
  answer: string | null;
  items: { text: string; evidence: string[] }[];
  evidence: string[];
  basis: 'observed' | 'inferred' | 'not_in_evidence' | null;
  notes: string[];
  /** A draft that failed the checks: shown only on request, labelled as not an answer. */
  rejectedDraft?: string | null;
  model: string | null;
  latencyMs: number;
}

const UNCHECKED: AiAvailability ={ checked: false, available: false, provider: 'unknown', model: null, testDouble: false, reason: 'Checking…', maxModelCalls: 10 };

export class AiService {
  availability: AiAvailability = UNCHECKED;
  private runs = new Map<string, AiRun>();
  private controllers = new Map<string, AbortController>();
  private asks = new Map<string, AskMessage[]>();
  private askSeq = 0;

  constructor(
    private readonly core: AtlasCore,
    private readonly notify: () => void,
  ) {}

  run(incidentId: string): AiRun | undefined {
    return this.runs.get(incidentId);
  }

  /** True when the incident has gained or lost detections since its report was made. */
  stale(incidentId: string): boolean {
    const run = this.runs.get(incidentId);
    const incident = this.core.intelligence.get(incidentId);
    return !!run?.report && !!incident && isStale(run.report, incident);
  }

  reset(): void {
    for (const c of this.controllers.values()) c.abort();
    this.controllers.clear();
    this.runs.clear();
    this.asks.clear();
  }

  askHistory(incidentId: string): AskMessage[] {
    return this.asks.get(incidentId) ?? [];
  }

  private pushAsk(incidentId: string, m: Omit<AskMessage, 'id'>): AskMessage {
    const msg: AskMessage = { id: ++this.askSeq, ...m };
    this.asks.set(incidentId, [...this.askHistory(incidentId), msg]);
    this.notify();
    return msg;
  }

  /** An answer computed by the deterministic engine (no model). */
  addEngineAnswer(incidentId: string, question: string, answer: string | null, items: AskMessage['items'] = []): void {
    this.pushAsk(incidentId, { question, source: 'engine', state: 'answered', answer, items, evidence: [], basis: null, notes: [], model: null, latencyMs: 0 });
  }

  /** A free-form question for the model; the server checks the answer before returning it. */
  async ask(incidentId: string, question: string): Promise<void> {
    const incident = this.core.intelligence.get(incidentId);
    const q = question.trim();
    if (!incident || !q || !this.availability.available) return;
    const msg = this.pushAsk(incidentId, { question: q, source: 'model', state: 'pending', answer: null, items: [], evidence: [], basis: null, notes: [], model: this.availability.model, latencyMs: 0 });
    const started = performance.now();
    try {
      const res = await fetch('/api/ai/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: buildInvestigationContext(this.core, incident), question: q }),
      });
      const body = (await res.json()) as Partial<AskMessage> & { status?: AskMessage['state']; message?: string };
      if (!res.ok) {
        msg.state = 'failed';
        msg.notes = [body.message ?? `The AI service answered ${res.status}.`];
      } else {
        msg.state = body.status ?? 'failed';
        msg.answer = body.answer ?? null;
        msg.evidence = body.evidence ?? [];
        msg.basis = body.basis ?? null;
        msg.notes = body.notes ?? [];
        msg.rejectedDraft = body.rejectedDraft ?? null;
        msg.model = body.model ?? msg.model;
      }
    } catch {
      msg.state = 'failed';
      msg.notes = ['The AI service could not be reached.'];
    } finally {
      msg.latencyMs = performance.now() - started;
      this.asks.set(incidentId, [...this.askHistory(incidentId)]);
      this.notify();
    }
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch('/api/ai/status', { headers: { Accept: 'application/json' } });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.includes('json')) throw new Error('no service');
      const s = (await res.json()) as { available: boolean; provider: string; model: string | null; testDouble: boolean; reason: string | null; limits?: { maxModelCalls: number } };
      this.availability = {
        checked: true,
        available: !!s.available,
        provider: s.provider,
        model: s.model,
        testDouble: !!s.testDouble,
        reason: s.reason,
        maxModelCalls: s.limits?.maxModelCalls ?? 10,
      };
    } catch {
      this.availability = {
        checked: true,
        available: false,
        provider: 'none',
        model: null,
        testDouble: false,
        reason: 'The AI service is not reachable. It runs with the development or preview server; a static build has no AI.',
        maxModelCalls: 10,
      };
    }
    this.notify();
  }

  cancel(incidentId: string): void {
    this.controllers.get(incidentId)?.abort();
  }

  async investigate(incidentId: string): Promise<void> {
    const incident = this.core.intelligence.get(incidentId);
    if (!incident || !this.availability.available || this.runs.get(incidentId)?.state === 'running') return;
    const context = buildInvestigationContext(this.core, incident);
    const run: AiRun = {
      incidentId,
      state: 'running',
      startedAt: performance.now(),
      finishedAt: null,
      plan: [],
      agents: Object.fromEntries(AGENT_ORDER.map((a) => [a, { status: 'pending', attempt: 0, latencyMs: 0 }])) as Record<AgentId, AgentProgress>,
      context,
      report: null,
      error: null,
      provider: this.availability.provider,
      model: this.availability.model,
      testDouble: this.availability.testDouble,
    };
    this.runs.set(incidentId, run);
    const controller = new AbortController();
    this.controllers.set(incidentId, controller);
    this.core.log('ai', 'info', `${incidentId}: AI investigation started`, `${context.anomalies.length} detections, ${context.hypotheses.length} hypotheses sent to ${run.provider}`, { incidentId });
    this.notify();

    const fail = (message: string) => {
      run.state = 'error';
      run.error = message;
      run.finishedAt = performance.now();
      for (const a of Object.values(run.agents)) if (a.status === 'running' || a.status === 'pending') a.status = 'failed';
      this.core.log('ai', 'warning', `${incidentId}: AI investigation failed`, `${message} The deterministic assessment is unaffected.`, { incidentId });
    };

    try {
      const res = await fetch('/api/ai/investigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        let message = `The AI service answered ${res.status}.`;
        try {
          message = ((await res.json()) as { message?: string }).message ?? message;
        } catch {
          /* keep the generic message */
        }
        fail(message);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
          if (!line) continue;
          let event: RunEvent;
          try {
            event = JSON.parse(line) as RunEvent;
          } catch {
            continue;
          }
          finished = this.apply(run, event) || finished;
          this.notify();
        }
      }
      if (!finished && run.state === 'running') fail('The connection closed before the investigation finished.');
    } catch (err) {
      fail(controller.signal.aborted ? 'Cancelled.' : err instanceof Error ? `Could not reach the AI service: ${err.message}.` : 'Could not reach the AI service.');
    } finally {
      this.controllers.delete(incidentId);
      this.notify();
    }
  }

  /** Apply one progress event. Returns true when the run has reached a final state. */
  private apply(run: AiRun, event: RunEvent): boolean {
    switch (event.type) {
      case 'run_started':
        run.plan = event.plan;
        run.provider = event.provider;
        run.model = event.model;
        run.testDouble = event.testDouble;
        return false;
      case 'agent_started':
        run.agents[event.agent] = { status: 'running', attempt: event.attempt, latencyMs: run.agents[event.agent].latencyMs };
        return false;
      case 'agent_finished':
        run.agents[event.agent] = { status: event.status, attempt: event.attempts, latencyMs: event.latencyMs };
        return false;
      case 'run_failed':
        run.state = 'error';
        run.error = event.message;
        run.finishedAt = performance.now();
        return true;
      case 'run_finished': {
        const incident = this.core.intelligence.get(run.incidentId);
        run.finishedAt = performance.now();
        if (!incident) {
          run.state = 'error';
          run.error = 'The incident no longer exists.';
          return true;
        }
        const accepted = acceptReport(incident, run.context, event.report);
        if (!accepted.ok) {
          run.state = 'error';
          run.error = `Report refused: ${accepted.reason}.`;
          this.core.log('ai', 'warning', `${run.incidentId}: AI report refused`, accepted.reason, { incidentId: run.incidentId });
          return true;
        }
        run.report = accepted.report;
        run.state = accepted.report.status === 'failed' ? 'error' : 'done';
        run.error = accepted.report.failure;
        const g = accepted.report.governance;
        this.core.log(
          'ai',
          accepted.report.status === 'complete' ? 'info' : 'warning',
          `${run.incidentId}: AI investigation ${accepted.report.status}`,
          `${g.modelCalls} model calls, ${g.claims} claims checked, ${g.claimsRejected} rejected. No incident state was changed.`,
          { incidentId: run.incidentId },
        );
        return true;
      }
    }
  }
}
