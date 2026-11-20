/**
 * Procedural equipment geometry.
 *
 * Every asset is modelled from a handful of primitives, merged into one geometry
 * (one draw call for surfaces, one for edges). Dimensions are in metres and chosen
 * so that connection points - nozzles, shafts, flanges - line up with the pipe
 * routes and neighbouring machines defined in the facility model.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AssetDefinition, AssetModelSpec, Vec3 } from '../core/types';

type Axis = 'x' | 'y' | 'z';

class GeoBuilder {
  private parts: THREE.BufferGeometry[] = [];

  box(w: number, h: number, d: number, x: number, y: number, z: number): this {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    this.parts.push(g);
    return this;
  }

  /** Cylinder / cone along an axis. `rEnd` is the radius at the positive end of the axis. */
  cyl(rEnd: number, rStart: number, len: number, x: number, y: number, z: number, axis: Axis = 'y', seg = 20): this {
    const g = new THREE.CylinderGeometry(rEnd, rStart, len, seg, 1);
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.parts.push(g);
    return this;
  }

  sphere(r: number, x: number, y: number, z: number): this {
    const g = new THREE.SphereGeometry(r, 14, 10);
    g.translate(x, y, z);
    this.parts.push(g);
    return this;
  }

  /** Straight tube between two arbitrary points. */
  tube(a: Vec3, b: Vec3, r: number, seg = 14): this {
    const from = new THREE.Vector3(a.x, a.y, a.z);
    const to = new THREE.Vector3(b.x, b.y, b.z);
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 1e-4) return this;
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
    const mid = from.add(to).multiplyScalar(0.5);
    g.translate(mid.x, mid.y, mid.z);
    this.parts.push(g);
    return this;
  }

  build(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    if (!merged) throw new Error('Failed to merge asset geometry');
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }
}

// ----------------------------------------------------------------- models ---

function tank(b: GeoBuilder, r: number, h: number): void {
  const base = 0.3;
  b.cyl(r + 0.28, r + 0.28, base, 0, base / 2, 0, 'y', 36)
    .cyl(r, r, h, 0, base + h / 2, 0, 'y', 36)
    .cyl(r * 0.1, r + 0.04, r * 0.28, 0, base + h + r * 0.14, 0, 'y', 36)
    .cyl(r + 0.07, r + 0.07, 0.14, 0, base + h * 0.33, 0, 'y', 36)
    .cyl(r + 0.07, r + 0.07, 0.14, 0, base + h * 0.66, 0, 'y', 36)
    .cyl(r + 0.1, r + 0.1, 0.2, 0, base + h - 0.1, 0, 'y', 36)
    .cyl(0.32, 0.32, 0.9, r + 0.3, 1.2, 0, 'x', 14)
    .cyl(0.46, 0.46, 0.1, r + 0.72, 1.2, 0, 'x', 14)
    .box(0.55, h, 0.1, 0, base + h / 2, r + 0.1)
    .box(1.3, 0.08, 1.1, 0, base + h + 0.04, r + 0.45)
    .cyl(0.22, 0.22, 0.55, r * 0.45, base + h + r * 0.2 + 0.2, 0, 'y', 12)
    .cyl(0.5, 0.5, 0.25, -r * 0.4, base + h + r * 0.2, -r * 0.3, 'y', 14);
}

function pump(b: GeoBuilder): void {
  b.box(1.9, 0.25, 4.0, 0, 0.125, -0.4)
    .box(1.1, 0.7, 0.9, 0, 0.6, 0)
    .cyl(1.0, 1.0, 0.7, 0, 1.2, 0, 'z', 28)
    .cyl(0.62, 0.62, 0.25, 0, 1.2, 0.45, 'z', 20)
    .cyl(0.38, 0.38, 1.0, 0, 1.2, 1.05, 'z', 16)
    .cyl(0.52, 0.52, 0.12, 0, 1.2, 1.55, 'z', 16)
    .cyl(0.3, 0.3, 0.5, 0, 2.0, 0, 'y', 16)
    .cyl(0.46, 0.46, 0.12, 0, 2.2, 0, 'y', 16)
    .cyl(0.42, 0.42, 1.2, 0, 1.2, -0.95, 'z', 16)
    .box(0.7, 0.75, 0.9, 0, 0.62, -1.0)
    .cyl(0.12, 0.12, 0.9, 0, 1.2, -1.95, 'z', 10)
    .box(0.62, 0.5, 0.7, 0, 1.25, -1.95);
}

function motor(b: GeoBuilder, s: number, shaftY: number, vertical: boolean): void {
  const L = 2.2 * s;
  const R = 0.7 * s;
  if (vertical) {
    const y0 = 0.3;
    b.cyl(R * 1.25, R * 1.25, y0, 0, y0 / 2, 0, 'y', 24).cyl(R, R, L, 0, y0 + L / 2, 0, 'y', 24);
    for (let i = -2; i <= 2; i++) b.cyl(R + 0.07 * s, R + 0.07 * s, 0.07 * s, 0, y0 + L / 2 + i * 0.36 * s, 0, 'y', 24);
    b.cyl(R * 0.8, R * 1.02, 0.42 * s, 0, y0 + L + 0.21 * s, 0, 'y', 24).box(0.42 * s, 0.75 * s, 0.62 * s, R + 0.2 * s, y0 + L / 2, 0);
    return;
  }
  b.cyl(R, R, L, 0, shaftY, 0, 'z', 24);
  for (let i = -2; i <= 2; i++) b.cyl(R + 0.07 * s, R + 0.07 * s, 0.07 * s, 0, shaftY, i * 0.36 * s, 'z', 24);
  const pedestal = Math.max(0.14, shaftY - R * 0.85);
  b.cyl(R * 1.02, R * 0.8, 0.45 * s, 0, shaftY, -(L / 2 + 0.22 * s), 'z', 24)
    .cyl(0.14 * s, 0.14 * s, 0.34 * s, 0, shaftY, L / 2 + 0.17 * s, 'z', 10)
    .box(0.62 * s, 0.42 * s, 0.78 * s, 0, shaftY + R + 0.18 * s, 0.1 * s)
    .box(1.5 * s, pedestal, 1.75 * s, 0, pedestal / 2, 0);
}

function pipeline(b: GeoBuilder, paths: Vec3[][], r: number): void {
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const c = path[i + 1];
      b.tube(a, c, r);
      // Supports under long elevated horizontal runs.
      const horizontal = Math.abs(a.y - c.y) < 1e-3;
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      if (horizontal && a.y >= 2.5 && len >= 4) {
        const n = Math.max(1, Math.round(len / 6));
        for (let k = 0; k < n; k++) {
          const f = (k + 0.5) / n;
          const px = a.x + (c.x - a.x) * f;
          const pz = a.z + (c.z - a.z) * f;
          b.box(0.16, a.y - r, 0.16, px, (a.y - r) / 2, pz).box(0.5, 0.08, 0.5, px, 0.04, pz).box(0.5, 0.08, 0.3, px, a.y - r - 0.04, pz);
        }
      }
    }
    for (let i = 1; i < path.length - 1; i++) b.sphere(r * 1.18, path[i].x, path[i].y, path[i].z);
    // Flanges at both ends.
    for (const [end, next] of [
      [path[0], path[1]],
      [path[path.length - 1], path[path.length - 2]],
    ] as Array<[Vec3, Vec3]>) {
      const d = new THREE.Vector3(next.x - end.x, next.y - end.y, next.z - end.z).normalize().multiplyScalar(0.14);
      b.tube(end, { x: end.x + d.x, y: end.y + d.y, z: end.z + d.z }, r * 1.5);
    }
  }
}

function heatExchanger(b: GeoBuilder): void {
  b.cyl(1.1, 1.1, 5.2, 0, 1.8, 0, 'x', 28)
    .cyl(1.22, 1.22, 0.16, -2.6, 1.8, 0, 'x', 28)
    .cyl(1.22, 1.22, 0.16, 2.6, 1.8, 0, 'x', 28)
    .cyl(1.1, 1.1, 0.7, -3.03, 1.8, 0, 'x', 28)
    .cyl(1.1, 0.6, 0.4, -3.58, 1.8, 0, 'x', 28)
    .cyl(1.1, 1.1, 0.5, 2.93, 1.8, 0, 'x', 28)
    .cyl(0.6, 1.1, 0.4, 3.38, 1.8, 0, 'x', 28)
    .box(0.35, 0.75, 1.9, -1.6, 0.375, 0)
    .box(0.35, 0.75, 1.9, 1.6, 0.375, 0)
    .cyl(0.3, 0.3, 0.5, -2.2, 3.05, 0, 'y', 14)
    .cyl(0.42, 0.42, 0.1, -2.2, 3.3, 0, 'y', 14)
    .cyl(0.3, 0.3, 0.5, 2.2, 3.05, 0, 'y', 14)
    .cyl(0.42, 0.42, 0.1, 2.2, 3.3, 0, 'y', 14)
    .cyl(0.3, 0.3, 0.7, 1.5, 1.8, 1.35, 'z', 14)
    .cyl(0.3, 0.3, 0.7, -1.5, 1.8, -1.35, 'z', 14);
}

function reactor(b: GeoBuilder, r: number, h: number): void {
  const shell = h - 1.7;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(0.4, 1.7, 0.4, sx * r * 0.72, 0.85, sz * r * 0.72);
  b.cyl(r, r * 0.42, 0.9, 0, 1.25, 0, 'y', 36)
    .cyl(r, r, shell, 0, 1.7 + shell / 2, 0, 'y', 36)
    .cyl(r * 0.42, r, 0.8, 0, h + 0.4, 0, 'y', 36)
    .cyl(r + 0.14, r + 0.14, shell * 0.55, 0, 1.7 + shell * 0.4, 0, 'y', 36)
    .cyl(r + 0.9, r + 0.9, 0.1, 0, h * 0.72, 0, 'y', 36)
    .cyl(r + 0.9, r + 0.9, 0.05, 0, h * 0.72 + 1.05, 0, 'y', 36)
    .cyl(0.3, 0.3, 0.6, 0, 0.75, 0, 'y', 14)
    .cyl(0.36, 0.36, 0.6, r * 0.55, h + 0.75, 0, 'y', 14)
    .box(0.12, h * 0.72, 0.55, r + 0.84, h * 0.36, 0);
}

function filler(b: GeoBuilder): void {
  b.box(4.4, 0.9, 3.8, 0, 0.45, 0)
    .cyl(1.6, 1.6, 1.5, -0.4, 1.65, 0, 'y', 28)
    .cyl(1.75, 1.75, 0.2, -0.4, 2.5, 0, 'y', 28)
    .cyl(0.95, 0.5, 1.0, -0.4, 3.1, 0, 'y', 20)
    .cyl(1.0, 1.0, 0.25, -0.4, 3.72, 0, 'y', 20)
    .cyl(0.55, 0.55, 0.25, 1.5, 1.03, 0.9, 'y', 16)
    .cyl(0.55, 0.55, 0.25, 1.5, 1.03, -0.9, 'y', 16)
    .box(0.7, 2.0, 1.1, -1.75, 1.9, 1.25);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(0.1, 2.3, 0.1, sx * 2.1, 2.05, sz * 1.8);
  b.box(4.3, 0.1, 0.1, 0, 3.2, 1.8).box(4.3, 0.1, 0.1, 0, 3.2, -1.8).box(0.1, 0.1, 3.7, 2.1, 3.2, 0).box(0.1, 0.1, 3.7, -2.1, 3.2, 0);
}

function conveyor(b: GeoBuilder, L: number): void {
  b.box(L, 0.16, 0.1, 0, 0.95, 0.56)
    .box(L, 0.16, 0.1, 0, 0.95, -0.56)
    .box(L - 0.3, 0.05, 1.0, 0, 1.04, 0)
    .cyl(0.2, 0.2, 1.1, L / 2 - 0.1, 0.95, 0, 'z', 16)
    .cyl(0.2, 0.2, 1.1, -(L / 2 - 0.1), 0.95, 0, 'z', 16)
    .box(L, 0.04, 0.04, 0, 1.42, 0.5)
    .box(L, 0.04, 0.04, 0, 1.42, -0.5)
    .box(0.5, 0.5, 0.62, 0, 0.72, 0.95);
  const rollers = Math.floor(L / 1.25);
  for (let i = 0; i < rollers; i++) b.cyl(0.07, 0.07, 1.05, -L / 2 + 0.8 + i * 1.25, 0.9, 0, 'z', 8);
  const legs = Math.max(2, Math.round(L / 2.4));
  for (let i = 0; i <= legs; i++) {
    const x = -L / 2 + 0.2 + (i * (L - 0.4)) / legs;
    b.box(0.1, 0.9, 0.1, x, 0.45, 0.56).box(0.1, 0.9, 0.1, x, 0.45, -0.56).box(0.08, 0.08, 1.12, x, 0.3, 0);
    b.box(0.04, 0.42, 0.04, x, 1.22, 0.5).box(0.04, 0.42, 0.04, x, 1.22, -0.5);
  }
  // Product units on the belt.
  const units = Math.floor(L / 1.1);
  for (let i = 0; i < units; i++) b.box(0.34, 0.42, 0.34, -L / 2 + 0.7 + i * 1.1, 1.28, 0);
}

function packer(b: GeoBuilder): void {
  b.box(5, 0.5, 3.2, 0, 0.25, 0).box(5, 0.14, 3.2, 0, 2.95, 0).box(3.4, 1.3, 2.0, -0.3, 1.15, 0).box(1.3, 1.7, 1.5, 0.6, 1.35, -2.1);
  b.box(1.0, 0.5, 1.4, 1.9, 0.95, 0).box(0.6, 1.9, 0.9, 2.1, 1.45, 1.95);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(0.14, 2.4, 0.14, sx * 2.4, 1.7, sz * 1.5);
}

function palletiser(b: GeoBuilder): void {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(0.22, 5, 0.22, sx * 2.2, 2.5, sz * 1.9);
  b.box(4.6, 0.25, 0.25, 0, 5, 1.9)
    .box(4.6, 0.25, 0.25, 0, 5, -1.9)
    .box(0.25, 0.25, 4.0, 2.2, 5, 0)
    .box(0.25, 0.25, 4.0, -2.2, 5, 0)
    .box(0.3, 0.3, 4.0, -0.3, 4.6, 0)
    .box(0.25, 1.2, 0.25, -0.3, 4.0, 0)
    .box(1.6, 0.4, 1.6, -0.3, 3.3, 0)
    .box(1.3, 0.1, 1.3, -0.3, 3.0, 0)
    .box(2.2, 0.4, 1.4, -0.3, 0.2, 0)
    .box(1.3, 0.15, 1.1, -0.3, 0.48, 0)
    .box(2.6, 0.4, 1.4, 2.4, 0.2, 0)
    .box(1.5, 0.9, 1.2, -2.2, 0.45, 0)
    .box(0.6, 2.0, 1.0, 2.3, 1.0, 2.5);
  for (let i = 0; i < 3; i++) b.box(1.2, 0.48, 1.0, -0.3, 0.8 + i * 0.5, 0);
}

function coolingTower(b: GeoBuilder): void {
  b.box(7.6, 0.9, 7.6, 0, 0.45, 0).box(7, 5.4, 7, 0, 3.6, 0).box(7.2, 0.2, 7.2, 0, 6.4, 0);
  for (const y of [1.6, 2.3, 3.0]) b.box(7.16, 0.12, 7.16, 0, y, 0);
  b.cyl(2.6, 2.3, 1.7, 0, 7.35, 0, 'y', 32)
    .cyl(0.35, 0.35, 0.5, 0, 6.9, 0, 'y', 14)
    .box(4.4, 0.08, 0.36, 0, 7.05, 0)
    .box(0.36, 0.08, 4.4, 0, 7.05, 0)
    .box(0.9, 0.7, 1.3, 2.9, 6.85, 2.9)
    .box(0.5, 5.6, 0.1, -3.55, 3.7, 2.4)
    .cyl(0.34, 0.34, 0.5, -3.7, 1.2, 0, 'x', 14)
    .cyl(0.32, 0.32, 0.3, 0, 5.6, -3.6, 'z', 14);
}

function chiller(b: GeoBuilder): void {
  b.box(6, 0.25, 2.8, 0, 0.125, 0).cyl(0.72, 0.72, 5.0, 0, 1.1, -0.75, 'x', 24).cyl(0.72, 0.72, 5.0, 0, 1.1, 0.75, 'x', 24);
  for (const sx of [-1, 1]) {
    b.cyl(0.8, 0.8, 0.16, sx * 2.5, 1.1, -0.75, 'x', 24).cyl(0.8, 0.8, 0.16, sx * 2.5, 1.1, 0.75, 'x', 24).box(0.3, 0.5, 2.6, sx * 1.8, 0.5, 0);
  }
  b.cyl(0.62, 0.62, 2.2, -0.9, 2.55, 0, 'x', 20)
    .cyl(0.5, 0.5, 1.5, 1.0, 2.55, 0, 'x', 20)
    .box(0.9, 0.5, 0.9, -0.9, 1.95, 0)
    .box(0.45, 1.7, 1.3, 2.75, 1.1, 0)
    .cyl(0.3, 0.3, 0.6, 1.6, 1.1, -1.55, 'z', 14)
    .cyl(0.3, 0.3, 0.6, -1.6, 1.1, -1.55, 'z', 14);
}

function transformer(b: GeoBuilder): void {
  b.box(4.2, 0.3, 3.2, 0, 0.15, 0).box(3.0, 2.6, 1.9, 0, 1.6, 0).box(3.2, 0.12, 2.1, 0, 2.96, 0);
  for (let i = -3; i <= 3; i++) b.box(0.1, 2.0, 0.7, i * 0.42, 1.55, 1.32).box(0.1, 2.0, 0.7, i * 0.42, 1.55, -1.32);
  b.cyl(0.42, 0.42, 2.4, 0, 3.95, -0.5, 'x', 18).box(0.12, 0.75, 0.12, 0.9, 3.4, -0.5).box(0.12, 0.75, 0.12, -0.9, 3.4, -0.5);
  for (let i = -1; i <= 1; i++) b.cyl(0.09, 0.16, 0.9, i * 0.7, 3.45, 0.45, 'y', 12).cyl(0.2, 0.2, 0.08, i * 0.7, 3.55, 0.45, 'y', 12);
  b.box(0.9, 1.2, 0.5, 1.95, 1.6, 0);
}

function switchgear(b: GeoBuilder, n: number): void {
  b.box(n + 0.2, 0.2, 1.0, 0, 0.1, 0).box(n, 0.22, 0.45, 0, 2.51, -0.15);
  for (let i = 0; i < n; i++) {
    const x = i - (n - 1) / 2;
    b.box(0.96, 2.2, 0.85, x, 1.3, 0).box(0.06, 0.3, 0.05, x + 0.32, 1.4, 0.45);
    if (i === 0) b.box(0.45, 0.32, 0.04, x, 1.95, 0.44);
    else b.box(0.7, 0.04, 0.03, x, 1.75, 0.44).box(0.7, 0.04, 0.03, x, 0.95, 0.44);
  }
}

function lubeSkid(b: GeoBuilder): void {
  b.box(3.0, 0.22, 2.0, 0, 0.11, 0)
    .box(1.7, 1.0, 1.3, -0.5, 0.72, 0.1)
    .cyl(0.26, 0.26, 0.9, 0.95, 0.6, 0.5, 'x', 14)
    .cyl(0.2, 0.2, 0.4, 0.3, 0.6, 0.5, 'x', 12)
    .cyl(0.22, 0.22, 1.5, -0.4, 1.5, -0.2, 'x', 14)
    .cyl(0.17, 0.17, 0.75, 0.9, 0.6, -0.5, 'y', 12)
    .cyl(0.17, 0.17, 0.75, 1.25, 0.6, -0.5, 'y', 12)
    .box(0.4, 0.7, 0.2, -1.15, 1.57, 0.55);
}

function compressor(b: GeoBuilder): void {
  b.box(3.2, 2.1, 2.0, 0, 1.05, 0)
    .box(3.0, 0.1, 1.8, 0, 2.15, 0)
    .box(1.0, 0.6, 0.06, -0.7, 1.5, 1.02)
    .box(0.6, 0.9, 0.06, 0.9, 1.2, 1.02)
    .cyl(0.8, 0.8, 2.4, 2.8, 1.5, 0, 'y', 24)
    .cyl(0.4, 0.8, 0.35, 2.8, 2.875, 0, 'y', 24)
    .cyl(0.8, 0.45, 0.3, 2.8, 0.15, 0, 'y', 24)
    .cyl(0.1, 0.1, 1.0, 2.0, 2.3, 0, 'x', 10);
}

/**
 * Build the merged geometry for an asset.
 * Pipelines are authored in world coordinates; everything else in local coordinates
 * (origin at the asset's ground position).
 */
export function buildAssetGeometry(asset: AssetDefinition): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const m: AssetModelSpec = asset.model;
  switch (m.kind) {
    case 'tank':
      tank(b, m.radius, m.height);
      break;
    case 'pump':
      pump(b);
      break;
    case 'motor':
      motor(b, m.size, m.shaftY, m.vertical === true);
      break;
    case 'pipeline':
      pipeline(b, m.paths, m.radius);
      break;
    case 'heat_exchanger':
      heatExchanger(b);
      break;
    case 'reactor':
      reactor(b, m.radius, m.height);
      break;
    case 'filler':
      filler(b);
      break;
    case 'packer':
      packer(b);
      break;
    case 'palletiser':
      palletiser(b);
      break;
    case 'conveyor':
      conveyor(b, m.length);
      break;
    case 'cooling_tower':
      coolingTower(b);
      break;
    case 'chiller':
      chiller(b);
      break;
    case 'transformer':
      transformer(b);
      break;
    case 'switchgear':
      switchgear(b, m.sections);
      break;
    case 'lube_skid':
      lubeSkid(b);
      break;
    case 'compressor':
      compressor(b);
      break;
  }
  return b.build();
}

/** Points along a pipeline's first path at the given fractions of its length. */
export function pointsAlongPath(path: Vec3[], fractions: number[]): Vec3[] {
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const d = Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y, path[i + 1].z - path[i].z);
    seg.push(d);
    total += d;
  }
  return fractions.map((f) => {
    let dist = f * total;
    for (let i = 0; i < seg.length; i++) {
      if (dist <= seg[i] || i === seg.length - 1) {
        const k = seg[i] > 0 ? Math.min(1, dist / seg[i]) : 0;
        return {
          x: path[i].x + (path[i + 1].x - path[i].x) * k,
          y: path[i].y + (path[i + 1].y - path[i].y) * k,
          z: path[i].z + (path[i + 1].z - path[i].z) * k,
        };
      }
      dist -= seg[i];
    }
    return path[path.length - 1];
  });
}
