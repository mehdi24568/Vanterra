/**
 * Asset Graph Engine - typed operational dependency graph.
 *
 * Nodes are assets, edges are directed dependencies (`from` supplies or acts on `to`).
 * A plain in-memory adjacency structure is all a single facility needs; the public
 * surface is small enough to be re-implemented over a graph store later.
 */
import type { AssetDefinition, AssetRelation, PathStep, RelationType } from '../core/types';

export interface Neighbour {
  assetId: string;
  relation: AssetRelation;
  direction: 'downstream' | 'upstream';
}

export interface PathQuery {
  maxHops: number;
  /**
   * May a path pass *through* this asset from one of its consumers to another
   * (consumer <- supplier -> other consumer)? Two machines that merely share a
   * switchboard are not related evidence unless the switchboard itself is implicated.
   */
  allowSiblingVia: (assetId: string) => boolean;
  /**
   * The mirror case: may a path pass through this asset from one of its suppliers
   * to another (supplier -> consumer <- other supplier)? Defaults to allowed.
   * Two things that feed the same machine are not related evidence unless that
   * machine is itself abnormal.
   */
  allowConvergeVia?: (assetId: string) => boolean;
  /**
   * Optional veto on ending the path at a target. `arrival` is the direction of the
   * final step: 'upstream' means the target *supplies* the asset before it.
   */
  acceptTarget?: (assetId: string, arrival: 'downstream' | 'upstream', hops: number, path: PathStep[]) => boolean;
  /** Optional restriction on which relations a path may use at all. */
  allowRelation?: (relation: AssetRelation) => boolean;
  /**
   * When true the path may not move from one fluid circuit to another (process,
   * cooling water, utilities). A heat exchanger passes heat between circuits, but not
   * pressure, flow or level.
   */
  fluidBound?: boolean;
}

const FLUID_TYPES = new Set(['process', 'cooling', 'utility']);

export interface Reach {
  exposure: number;
  hops: number;
  path: PathStep[];
}

type Dir = 'n' | 'u' | 'd';

export class AssetGraph {
  readonly assets: AssetDefinition[];
  readonly relations: AssetRelation[];
  private byId = new Map<string, AssetDefinition>();
  private out = new Map<string, AssetRelation[]>();
  private inc = new Map<string, AssetRelation[]>();

  constructor(assets: AssetDefinition[], relations: AssetRelation[]) {
    this.assets = assets;
    for (const a of assets) {
      this.byId.set(a.id, a);
      this.out.set(a.id, []);
      this.inc.set(a.id, []);
    }
    const valid: AssetRelation[] = [];
    for (const r of relations) {
      if (!this.byId.has(r.from) || !this.byId.has(r.to)) {
        // A dangling relation is a data-quality problem in the asset model, not a reason to crash.
        console.warn(`[graph] relation ${r.id} references unknown asset (${r.from} -> ${r.to}); ignored`);
        continue;
      }
      this.out.get(r.from)!.push(r);
      this.inc.get(r.to)!.push(r);
      valid.push(r);
    }
    this.relations = valid;
  }

  asset(id: string): AssetDefinition | undefined {
    return this.byId.get(id);
  }

  outgoing(id: string): AssetRelation[] {
    return this.out.get(id) ?? [];
  }

  incoming(id: string): AssetRelation[] {
    return this.inc.get(id) ?? [];
  }

  neighbours(id: string): Neighbour[] {
    const res: Neighbour[] = [];
    for (const r of this.outgoing(id)) res.push({ assetId: r.to, relation: r, direction: 'downstream' });
    for (const r of this.incoming(id)) res.push({ assetId: r.from, relation: r, direction: 'upstream' });
    return res;
  }

  /** Assets that supply `id`, optionally restricted to one relation type. */
  suppliers(id: string, type?: RelationType): string[] {
    return this.incoming(id)
      .filter((r) => !type || r.type === type)
      .map((r) => r.from);
  }

  /** Assets supplied by `id`, optionally restricted to one relation type. */
  consumers(id: string, type?: RelationType): string[] {
    return this.outgoing(id)
      .filter((r) => !type || r.type === type)
      .map((r) => r.to);
  }

  /** Number of assets with at least one relation. */
  connectedCount(): number {
    let n = 0;
    for (const a of this.assets) if (this.outgoing(a.id).length + this.incoming(a.id).length > 0) n += 1;
    return n;
  }

  /**
   * Shortest dependency path from `from` to the nearest member of `targets`
   * (breadth-first, edges walked in either direction, sibling rule applied).
   */
  findPath(from: string, targets: ReadonlySet<string>, query: PathQuery): { target: string; path: PathStep[] } | null {
    if (!this.byId.has(from)) return null;
    if (targets.has(from)) return { target: from, path: [] };
    // With fluidBound, the circuit a path is in is part of the search state.
    const key = (id: string, dir: Dir, fluid: string) => `${id}|${dir}|${query.fluidBound ? fluid : ''}`;
    const parent = new Map<string, { prev: string; step: PathStep } | null>();
    let frontier: Array<{ id: string; dir: Dir; fluid: string }> = [{ id: from, dir: 'n', fluid: '' }];
    parent.set(key(from, 'n', ''), null);

    for (let depth = 0; depth < query.maxHops && frontier.length > 0; depth++) {
      const next: Array<{ id: string; dir: Dir; fluid: string }> = [];
      for (const cur of frontier) {
        for (const nb of this.neighbours(cur.id)) {
          if (query.allowRelation && !query.allowRelation(nb.relation)) continue;
          const isFluid = FLUID_TYPES.has(nb.relation.type);
          if (query.fluidBound && isFluid && cur.fluid && cur.fluid !== nb.relation.type) continue;
          const fluid = isFluid ? nb.relation.type : cur.fluid;
          const dir: Dir = nb.direction === 'downstream' ? 'd' : 'u';
          if (cur.dir === 'u' && dir === 'd' && !query.allowSiblingVia(cur.id)) continue;
          if (cur.dir === 'd' && dir === 'u' && query.allowConvergeVia && !query.allowConvergeVia(cur.id)) continue;
          const k = key(nb.assetId, dir, fluid);
          if (parent.has(k)) continue;
          const step: PathStep = {
            from: cur.id,
            to: nb.assetId,
            relationId: nb.relation.id,
            relation: nb.relation.type,
            medium: nb.relation.medium,
            direction: nb.direction,
          };
          parent.set(k, { prev: key(cur.id, cur.dir, cur.fluid), step });
          if (targets.has(nb.assetId)) {
            const path: PathStep[] = [];
            let walk = parent.get(k);
            while (walk) {
              path.unshift(walk.step);
              walk = parent.get(walk.prev) ?? null;
            }
            if (!query.acceptTarget || query.acceptTarget(nb.assetId, nb.direction, depth + 1, path)) return { target: nb.assetId, path };
          }
          next.push({ id: nb.assetId, dir, fluid });
        }
      }
      frontier = next;
    }
    return null;
  }

  /**
   * Forward propagation of a disturbance from `origin`, attenuated per hop and when
   * the carrying medium changes. Process upsets barely load a cooling circuit that is
   * sized for them, so crossing *into* cooling water is attenuated much harder than
   * a utility problem crossing into the process it serves.
   */
  propagate(origin: string, minExposure = 0.25): Map<string, Reach> {
    const best = new Map<string, Reach>();
    if (!this.byId.has(origin)) return best;
    type Item = { id: string; exposure: number; hops: number; path: PathStep[]; medium: string | null };
    const queue: Item[] = [{ id: origin, exposure: 1, hops: 0, path: [], medium: null }];
    while (queue.length > 0) {
      queue.sort((a, b) => b.exposure - a.exposure);
      const cur = queue.shift()!;
      for (const r of this.outgoing(cur.id)) {
        if (r.to === origin) continue;
        let factor = 0.85;
        if (cur.medium && cur.medium !== r.medium) factor *= r.medium === 'cooling water' ? 0.3 : 0.9;
        const exposure = cur.exposure * factor;
        if (exposure < minExposure) continue;
        const known = best.get(r.to);
        if (known && known.exposure >= exposure) continue;
        const step: PathStep = {
          from: cur.id,
          to: r.to,
          relationId: r.id,
          relation: r.type,
          medium: r.medium,
          direction: 'downstream',
        };
        const reach: Reach = { exposure, hops: cur.hops + 1, path: [...cur.path, step] };
        best.set(r.to, reach);
        queue.push({ id: r.to, exposure, hops: reach.hops, path: reach.path, medium: r.medium });
      }
    }
    return best;
  }

  /**
   * Assets whose behaviour could plausibly be influenced by `origin`:
   * everything downstream, plus load reflected *up* mechanical and electrical
   * supply chains (a struggling pump raises its motor's current, and so on up).
   */
  influenceReach(origin: string): Set<string> {
    const seen = new Set<string>();
    const visited = new Set<string>();
    const queue: Array<{ id: string; reflected: boolean }> = [{ id: origin, reflected: false }];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const k = `${cur.id}|${cur.reflected ? 1 : 0}`;
      if (visited.has(k)) continue;
      visited.add(k);
      if (cur.id !== origin) seen.add(cur.id);
      if (!cur.reflected) for (const r of this.outgoing(cur.id)) queue.push({ id: r.to, reflected: false });
      for (const r of this.incoming(cur.id)) {
        if (r.type === 'mechanical' || r.type === 'electrical') queue.push({ id: r.from, reflected: true });
      }
    }
    seen.delete(origin);
    return seen;
  }
}
