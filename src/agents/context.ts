/**
 * Investigation context - the only thing an agent is ever shown.
 *
 * It is a structured, bounded snapshot of what the deterministic engines already
 * hold about one incident: anomalies with their rules, signal readings with their
 * baselines, the relevant slice of the dependency graph, the rule-based hypotheses
 * and the projected impact. Agents get no tools and no access to the application;
 * they reason over this document and must cite IDs that appear in it.
 *
 * The schema is strict (unknown keys are rejected) and is validated again on the
 * server before any model call, so a client cannot smuggle free-form instructions
 * into a prompt through an unexpected field.
 */
import { z } from 'zod';

const Num = z.number();
const NumOrNull = z.number().nullable();

export const ContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  facility: z.strictObject({ name: z.string(), dataSource: z.string() }),
  incident: z.strictObject({
    id: z.string(),
    revision: Num,
    status: z.enum(['open', 'monitoring', 'resolved']),
    severity: z.enum(['advisory', 'warning', 'critical']),
    title: z.string(),
    openedAt: z.string(),
    ageS: Num,
    activeAnomalies: Num,
    assessmentFrozen: z.string().nullable(),
  }),
  assets: z
    .array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        category: z.string(),
        area: z.string(),
        role: z.enum(['affected', 'at_risk', 'context']),
        operatingState: z.enum(['running', 'standby', 'tripped']),
        health: z.enum(['nominal', 'advisory', 'warning', 'critical']),
        firstOnsetS: NumOrNull,
      }),
    )
    .max(64),
  anomalies: z
    .array(
      z.strictObject({
        id: z.string(),
        assetId: z.string(),
        signalId: z.string(),
        kind: z.string(),
        direction: z.string(),
        severity: z.enum(['advisory', 'warning', 'critical']),
        status: z.enum(['active', 'cleared']),
        onsetS: Num,
        detector: z.string(),
        rule: z.string(),
        unit: z.string(),
        valueAtDetection: Num,
        latest: Num,
        peak: Num,
        baselineMean: NumOrNull,
        baselineStd: NumOrNull,
      }),
    )
    .max(80),
  signals: z
    .array(
      z.strictObject({
        id: z.string(),
        assetId: z.string(),
        name: z.string(),
        unit: z.string(),
        latest: NumOrNull,
        baselineMean: NumOrNull,
        baselineStd: NumOrNull,
        zScore: NumOrNull,
        state: z.enum(['normal', 'abnormal', 'learning', 'not_analysed']),
        limits: z.string(),
      }),
    )
    .max(120),
  relations: z
    .array(z.strictObject({ id: z.string(), from: z.string(), to: z.string(), type: z.string(), medium: z.string() }))
    .max(80),
  correlations: z
    .array(
      z.strictObject({
        assetId: z.string(),
        linkedAssetId: z.string(),
        basis: z.string(),
        hops: Num,
        lagS: Num,
        path: z.string(),
      }),
    )
    .max(64),
  origin: z
    .strictObject({
      assetId: z.string(),
      score: Num,
      rationale: z.array(z.string()),
      alternatives: z.array(z.strictObject({ assetId: z.string(), score: Num })),
    })
    .nullable(),
  hypotheses: z
    .array(
      z.strictObject({
        key: z.string(),
        title: z.string(),
        focalAssetId: z.string(),
        mechanism: z.string(),
        supportPct: Num,
        band: z.enum(['weak', 'limited', 'moderate', 'strong']),
        criteria: z.array(
          z.strictObject({
            id: z.string(),
            role: z.enum(['supports', 'contradicts']),
            description: z.string(),
            weight: Num,
            observed: z.boolean(),
            detail: z.string(),
            anomalyIds: z.array(z.string()),
            signalIds: z.array(z.string()),
          }),
        ),
        unknowns: z.array(z.string()),
        verification: z.string(),
      }),
    )
    .max(12),
  impact: z
    .array(
      z.strictObject({
        assetId: z.string(),
        state: z.enum(['affected', 'at_risk']),
        exposurePct: Num,
        hops: Num,
        path: z.string(),
      }),
    )
    .max(64),
  deterministicChecks: z.array(z.string()).max(16),
  /** Cyber evidence and the deterministic cyber-physical assessment; null when the source has no security telemetry. */
  cyber: z
    .strictObject({
      standing: z.string(),
      headline: z.string(),
      links: z.array(z.strictObject({ eventId: z.string(), relation: z.string(), leadS: Num })).max(20),
      explanations: z
        .array(
          z.strictObject({
            key: z.string(),
            title: z.string(),
            status: z.enum(['supported', 'possible', 'not_supported']),
            criteria: z.array(z.strictObject({ description: z.string(), observed: z.boolean(), evidence: z.array(z.string()) })),
          }),
        )
        .max(6),
      unknowns: z.array(z.string()).max(10),
      events: z
        .array(
          z.strictObject({
            id: z.string(),
            onsetS: Num,
            ruleId: z.string(),
            category: z.string(),
            severity: z.string(),
            title: z.string(),
            source: z.string().nullable(),
            destination: z.string().nullable(),
            identity: z.string().nullable(),
            deviceIds: z.array(z.string()),
            parameterId: z.string().nullable(),
            changeRecordId: z.string().nullable(),
            rationale: z.string(),
            attackContext: z.array(z.string()),
          }),
        )
        .max(40),
      devices: z.array(z.strictObject({ id: z.string(), name: z.string(), kind: z.string(), zone: z.string(), controls: z.array(z.string()) })).max(24),
    })
    .nullable(),
});

export type InvestigationContext = z.infer<typeof ContextSchema>;

export type EvidenceKind = 'anomaly' | 'signal' | 'asset' | 'hypothesis' | 'relation' | 'cyber_event';

/** Every ID an agent is allowed to cite, by kind. */
export interface EvidenceCatalogue {
  anomalies: Set<string>;
  signals: Set<string>;
  assets: Set<string>;
  hypotheses: Set<string>;
  relations: Set<string>;
  cyberEvents: Set<string>;
  all: Set<string>;
}

export function catalogueOf(ctx: InvestigationContext): EvidenceCatalogue {
  const anomalies = new Set(ctx.anomalies.map((a) => a.id));
  const signals = new Set(ctx.signals.map((s) => s.id));
  // OT devices are assets too: an agent may name PLC-500 as it would name CT-401.
  const assets = new Set([...ctx.assets.map((a) => a.id), ...(ctx.cyber?.devices.map((d) => d.id) ?? [])]);
  const hypotheses = new Set(ctx.hypotheses.map((h) => h.key));
  const relations = new Set(ctx.relations.map((r) => r.id));
  const cyberEvents = new Set(ctx.cyber?.events.map((e) => e.id) ?? []);
  return { anomalies, signals, assets, hypotheses, relations, cyberEvents, all: new Set([...anomalies, ...signals, ...assets, ...hypotheses, ...relations, ...cyberEvents]) };
}

export function evidenceKind(id: string, cat: EvidenceCatalogue): EvidenceKind | null {
  if (cat.anomalies.has(id)) return 'anomaly';
  if (cat.signals.has(id)) return 'signal';
  if (cat.cyberEvents.has(id)) return 'cyber_event';
  if (cat.assets.has(id)) return 'asset';
  if (cat.hypotheses.has(id)) return 'hypothesis';
  if (cat.relations.has(id)) return 'relation';
  return null;
}

/** Stable identity of the evidence a context was built from - used to detect staleness. */
export function evidenceSignature(anomalyIds: string[]): string {
  return [...anomalyIds].sort().join(',');
}
