/**
 * OT layer for the spatial view.
 *
 * Controllers are drawn as cabinets in the plant areas they serve, the control-room
 * hosts beside the electrical room, and two kinds of link:
 *   - control links (dashed): a controller to each machine it controls, exactly as
 *     declared in the OT model - nothing inferred;
 *   - network links (solid): the switched network between devices that have a place.
 * A device with a recent cyber event takes that event's severity colour. Control links
 * to machines in the focused incident are drawn at full strength.
 */
import * as THREE from 'three';
import type { FacilityModel, Severity } from '../core/types';
import type { OtDevice, OtModel } from '../cyber/types';
import type { SceneFeed } from './types';

const CYBER = new THREE.Color('#5e9bff');
const NETWORK = new THREE.Color('#3d4c60');
const CABINET = new THREE.Color('#141b25');
const SEVERITY: Record<Severity, THREE.Color> = {
  advisory: new THREE.Color('#e5b94e'),
  warning: new THREE.Color('#ec8a3c'),
  critical: new THREE.Color('#e5484d'),
};

function label(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(10, 14, 20, 0.86)';
  g.fillRect(0, 8, 256, 48);
  g.strokeStyle = 'rgba(94, 155, 255, 0.7)';
  g.lineWidth = 2;
  g.strokeRect(1, 9, 254, 46);
  g.fillStyle = '#d6e2f2';
  g.font = '600 26px "JetBrains Mono", Consolas, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(5.2, 1.3, 1);
  return sprite;
}

interface DeviceVisual {
  device: OtDevice;
  edgeMat: THREE.LineBasicMaterial;
}

interface ControlVisual {
  plcId: string;
  assetId: string;
  mat: THREE.LineDashedMaterial;
}

export class OtLayer {
  readonly group = new THREE.Group();
  private devices = new Map<string, DeviceVisual>();
  private controls: ControlVisual[] = [];

  constructor(model: OtModel, facility: FacilityModel) {
    this.group.visible = false;
    const top = (d: OtDevice) => new THREE.Vector3(d.position!.x, d.kind === 'plc' ? 2.8 : 1.8, d.position!.z);
    const placed = model.devices.filter((d) => d.position);

    for (const d of placed) {
      const isPlc = d.kind === 'plc';
      const size = isPlc ? [1.6, 2.8, 1.0] : d.kind === 'switch' ? [1.6, 0.6, 1.0] : [1.6, 1.8, 1.1];
      const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
      geo.translate(0, size[1] / 2, 0);
      const body = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: CABINET }));
      const edgeMat = new THREE.LineBasicMaterial({ color: CYBER.clone().multiplyScalar(0.8) });
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
      const holder = new THREE.Group();
      holder.position.set(d.position!.x, d.position!.y, d.position!.z);
      holder.add(body, edges);
      if (d.kind !== 'switch') {
        const tag = label(d.id);
        tag.position.set(0, size[1] + 1.1, 0);
        holder.add(tag);
      }
      this.group.add(holder);
      this.devices.set(d.id, { device: d, edgeMat });
    }

    // Control links: declared relationships only.
    const byId = new Map(facility.assets.map((a) => [a.id, a]));
    for (const c of model.controls) {
      const plc = placed.find((d) => d.id === c.plcId);
      const asset = byId.get(c.assetId);
      if (!plc || !asset || c.kind !== 'controls') continue;
      const from = top(plc);
      const to = new THREE.Vector3(asset.position.x, Math.max(2.2, asset.position.y + 1.8), asset.position.z);
      const mid = from.clone().lerp(to, 0.5);
      mid.y += 2.2;
      const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(24));
      const mat = new THREE.LineDashedMaterial({ color: CYBER, dashSize: 0.55, gapSize: 0.4, transparent: true, opacity: 0.35 });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      this.group.add(line);
      this.controls.push({ plcId: c.plcId, assetId: c.assetId, mat });
    }

    // Network links between devices that have a place in the scene.
    const pts: THREE.Vector3[] = [];
    for (const l of model.links) {
      const a = placed.find((d) => d.id === l.from);
      const b = placed.find((d) => d.id === l.to);
      if (!a || !b) continue;
      pts.push(new THREE.Vector3(a.position!.x, 0.12, a.position!.z), new THREE.Vector3(b.position!.x, 0.12, b.position!.z));
    }
    const net = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: NETWORK }));
    this.group.add(net);
  }

  /** Called a few times per second. */
  sync(feed: SceneFeed, focusAssets: ReadonlySet<string> | null, selectedAssetId: string | null): void {
    this.group.visible = feed.view.layers.ot;
    if (!this.group.visible) return;
    const severity = new Map<string, Severity | null>();
    for (const [id, v] of this.devices) {
      const s = feed.otSeverity(id);
      severity.set(id, s);
      v.edgeMat.color.copy(s ? SEVERITY[s] : CYBER).multiplyScalar(s ? 1 : 0.8);
    }
    for (const c of this.controls) {
      const s = severity.get(c.plcId) ?? null;
      const inFocus = !!focusAssets?.has(c.assetId) || selectedAssetId === c.assetId;
      c.mat.color.copy(s && inFocus ? SEVERITY[s] : CYBER);
      c.mat.opacity = inFocus ? 0.95 : s ? 0.6 : 0.3;
    }
  }
}
