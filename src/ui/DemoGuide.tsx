/**
 * First-run welcome and the guided demonstration.
 *
 * The guide is a thin strip over the scene, not a tutorial overlay: one line of
 * explanation per step, driven by what the plant and the engines are actually doing.
 * It never fakes a state - where it has to wait for a detection, it waits.
 */
import { useRuntime, useUi } from './context';

const STEPS = ['Telemetry', 'Anomaly', 'Correlation', 'Hypotheses', 'Evidence', 'AI review', 'Checks', 'Human verdict'];

export function Welcome() {
  const runtime = useRuntime();
  const show = useUi((s) => s.demo.welcome);
  const ai = useUi((s) => s.ai);
  if (!show) return null;
  return (
    <div className="welcome" role="dialog" aria-modal="false" aria-labelledby="welcome-title">
      <div className="welcome__card">
        <span className="welcome__eyebrow">Vanterra · cyber-physical intelligence · simulated facility</span>
        <h1 id="welcome-title" className="welcome__title">
          Investigate the physical and the digital together.
        </h1>
        <p className="welcome__lead">
          Vanterra watches a plant&apos;s process telemetry and its OT network, detects abnormal behaviour in both, links events through declared equipment and control relationships, and builds an evidence-backed
          investigation: what is happening, what changed, which explanations the evidence supports, and what a person should check next.
        </p>
        <p className="welcome__note">
          The plant and its OT network are simulated: 32 assets, 84 signals, 14 OT devices. Nothing real is connected or controlled.
          {ai.checked ? (ai.available ? ` AI review is available (${ai.testDouble ? 'scripted test double' : ai.model}).` : ' AI review is not configured; the deterministic investigation is complete without it.') : ''}
        </p>
        <div className="welcome__actions">
          <button type="button" className="btn btn--primary welcome__start" onClick={() => runtime.startDemo()} autoFocus>
            Guided tour · physical incident
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              runtime.dismissWelcome();
              runtime.runScenario('cp-fan-setpoint');
              runtime.setView('overview');
            }}
          >
            Run the cyber-physical scenario
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => runtime.dismissWelcome()}>
            Explore on my own
          </button>
        </div>
        <p className="welcome__foot">The guided tour takes about two minutes. The cyber-physical scenario starts an unapproved controller change; open the incident it causes and compare the explanations.</p>
      </div>
    </div>
  );
}

export function DemoGuide() {
  const runtime = useRuntime();
  const demo = useUi((s) => s.demo);
  const counts = useUi((s) => s.counts);
  const ai = useUi((s) => s.ai);
  useUi((s) => s.aiKey);
  useUi((s) => s.incidentsKey);
  if (!demo.active) return null;

  const incident = runtime.core.intelligence.incidents()[0];
  const aiRun = incident ? runtime.aiRun(incident.id) : undefined;
  const confirmed = incident?.hypotheses.some((h) => h.disposition === 'confirmed') ?? false;
  const step = demo.step;
  let text: string;
  let next: string | null = 'Next';
  let waiting = false;

  switch (step) {
    case 0:
      text = 'Feed pump P-101 is running normally. Vanterra has learned a baseline for each of the plant’s 84 signals; the trend on the right is its vibration.';
      next = 'Inject a bearing fault';
      break;
    case 1:
      if (counts.anomalies === 0) {
        text = 'A fault has been injected into the simulated pump. Detection is not told: it has to notice the measurements change.';
        waiting = true;
      } else {
        text = 'Detected: vibration on P-101 has left its learned baseline. One anomaly is not an incident yet; Vanterra is waiting to see whether anything related follows.';
        waiting = true;
      }
      next = null;
      break;
    case 2:
      text = 'A second, related anomaly arrived. Vanterra linked them through the dependency graph and opened an incident. The scene now shows only what is involved.';
      break;
    case 3:
      text = 'Competing explanations, each scored on evidence for and against. The percentage is an evidence-support score, not a probability, and none of these is a diagnosis.';
      break;
    case 4:
      text = 'Every detection keeps the rule that fired and the measurement behind it. Open any row to check the claim against the trend yourself.';
      break;
    case 5:
      text = !ai.available
        ? 'No model provider is configured, so the AI review is switched off. Nothing else depends on it: the rule-based investigation you have just seen is complete.'
        : aiRun?.report
          ? 'Five agents reviewed the incident. Each finding cites evidence by ID, and anything that cited evidence that does not exist was removed before display.'
          : aiRun?.state === 'running'
            ? 'The agents are working: two read the evidence in parallel, then the hypothesis analyst, the planner and the orchestrator build on them.'
            : 'Five specialised agents can now review this incident. Press “Run AI investigation” in the panel, or continue without it.';
      break;
    case 6:
      text = 'Recommended physical checks, each tied to the hypothesis it would confirm or rule out. Vanterra recommends; it does not operate equipment.';
      break;
    default:
      text = confirmed
        ? 'Confirmed by you, and recorded as such. Only a person can do that: neither the rules nor the AI can. The demo is complete.'
        : 'Last step: only a person can confirm a cause. Open the leading hypothesis and press “Mark confirmed”, as you would after an inspection.';
      next = null;
  }

  return (
    <div className="guide" role="region" aria-label="Guided demonstration">
      <ol className="guide__steps">
        {STEPS.map((label, i) => (
          <li key={label} className={`guide__step${i === step ? ' is-current' : ''}${i < step ? ' is-done' : ''}`}>
            <span className="guide__num">{i + 1}</span>
            <span className="guide__label">{label}</span>
          </li>
        ))}
      </ol>
      <div className="guide__body">
        <p className="guide__text">
          {waiting ? <span className="guide__wait" aria-hidden="true" /> : null}
          {text}
        </p>
        <div className="guide__actions">
          {step > 2 ? (
            <button type="button" className="btn btn--ghost" onClick={() => runtime.demoGo(step - 1)}>
              Back
            </button>
          ) : null}
          {next ? (
            <button type="button" className="btn btn--primary" onClick={() => runtime.demoGo(step + 1)}>
              {next}
            </button>
          ) : null}
          <button type="button" className="btn btn--ghost" onClick={() => runtime.endDemo()}>
            {step === STEPS.length - 1 ? 'Finish' : 'End demo'}
          </button>
        </div>
      </div>
    </div>
  );
}
