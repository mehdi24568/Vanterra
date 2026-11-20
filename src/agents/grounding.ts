/**
 * Grounding validator - the gate between what a model returned and what ATLAS shows.
 *
 * A schema-valid answer is not yet an acceptable one. This module checks every
 * agent output against the investigation context it was given:
 *
 *   unknown_evidence     a cited ID that does not exist in the context
 *   unknown_asset        an asset reference that does not exist in the context
 *   unknown_hypothesis   a hypothesis key that does not exist in the context
 *   missing_citation     an observation with nothing cited
 *   certainty_language   wording that asserts a confirmed or certain cause
 *   probability_language a support score restated as a probability
 *   unverified_figure    a number with a unit that appears nowhere in the context
 *
 * In `check` mode it only reports. In `sanitise` mode it removes what cannot be
 * trusted: a list item with a rejected issue is dropped, an unknown ID in a
 * top-level field is stripped, and certainty language in a top-level statement
 * rejects the whole output. Figures are flagged, not removed - a derived figure
 * (a difference, a ratio) is legitimate but should be visibly marked.
 */
import type { EvidenceCatalogue, InvestigationContext } from './context';

export type IssueCode =
  | 'schema'
  | 'unknown_evidence'
  | 'unknown_asset'
  | 'unknown_hypothesis'
  | 'missing_citation'
  | 'certainty_language'
  | 'causal_overreach'
  | 'probability_language'
  | 'unverified_figure';

export interface GroundingIssue {
  code: IssueCode;
  path: string;
  detail: string;
  action: 'rejected' | 'flagged';
}

export interface GroundingStats {
  /** List items inspected (claims, assessments, checks, ...). */
  claims: number;
  claimsRejected: number;
  citations: number;
  invalidCitations: number;
  figuresFlagged: number;
}

export interface GroundingResult<T> {
  /** Null when the output as a whole had to be rejected. */
  output: T | null;
  issues: GroundingIssue[];
  stats: GroundingStats;
  /** Valid IDs cited by what survived. */
  cited: string[];
}

const ASSET_KEYS = new Set(['assetId', 'targetAssetId']);
const HYPOTHESIS_KEYS = new Set(['hypothesisKey', 'leadingHypothesisKey']);
const HYPOTHESIS_ARRAYS = new Set(['separates', 'addressesHypotheses']);
const EVIDENCE_ARRAYS = new Set(['evidence', 'relatedTo']);
/** Categorical fields and agent names: never treated as free text. */
const NON_TEXT_KEYS = new Set(['basis', 'stance', 'exposure', 'investigativeValue', 'standing', 'evidenceQuality', 'between']);
/** Lists whose items may legitimately carry no citation (plans and projections are inferences by nature). */
const CITATION_OPTIONAL = /(^|\.)(checks|cascades|gaps|discriminators|disagreements)\[\d+\]$/;

const CERTAINTY: RegExp[] = [
  /\b(root cause|cause|diagnosis|failure|fault)\s+(is|has been|was)\s+(now\s+)?(confirmed|verified|proven|established)\b/i,
  /\b(is|are|has been|have been)\s+(now\s+)?(confirmed|proven)\b(?!\s+(only\s+|solely\s+)?(by|after)\b)/i,
  /\b(definitely|certainly|undoubtedly|unquestionably|guaranteed)\b/i,
  /\b(without|beyond)\s+(a\s+|any\s+)?doubt\b/i,
  /\b(100|99)\s?%\s*(certain|sure|confident)/i,
];

const PROBABILITY: RegExp[] = [
  /\b\d{1,3}(\.\d+)?\s?%\s+(probability|probable|likely|likelihood|chance|certain|confidence|confident)\b/i,
  /\b(probability|likelihood|chance)\s+(of|is|that)\b[^.]{0,40}\b\d{1,3}(\.\d+)?\s?%/i,
];

/** Attributing a physical effect to an attack or attacker. A configuration change can be evidenced; intent cannot. */
const ATTRIBUTION: RegExp[] = [
  /\b(caused|triggered|brought about|carried out|done)\s+by\s+(an?\s+|the\s+)?(cyber[- ]?attack|attack|attacker|adversary|intrusion|intruder|hacker|threat actor|malicious)/i,
  /\b(attacker|adversary|hacker|intruder|threat actor)s?\b[^.]{0,60}\b(caused|changed|manipulated|disabled|tampered|sabotaged|reduced|shut|compromised)\b/i,
  /\b(is|was|constitutes|represents)\s+(an?\s+)?(cyber[- ]?attack|sabotage|malicious\s+(act|activity|change|access))\b/i,
];
const HEDGE = /\b(may|might|could|possibl\w*|not established|cannot|unknown|unclear|whether|if|unproven|no evidence|does not show|not shown|not determined)\b/i;

const FIGURE =/(-?\d+(?:\.\d+)?)\s?(mm\/s|°C|bar|kW|m³\/h|u\/min|c\/min|p\/h|m\/s|σ|%|A\b|V\b)/g;

/** Every number that appears anywhere in the context, in fields or inside text. */
export function contextNumbers(ctx: InvestigationContext): number[] {
  const out: number[] = [];
  const visit = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(Math.abs(v));
    else if (typeof v === 'string') for (const m of v.replace(/−/g, '-').matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(ctx);
  return out;
}

function figuresNotInContext(text: string, numbers: number[]): string[] {
  const missing: string[] = [];
  for (const m of text.replace(/−/g, '-').matchAll(FIGURE)) {
    const value = Math.abs(Number(m[1]));
    const tolerance = Math.max(0.02 * value, 0.06);
    if (!numbers.some((n) => Math.abs(n - value) <= tolerance)) missing.push(`${m[1]} ${m[2]}`);
  }
  return missing;
}

export function ground<T>(output: T, catalogue: EvidenceCatalogue, ctx: InvestigationContext, mode: 'check' | 'sanitise'): GroundingResult<T> {
  const issues: GroundingIssue[] = [];
  const stats: GroundingStats = { claims: 0, claimsRejected: 0, citations: 0, invalidCitations: 0, figuresFlagged: 0 };
  const cited = new Set<string>();
  const numbers = contextNumbers(ctx);
  let fatal = false;

  const textIssues = (text: string, path: string, local: GroundingIssue[]) => {
    if (CERTAINTY.some((re) => re.test(text))) {
      local.push({ code: 'certainty_language', path, detail: 'Asserts a confirmed or certain cause. Only an operator can confirm.', action: 'rejected' });
    }
    if (PROBABILITY.some((re) => re.test(text))) {
      local.push({ code: 'probability_language', path, detail: 'States a probability. Support scores are not probabilities.', action: 'rejected' });
    }
    if (ATTRIBUTION.some((re) => re.test(text)) && !HEDGE.test(text)) {
      local.push({
        code: 'causal_overreach',
        path,
        detail: 'Attributes the event to an attack or an attacker. The evidence can show that a change was made and what followed; it cannot establish intent.',
        action: 'rejected',
      });
    }
    const missing = figuresNotInContext(text, numbers);
    if (missing.length > 0) {
      stats.figuresFlagged += missing.length;
      local.push({ code: 'unverified_figure', path, detail: `Figure not found in the supplied evidence: ${missing.join(', ')}`, action: 'flagged' });
    }
  };

  /** Returns the (possibly sanitised) value and whether the caller should drop it. */
  const walk = (value: unknown, path: string, inList: boolean): { value: unknown; drop: boolean } => {
    if (Array.isArray(value)) {
      const kept: unknown[] = [];
      value.forEach((el, i) => {
        if (el && typeof el === 'object' && !Array.isArray(el)) {
          stats.claims += 1;
          const r = walk(el, `${path}[${i}]`, true);
          if (r.drop) {
            stats.claimsRejected += 1;
            if (mode === 'check') kept.push(r.value);
          } else kept.push(r.value);
        } else kept.push(el);
      });
      return { value: kept, drop: false };
    }
    if (!value || typeof value !== 'object') return { value, drop: false };

    const node = { ...(value as Record<string, unknown>) };
    const local: GroundingIssue[] = [];
    // Issues that are repaired by stripping a reference rather than dropping the item.
    const stripped = new Set<GroundingIssue>();

    for (const [key, v] of Object.entries(node)) {
      const p = path ? `${path}.${key}` : key;
      if (EVIDENCE_ARRAYS.has(key) && Array.isArray(v)) {
        const valid: string[] = [];
        for (const id of v as unknown[]) {
          stats.citations += 1;
          if (typeof id === 'string' && catalogue.all.has(id)) valid.push(id);
          else {
            stats.invalidCitations += 1;
            local.push({ code: 'unknown_evidence', path: p, detail: `"${String(id)}" is not in the investigation context`, action: 'rejected' });
          }
        }
        // Outside a list there is nothing to drop, so strip the bad references instead.
        if (!inList && mode === 'sanitise') node[key] = valid;
      } else if (HYPOTHESIS_ARRAYS.has(key) && Array.isArray(v)) {
        const bad = (v as unknown[]).filter((id) => typeof id !== 'string' || !catalogue.hypotheses.has(id));
        for (const id of bad) {
          const issue: GroundingIssue = { code: 'unknown_hypothesis', path: p, detail: `"${String(id)}" is not a hypothesis in the context`, action: 'rejected' };
          local.push(issue);
          stripped.add(issue);
        }
        if (bad.length > 0 && mode === 'sanitise') node[key] = (v as unknown[]).filter((id) => !bad.includes(id));
      } else if (ASSET_KEYS.has(key) && typeof v === 'string') {
        if (!catalogue.assets.has(v)) local.push({ code: 'unknown_asset', path: p, detail: `"${v}" is not an asset in the context`, action: 'rejected' });
      } else if (HYPOTHESIS_KEYS.has(key) && typeof v === 'string') {
        if (!catalogue.hypotheses.has(v)) {
          local.push({ code: 'unknown_hypothesis', path: p, detail: `"${v}" is not a hypothesis in the context`, action: 'rejected' });
          if (!inList && mode === 'sanitise') node[key] = null;
        }
      } else if (typeof v === 'string' && !NON_TEXT_KEYS.has(key)) {
        textIssues(v, p, local);
      } else if (Array.isArray(v) && v.every((x) => typeof x === 'string') && !NON_TEXT_KEYS.has(key)) {
        // Free-text lists (open questions, limitations): drop individual offending lines.
        const keep: string[] = [];
        (v as string[]).forEach((line, i) => {
          const lineIssues: GroundingIssue[] = [];
          textIssues(line, `${p}[${i}]`, lineIssues);
          issues.push(...lineIssues);
          if (mode === 'check' || !lineIssues.some((x) => x.action === 'rejected')) keep.push(line);
        });
        node[key] = keep;
      } else if (v && typeof v === 'object') {
        const r = walk(v, p, false);
        node[key] = r.value;
      }
    }

    // An observation must point at something.
    if (inList && Array.isArray(node.evidence) && node.basis !== 'inference' && !CITATION_OPTIONAL.test(path)) {
      const validCount = (node.evidence as unknown[]).filter((id) => typeof id === 'string' && catalogue.all.has(id)).length;
      if (validCount === 0) local.push({ code: 'missing_citation', path, detail: 'Presented as an observation but cites no evidence', action: 'rejected' });
    }

    issues.push(...local);
    const rejected = local.some((i) => i.action === 'rejected' && !stripped.has(i));
    if (!inList && local.some((i) => i.code === 'certainty_language' || i.code === 'probability_language' || i.code === 'causal_overreach')) fatal = true;
    if (!(inList && rejected)) {
      for (const key of EVIDENCE_ARRAYS) {
        const ids = node[key];
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string' && catalogue.all.has(id)) cited.add(id);
      }
    }
    return { value: node, drop: inList && rejected };
  };

  const result = walk(output, '', false);
  if (mode === 'sanitise' && fatal) return { output: null, issues, stats, cited: [] };
  return { output: result.value as T, issues, stats, cited: [...cited] };
}

/** True when a `check` pass found something that must be repaired or removed. */
export function needsRepair(issues: GroundingIssue[]): boolean {
  return issues.some((i) => i.action === 'rejected');
}

/** Feedback handed back to the agent for its single repair attempt. */
export function repairFeedback(issues: GroundingIssue[]): string {
  const lines = issues
    .filter((i) => i.action === 'rejected')
    .slice(0, 20)
    .map((i) => `- ${i.path || '(root)'}: ${i.detail}`);
  return [
    'Your previous answer was not accepted. Problems found:',
    ...lines,
    'Return a corrected answer. Cite only IDs that appear in the context, label interpretations as "inference", do not state probabilities, and do not state or imply that a cause is confirmed.',
  ].join('\n');
}
