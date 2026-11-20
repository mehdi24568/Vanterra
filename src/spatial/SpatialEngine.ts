/**
 * Spatial Engine - the 3D facility, camera, picking and spatial overlays.
 *
 * Runs entirely outside React: one requestAnimationFrame loop pulls state from a
 * SceneFeed and writes uniforms, instance colours and label transforms directly.
 * Draw-call budget is deliberately small: two per asset (surface + edges), one for
 * every sensor marker (instanced), one for every relationship arc (single buffer).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { AssetDefinition, HealthState, RelationType } from '../core/types';
import { SEVERITY_RANK } from '../core/types';
import { MAX_PULSES } from '../sonar/SonarEngine';
import type { SonarContact } from '../sonar/SonarEngine';
import { buildAssetGeometry, pointsAlongPath } from './geometry';
import {
  COLORS,
  MAX_FOCUS,
  createAssetMaterials,
  createAssetUniforms,
  createGroundMaterial,
  createRelationMaterial,
  createSharedUniforms,
} from './shaders';
import type { AssetUniforms, SharedUniforms } from './shaders';
import type { SceneFeed, SpatialCallbacks } from './types';
import { OtLayer } from './OtLayer';

interface AssetVisual {
  def: AssetDefinition;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  uniforms: AssetUniforms;
  anchor: THREE.Vector3;
  box: THREE.Box3;
  label: HTMLDivElement;
  shown: boolean;
  lastX: number;
  lastY: number;
  lastClass: string;
}

interface SensorVisual {
  signalId: string;
  assetId: string;
  position: THREE.Vector3;
}

interface EdgeVisual {
  relationId: string;
  from: string;
  to: string;
  type: RelationType;
  start: number;
  count: number;
}

interface Echo {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
  active: boolean;
}

const RELATION_COLOR: Record<RelationType, [number, number, number]> = {
  process: [0.22, 0.82, 1.0],
  mechanical: [0.85, 0.93, 1.0],
  electrical: [0.56, 0.6, 1.0],
  cooling: [0.18, 1.0, 0.8],
  utility: [0.5, 0.66, 0.82],
};

const ARC_SEGMENTS = 18;
const ECHO_LIFE = 1.7;
const HOME_POSITION = new THREE.Vector3(-56, 50, 66);
const HOME_TARGET = new THREE.Vector3(1, 1, -4);

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function textPlane(text: string, height: number, rgb: string, opacity: number): THREE.Mesh {
  const canvas = document.createElement('canvas');
  const font = '600 44px "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace';
  const probe = canvas.getContext('2d');
  if (!probe) return new THREE.Mesh();
  probe.font = font;
  const spacing = 5;
  const width = Math.ceil(probe.measureText(text).width + spacing * text.length) + 16;
  canvas.width = width;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = rgb;
  ctx.textBaseline = 'middle';
  let x = 8;
  for (const ch of text) {
    ctx.fillText(ch, x, 34);
    x += ctx.measureText(ch).width + spacing;
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 8;
  const geometry = new THREE.PlaneGeometry((height * width) / 64, height);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.width = (height * width) / 64;
  return mesh;
}

export class SpatialEngine {
  /** Smoothed frames per second, for the system-health readout. */
  fps = 60;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private ot: OtLayer | null = null;
  /** True while a full-page view covers the scene: nothing is drawn. */
  private paused = false;
  private shared: SharedUniforms = createSharedUniforms();
  private ground!: THREE.Mesh;
  private groundFocus!: THREE.Vector4[];
  private structures!: THREE.LineSegments;
  private visuals = new Map<string, AssetVisual>();
  private visualList: AssetVisual[] = [];
  private sensors: SensorVisual[] = [];
  private sensorMesh!: THREE.InstancedMesh;
  private sensorSignature = '';
  private edges: EdgeVisual[] = [];
  private relationGeometry!: THREE.BufferGeometry;
  private echoes: Echo[] = [];
  private brackets!: THREE.LineSegments;
  private bracketsFor: string | null = null;
  private emitterGlow!: THREE.Mesh;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerDirty = false;
  private pointerInside = false;
  private down: { x: number; y: number } | null = null;
  private hoverId: string | null = null;
  private tween: { fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; t: number; duration: number } | null = null;

  private raf = 0;
  private lastTime = 0;
  private elapsed = 0;
  private slowAccum = 1;
  private width = 1;
  private height = 1;
  private disposed = false;
  private observer: ResizeObserver;
  private unsubscribeContact: () => void;
  private tmp = new THREE.Vector3();
  private tmpColor = new THREE.Color();
  /** Principal-point shift (px) that keeps the scene centred in the area not covered by panels. */
  private viewOffset = new THREE.Vector2();
  private viewOffsetTarget = new THREE.Vector2();
  private insets = { left: 0, right: 0, top: 0, bottom: 0 };
  /** False until the operator (or a focus request) has moved the camera. */
  private userMoved = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly labelLayer: HTMLElement,
    private readonly feed: SceneFeed,
    private readonly callbacks: SpatialCallbacks,
  ) {
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      callbacks.onError(`WebGL could not be initialised: ${message}`);
      throw err;
    }
    // Colours in the shaders are authored display-referred; pass them through untouched.
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(COLORS.background, 1);
    this.renderer.domElement.className = 'scene-canvas';
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);

    this.scene.background = COLORS.background;
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 900);
    this.camera.position.copy(HOME_POSITION);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(HOME_TARGET);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.controls.minDistance = 7;
    this.controls.maxDistance = 440;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener('start', this.onControlsStart);
    this.controls.update();

    const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.32, 0.5, 0.42);
    this.composer.addPass(this.bloom);

    this.buildGround();
    this.buildAssets();
    this.buildSensors();
    this.buildRelations();
    this.buildOverlays();
    if (this.feed.otModel) {
      this.ot = new OtLayer(this.feed.otModel, this.feed.facility);
      this.scene.add(this.ot.group);
    }

    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerleave', this.onPointerLeave);
    dom.addEventListener('dblclick', this.onDoubleClick);

    this.unsubscribeContact = this.feed.sonar.onContact(this.onSonarContact);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.raf = requestAnimationFrame(this.tick);
  }

  // ------------------------------------------------------------ construction

  private buildGround(): void {
    const material = createGroundMaterial(this.shared);
    this.groundFocus = material.uniforms.uFocus.value as THREE.Vector4[];
    const geometry = new THREE.PlaneGeometry(700, 700);
    geometry.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(geometry, material);
    this.scene.add(this.ground);

    const lines: number[] = [];
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, into = lines) => into.push(ax, ay, az, bx, by, bz);
    const rect = (minX: number, maxX: number, minZ: number, maxZ: number, y: number, into = lines) => {
      seg(minX, y, minZ, maxX, y, minZ, into);
      seg(maxX, y, minZ, maxX, y, maxZ, into);
      seg(maxX, y, maxZ, minX, y, maxZ, into);
      seg(minX, y, maxZ, minX, y, minZ, into);
    };
    const site = { minX: -50, maxX: 50, minZ: -32, maxZ: 28 };
    rect(site.minX, site.maxX, site.minZ, site.maxZ, 0.03);
    for (let x = site.minX; x <= site.maxX; x += 10) {
      seg(x, 0.03, site.maxZ, x, 0.03, site.maxZ + 1.2);
      const label = textPlane(`E${x < 0 ? '-' : '+'}${String(Math.abs(x)).padStart(3, '0')}`, 1.15, 'rgb(90,170,210)', 0.55);
      label.position.set(x, 0.04, site.maxZ + 2.4);
      this.scene.add(label);
    }
    for (let z = site.minZ + 2; z <= site.maxZ; z += 10) {
      seg(site.minX, 0.03, z, site.minX - 1.2, 0.03, z);
      const label = textPlane(`N${-z < 0 ? '-' : '+'}${String(Math.abs(z)).padStart(3, '0')}`, 1.15, 'rgb(90,170,210)', 0.55);
      label.position.set(site.minX - 4.4, 0.04, z);
      this.scene.add(label);
    }
    for (const area of this.feed.facility.areas) {
      const b = area.bounds;
      rect(b.minX, b.maxX, b.minZ, b.maxZ, 0.035);
      const label = textPlane(`${area.id} · ${area.name}`, 1.25, 'rgb(120,200,235)', 0.7);
      label.position.set(b.minX + (label.userData.width as number) / 2 + 0.7, 0.045, b.maxZ - 1.1);
      this.scene.add(label);
    }
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    this.scene.add(new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: new THREE.Color(0.07, 0.25, 0.36) })));

    // Building frames: context only, not assets.
    const frame: number[] = [];
    const hall = (minX: number, maxX: number, minZ: number, maxZ: number, h: number) => {
      rect(minX, maxX, minZ, maxZ, h, frame);
      const ridge = h + 1.6;
      const midZ = (minZ + maxZ) / 2;
      seg(minX, ridge, midZ, maxX, ridge, midZ, frame);
      const bays = Math.max(1, Math.round((maxX - minX) / 9));
      for (let i = 0; i <= bays; i++) {
        const x = minX + ((maxX - minX) * i) / bays;
        seg(x, 0, minZ, x, h, minZ, frame);
        seg(x, 0, maxZ, x, h, maxZ, frame);
        seg(x, h, minZ, x, ridge, midZ, frame);
        seg(x, h, maxZ, x, ridge, midZ, frame);
      }
    };
    hall(-26, -8, -27, -7, 6.5);
    hall(-5, 20, -27, -7, 11.5);
    hall(5, 46, 4, 16, 7);
    const frameGeometry = new THREE.BufferGeometry();
    frameGeometry.setAttribute('position', new THREE.Float32BufferAttribute(frame, 3));
    this.structures = new THREE.LineSegments(frameGeometry, new THREE.LineBasicMaterial({ color: new THREE.Color(0.035, 0.12, 0.18) }));
    this.scene.add(this.structures);
  }

  private buildAssets(): void {
    for (const def of this.feed.facility.assets) {
      const geometry = buildAssetGeometry(def);
      const uniforms = createAssetUniforms();
      const { surface, edge } = createAssetMaterials(this.shared, uniforms);
      const mesh = new THREE.Mesh(geometry, surface);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 28), edge);
      const isPipeline = def.model.kind === 'pipeline';
      if (!isPipeline) {
        mesh.position.set(def.position.x, def.position.y, def.position.z);
        mesh.rotation.y = def.rotationY;
        edges.position.copy(mesh.position);
        edges.rotation.y = def.rotationY;
      }
      mesh.userData.assetId = def.id;
      mesh.updateMatrixWorld(true);
      edges.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(mesh);
      const anchor = new THREE.Vector3();
      if (def.model.kind === 'pipeline') anchor.set(def.position.x, def.position.y + def.model.radius + 1.0, def.position.z);
      else anchor.set((box.min.x + box.max.x) / 2, box.max.y + 1.25, (box.min.z + box.max.z) / 2);
      this.scene.add(mesh, edges);

      const label = document.createElement('div');
      label.className = 'scene-label';
      label.style.display = 'none';
      const tag = document.createElement('span');
      tag.className = 'scene-label__tag';
      tag.textContent = def.id;
      const name = document.createElement('span');
      name.className = 'scene-label__name';
      name.textContent = def.name;
      label.append(tag, name);
      label.addEventListener('click', () => this.callbacks.onSelect(def.id, null));
      this.labelLayer.appendChild(label);

      const visual: AssetVisual = { def, mesh, edges, uniforms, anchor, box, label, shown: false, lastX: -1, lastY: -1, lastClass: '' };
      this.visuals.set(def.id, visual);
      this.visualList.push(visual);
    }
  }

  private buildSensors(): void {
    for (const v of this.visualList) {
      const signals = v.def.signals.filter((s) => s.role === 'measurement');
      const k = signals.length;
      if (k === 0) continue;
      if (v.def.model.kind === 'pipeline') {
        const fractions = signals.map((_, i) => (i + 1) / (k + 1));
        const points = pointsAlongPath(v.def.model.paths[0], fractions);
        const lift = v.def.model.radius + 0.42;
        signals.forEach((s, i) =>
          this.sensors.push({ signalId: s.id, assetId: v.def.id, position: new THREE.Vector3(points[i].x, points[i].y + lift, points[i].z) }),
        );
      } else {
        const cx = (v.box.min.x + v.box.max.x) / 2;
        const cz = (v.box.min.z + v.box.max.z) / 2;
        signals.forEach((s, i) =>
          this.sensors.push({
            signalId: s.id,
            assetId: v.def.id,
            position: new THREE.Vector3(cx + (i - (k - 1) / 2) * 0.62, v.box.max.y + 0.45, cz),
          }),
        );
      }
    }
    const material = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.sensorMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.17), material, this.sensors.length);
    this.sensorMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const dark = new THREE.Color(0, 0, 0);
    for (let i = 0; i < this.sensors.length; i++) this.sensorMesh.setColorAt(i, dark);
    this.scene.add(this.sensorMesh);
  }

  private buildRelations(): void {
    const relations = this.feed.graph.relations;
    const vertsPerEdge = ARC_SEGMENTS * 2;
    const total = relations.length * vertsPerEdge;
    const positions = new Float32Array(total * 3);
    const ts = new Float32Array(total);
    const colors = new Float32Array(total * 3);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    const bezier = (t: number, out: THREE.Vector3) => {
      const u = 1 - t;
      out.set(
        u * u * a.x + 2 * u * t * c.x + t * t * b.x,
        u * u * a.y + 2 * u * t * c.y + t * t * b.y,
        u * u * a.z + 2 * u * t * c.z + t * t * b.z,
      );
    };
    relations.forEach((r, index) => {
      const from = this.visuals.get(r.from);
      const to = this.visuals.get(r.to);
      if (!from || !to) return;
      a.copy(from.anchor).y -= 0.8;
      b.copy(to.anchor).y -= 0.8;
      const dist = a.distanceTo(b);
      c.copy(a).add(b).multiplyScalar(0.5);
      c.y = Math.max(a.y, b.y) + 1.4 + dist * 0.17;
      const start = index * vertsPerEdge;
      const rgb = RELATION_COLOR[r.type];
      for (let s = 0; s < ARC_SEGMENTS; s++) {
        const t0 = s / ARC_SEGMENTS;
        const t1 = (s + 1) / ARC_SEGMENTS;
        bezier(t0, p0);
        bezier(t1, p1);
        const v = start + s * 2;
        positions.set([p0.x, p0.y, p0.z, p1.x, p1.y, p1.z], v * 3);
        ts[v] = t0;
        ts[v + 1] = t1;
        colors.set([...rgb, ...rgb], v * 3);
      }
      this.edges.push({ relationId: r.id, from: r.from, to: r.to, type: r.type, start, count: vertsPerEdge });
    });
    this.relationGeometry = new THREE.BufferGeometry();
    this.relationGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.relationGeometry.setAttribute('aT', new THREE.BufferAttribute(ts, 1));
    this.relationGeometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    this.relationGeometry.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(total), 1).setUsage(THREE.DynamicDrawUsage));
    this.relationGeometry.setAttribute('aFocus', new THREE.BufferAttribute(new Float32Array(total), 1).setUsage(THREE.DynamicDrawUsage));
    const lines = new THREE.LineSegments(this.relationGeometry, createRelationMaterial(this.shared));
    lines.frustumCulled = false;
    lines.renderOrder = 5;
    this.scene.add(lines);
  }

  private buildOverlays(): void {
    // Echo rings returned by abnormal assets.
    const ring = new THREE.RingGeometry(0.9, 1.0, 64);
    ring.rotateX(-Math.PI / 2);
    for (let i = 0; i < 16; i++) {
      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(ring, material);
      mesh.visible = false;
      mesh.renderOrder = 4;
      this.scene.add(mesh);
      this.echoes.push({ mesh, material, age: 0, active: false });
    }

    // Selection brackets: the eight corners of a unit cube.
    const corners: number[] = [];
    const len = 0.16;
    for (const sx of [-0.5, 0.5]) {
      for (const sy of [-0.5, 0.5]) {
        for (const sz of [-0.5, 0.5]) {
          corners.push(sx, sy, sz, sx - Math.sign(sx) * len, sy, sz);
          corners.push(sx, sy, sz, sx, sy - Math.sign(sy) * len, sz);
          corners.push(sx, sy, sz, sx, sy, sz - Math.sign(sz) * len);
        }
      }
    }
    const bracketGeometry = new THREE.BufferGeometry();
    bracketGeometry.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
    this.brackets = new THREE.LineSegments(bracketGeometry, new THREE.LineBasicMaterial({ color: new THREE.Color(0.9, 1.0, 1.0), toneMapped: false }));
    this.brackets.visible = false;
    this.brackets.renderOrder = 6;
    this.scene.add(this.brackets);

    // Sonar emitter mast.
    const o = this.feed.facility.sonarOrigin;
    const mast: number[] = [];
    const top = 7.5;
    mast.push(o.x, 0, o.z, o.x, top, o.z);
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2;
      mast.push(o.x + Math.cos(ang) * 1.6, 0, o.z + Math.sin(ang) * 1.6, o.x, 2.6, o.z);
    }
    for (const [y, r] of [
      [top, 0.9],
      [top - 0.9, 0.55],
    ]) {
      for (let i = 0; i < 12; i++) {
        const a0 = (i / 12) * Math.PI * 2;
        const a1 = ((i + 1) / 12) * Math.PI * 2;
        mast.push(o.x + Math.cos(a0) * r, y, o.z + Math.sin(a0) * r, o.x + Math.cos(a1) * r, y, o.z + Math.sin(a1) * r);
      }
    }
    const mastGeometry = new THREE.BufferGeometry();
    mastGeometry.setAttribute('position', new THREE.Float32BufferAttribute(mast, 3));
    this.scene.add(new THREE.LineSegments(mastGeometry, new THREE.LineBasicMaterial({ color: new THREE.Color(0.16, 0.55, 0.75) })));
    this.emitterGlow = new THREE.Mesh(new THREE.OctahedronGeometry(0.32), new THREE.MeshBasicMaterial({ toneMapped: false }));
    this.emitterGlow.position.set(o.x, top + 0.35, o.z);
    this.scene.add(this.emitterGlow);
    const emitterLabel = textPlane('SONAR-01', 0.9, 'rgb(120,200,235)', 0.6);
    emitterLabel.position.set(o.x + 3.6, 0.045, o.z + 2.2);
    this.scene.add(emitterLabel);
  }

  // ------------------------------------------------------------------- frame

  private tick = (timeMs: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const rawDt = this.lastTime === 0 ? 0 : (timeMs - this.lastTime) / 1000;
    this.lastTime = timeMs;
    if (rawDt <= 0) return;
    // Animation uses a clamped step for stability; the frame-rate readout does not,
    // so a throttled or struggling renderer is reported as what it is.
    const dt = Math.min(0.1, rawDt);
    this.elapsed += dt;
    this.fps = this.fps * 0.9 + (1 / rawDt) * 0.1;

    // The scanner runs on real time (bounded, so returning from a background tab does not jump).
    this.feed.frame(Math.min(0.5, rawDt));
    if (this.paused) return;
    this.shared.uTime.value = this.elapsed;
    if (this.viewOffset.distanceToSquared(this.viewOffsetTarget) > 0.2) {
      this.viewOffset.lerp(this.viewOffsetTarget, 1 - Math.exp(-dt * 9));
      this.applyViewOffset();
    }
    this.updateCamera(dt);
    this.controls.update();
    this.syncPulses();
    this.syncAssets();
    this.slowAccum += dt;
    if (this.slowAccum >= 0.1) {
      this.slowAccum = 0;
      this.syncSensors();
      this.syncRelations();
      this.syncFocus();
      this.chooseLabels();
      const focus = this.feed.view.focus;
      this.ot?.sync(this.feed, focus ? new Set(focus.assets.keys()) : null, this.feed.view.selectedAssetId);
    }
    this.updateEchoes(dt);
    if (this.pointerDirty) this.updateHover();
    this.composer.render();
    this.positionLabels();
  };

  private syncPulses(): void {
    const pulses = this.feed.sonar.pulses;
    const slots = this.shared.uPulses.value;
    let latest = 0;
    for (let i = 0; i < MAX_PULSES; i++) {
      const p = pulses[i];
      if (!p) {
        slots[i].w = 0;
        continue;
      }
      const k = p.radius / p.maxRadius;
      const fade = 1 - THREE.MathUtils.smoothstep(k, 0.72, 1);
      // Event pings are local confirmations, drawn quieter than a commanded sweep.
      slots[i].set(p.x, p.z, p.radius, p.intensity * fade * (p.kind === 'event' ? 0.5 : 1));
      if (p.kind !== 'event') latest = Math.max(latest, 1 - Math.min(1, p.radius / 14));
    }
    // The emitter flashes as each pulse leaves it.
    const glow = 0.35 + latest * 1.6;
    (this.emitterGlow.material as THREE.MeshBasicMaterial).color.setRGB(0.2 * glow, 0.74 * glow, 1.0 * glow);
  }

  private syncAssets(): void {
    const { view, sonar } = this.feed;
    const focus = view.focus;
    for (const v of this.visualList) {
      const id = v.def.id;
      const visible = view.layers.categories[v.def.category];
      v.mesh.visible = visible;
      v.edges.visible = visible;
      if (!visible) continue;
      const u = v.uniforms;
      const health = this.feed.healthOf(id);
      const state = this.feed.operatingState(id);
      u.uReveal.value = sonar.energyOf(id);
      u.uColor.value.copy(state === 'standby' ? COLORS.standby : COLORS.cyan);
      if (health !== 'nominal') {
        u.uStatus.value = 1;
        u.uBeat.value = health === 'advisory' ? 0.35 : 1;
        u.uStatusColor.value.copy(COLORS[health]);
      } else if (state === 'tripped') {
        u.uStatus.value = 1;
        u.uBeat.value = 1;
        u.uStatusColor.value.copy(COLORS.critical);
      } else if (focus && focus.atRisk.has(id)) {
        u.uStatus.value = 0.5;
        u.uBeat.value = 0;
        u.uStatusColor.value.copy(COLORS.atRisk);
      } else {
        u.uStatus.value = 0;
        u.uBeat.value = 0;
      }
      const selected = id === view.selectedAssetId;
      u.uSelected.value = selected ? 1 : 0;
      u.uHover.value = id === this.hoverId ? 1 : 0;
      u.uDim.value = !focus || selected || focus.assets.has(id) ? 0 : focus.atRisk.has(id) ? 0.2 : 0.75;
    }
    this.structures.visible = view.layers.structures;

    const selectedId = view.selectedAssetId;
    if (selectedId !== this.bracketsFor) {
      this.bracketsFor = selectedId;
      const v = selectedId ? this.visuals.get(selectedId) : undefined;
      if (v) {
        v.box.getCenter(this.brackets.position);
        v.box.getSize(this.brackets.scale).addScalar(0.7);
        this.brackets.visible = true;
      } else {
        this.brackets.visible = false;
      }
    }
    if (this.brackets.visible && selectedId) {
      const v = this.visuals.get(selectedId);
      this.brackets.visible = !!v && view.layers.categories[v.def.category];
    }
  }

  private syncSensors(): void {
    const { view, sonar } = this.feed;
    const layers = view.layers;
    this.sensorMesh.visible = layers.sensors;
    if (!layers.sensors) return;
    // Instance matrices only change when category visibility changes.
    const signature = Object.values(layers.categories).join('');
    if (signature !== this.sensorSignature) {
      this.sensorSignature = signature;
      const m = new THREE.Matrix4();
      const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
      this.sensors.forEach((s, i) => {
        const cat = this.visuals.get(s.assetId)!.def.category;
        if (layers.categories[cat]) this.sensorMesh.setMatrixAt(i, m.makeTranslation(s.position.x, s.position.y, s.position.z));
        else this.sensorMesh.setMatrixAt(i, hidden);
      });
      this.sensorMesh.instanceMatrix.needsUpdate = true;
      this.sensorMesh.computeBoundingSphere();
    }
    const flash = 1.15 + 0.45 * Math.sin(this.elapsed * 5);
    this.sensors.forEach((s, i) => {
      const health = this.feed.signalHealth(s.signalId);
      const c = this.tmpColor;
      if (s.signalId === view.selectedSignalId) c.copy(COLORS.white).multiplyScalar(1.7);
      else if (health !== 'nominal') c.copy(COLORS[health]).multiplyScalar(flash);
      else c.copy(COLORS.cyan).multiplyScalar(0.1 + 0.95 * Math.min(1.2, sonar.energyOf(s.assetId)));
      this.sensorMesh.setColorAt(i, c);
    });
    if (this.sensorMesh.instanceColor) this.sensorMesh.instanceColor.needsUpdate = true;
  }

  private syncRelations(): void {
    const { view, sonar } = this.feed;
    const layers = view.layers;
    const selected = view.selectedAssetId;
    const focus = view.focus;
    const glow = this.relationGeometry.getAttribute('aGlow') as THREE.BufferAttribute;
    const foc = this.relationGeometry.getAttribute('aFocus') as THREE.BufferAttribute;
    const glowArr = glow.array as Float32Array;
    const focArr = foc.array as Float32Array;
    for (const e of this.edges) {
      const a = this.visuals.get(e.from)!;
      const b = this.visuals.get(e.to)!;
      let g = 0;
      let f = 0;
      if (layers.categories[a.def.category] && layers.categories[b.def.category]) {
        const touchesSelection = selected !== null && (e.from === selected || e.to === selected);
        if (layers.relations && layers.relationTypes[e.type]) {
          g = 0.2 + 0.55 * Math.min(1, Math.min(sonar.energyOf(e.from), sonar.energyOf(e.to)));
          if (selected && !touchesSelection) g *= 0.4;
        }
        if (touchesSelection) g = 1.5;
        if (focus) {
          if (focus.relationIds.has(e.relationId)) {
            g = 1.7;
            f = 1;
          } else if (!touchesSelection) g *= 0.3;
        }
      }
      glowArr.fill(g, e.start, e.start + e.count);
      focArr.fill(f, e.start, e.start + e.count);
    }
    glow.needsUpdate = true;
    foc.needsUpdate = true;
  }

  private syncFocus(): void {
    const focus = this.feed.view.focus;
    let slot = 0;
    if (focus) {
      const entries = [...focus.assets.entries()].sort((x, y) => SEVERITY_RANK[y[1]] - SEVERITY_RANK[x[1]]);
      for (const [assetId, severity] of entries) {
        if (slot >= MAX_FOCUS) break;
        const v = this.visuals.get(assetId);
        if (!v) continue;
        const pipeline = v.def.model.kind === 'pipeline';
        const radius = pipeline ? 3.2 : Math.min(9, Math.hypot(v.box.max.x - v.box.min.x, v.box.max.z - v.box.min.z) / 2 + 2.2);
        this.groundFocus[slot++].set(v.anchor.x, v.anchor.z, radius, SEVERITY_RANK[severity]);
      }
      for (const assetId of focus.atRisk) {
        if (slot >= MAX_FOCUS) break;
        const v = this.visuals.get(assetId);
        if (!v || v.def.model.kind === 'pipeline') continue;
        const radius = Math.min(8, Math.hypot(v.box.max.x - v.box.min.x, v.box.max.z - v.box.min.z) / 2 + 1.6);
        this.groundFocus[slot++].set(v.anchor.x, v.anchor.z, radius, 0);
      }
    }
    for (; slot < MAX_FOCUS; slot++) this.groundFocus[slot].z = 0;
  }

  // ------------------------------------------------------------------ labels

  /** Decide which labels to show (10 Hz): relevance first, then greedy de-cluttering. */
  private chooseLabels(): void {
    const { view, sonar } = this.feed;
    const focus = view.focus;
    type Candidate = { v: AssetVisual; priority: number; x: number; y: number; cls: string };
    const candidates: Candidate[] = [];
    for (const v of this.visualList) {
      const id = v.def.id;
      let wanted = view.layers.categories[v.def.category];
      const health = this.feed.healthOf(id);
      const selected = id === view.selectedAssetId;
      const hovered = id === this.hoverId;
      const inFocus = !!focus && focus.assets.has(id);
      const energy = sonar.energyOf(id);
      const isPipeline = v.def.model.kind === 'pipeline';
      if (wanted && !selected && !hovered) {
        if (!view.layers.labels) wanted = false;
        else if (health === 'nominal' && !inFocus) {
          // Unremarkable assets are labelled only while the sonar has them revealed.
          wanted = energy > 0.2 && (!isPipeline || this.camera.position.distanceTo(v.anchor) < 45);
        }
      }
      let x = 0;
      let y = 0;
      if (wanted) {
        this.tmp.copy(v.anchor).project(this.camera);
        if (this.tmp.z < -1 || this.tmp.z > 1 || Math.abs(this.tmp.x) > 1.05 || Math.abs(this.tmp.y) > 1.05) wanted = false;
        x = (this.tmp.x * 0.5 + 0.5) * this.width;
        y = (-this.tmp.y * 0.5 + 0.5) * this.height;
      }
      if (!wanted) {
        if (v.shown) {
          v.shown = false;
          v.label.style.display = 'none';
        }
        continue;
      }
      const priority = (selected ? 1000 : 0) + (hovered ? 900 : 0) + SEVERITY_RANK[health] * 100 + (inFocus ? 60 : 0) + energy * 10 - (isPipeline ? 5 : 0);
      const cls = `scene-label${selected ? ' is-selected' : ''}${hovered ? ' is-hover' : ''}${health !== 'nominal' ? ` sev-${health}` : ''}${
        this.feed.operatingState(id) === 'standby' ? ' is-standby' : ''
      }`;
      candidates.push({ v, priority, x, y, cls });
    }
    candidates.sort((a, b) => b.priority - a.priority);
    const placed: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
    for (const c of candidates) {
      const expanded = c.cls.includes('is-selected') || c.cls.includes('is-hover');
      const w = 18 + c.v.def.id.length * 7.2 + (expanded ? 12 + c.v.def.name.length * 6.2 : 0);
      const rect = { x0: c.x - w / 2, x1: c.x + w / 2, y0: c.y - 24, y1: c.y };
      const overlaps = c.priority < 100 && placed.some((p) => rect.x0 < p.x1 && rect.x1 > p.x0 && rect.y0 < p.y1 && rect.y1 > p.y0);
      if (overlaps) {
        if (c.v.shown) {
          c.v.shown = false;
          c.v.label.style.display = 'none';
        }
        continue;
      }
      placed.push(rect);
      if (!c.v.shown) {
        c.v.shown = true;
        c.v.label.style.display = '';
        c.v.lastX = -1;
      }
      if (c.v.lastClass !== c.cls) {
        c.v.lastClass = c.cls;
        c.v.label.className = c.cls;
      }
    }
  }

  private positionLabels(): void {
    for (const v of this.visualList) {
      if (!v.shown) continue;
      this.tmp.copy(v.anchor).project(this.camera);
      const x = Math.round((this.tmp.x * 0.5 + 0.5) * this.width * 2) / 2;
      const y = Math.round((-this.tmp.y * 0.5 + 0.5) * this.height * 2) / 2;
      if (x === v.lastX && y === v.lastY) continue;
      v.lastX = x;
      v.lastY = y;
      v.label.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
    }
  }

  // ------------------------------------------------------------------ echoes

  private onSonarContact = (c: SonarContact) => {
    if (!c.echo) return;
    const v = this.visuals.get(c.assetId);
    if (!v || !this.feed.view.layers.categories[v.def.category]) return;
    const echo = this.echoes.find((e) => !e.active) ?? this.echoes.reduce((a, b) => (a.age > b.age ? a : b));
    echo.active = true;
    echo.age = 0;
    echo.mesh.visible = true;
    echo.mesh.position.set(v.anchor.x, 0.07, v.anchor.z);
    echo.mesh.userData.health = c.health;
  };

  private updateEchoes(dt: number): void {
    for (const e of this.echoes) {
      if (!e.active) continue;
      e.age += dt;
      const k = e.age / ECHO_LIFE;
      if (k >= 1) {
        e.active = false;
        e.mesh.visible = false;
        continue;
      }
      const radius = 1.5 + 9 * (1 - Math.pow(1 - k, 2.2));
      e.mesh.scale.set(radius, 1, radius);
      const health = e.mesh.userData.health as HealthState;
      const base = health === 'nominal' ? COLORS.cyan : COLORS[health];
      e.material.color.copy(base).multiplyScalar(0.6 * Math.pow(1 - k, 1.5));
    }
  }

  // ------------------------------------------------------------- interaction

  private setPointer(e: PointerEvent | MouseEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private pickAt(): { assetId: string; signalId: string | null } | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const layers = this.feed.view.layers;
    const targets: THREE.Object3D[] = [];
    for (const v of this.visualList) if (layers.categories[v.def.category]) targets.push(v.mesh);
    if (layers.sensors) targets.push(this.sensorMesh);
    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    if (hit.object === this.sensorMesh && hit.instanceId !== undefined) {
      const s = this.sensors[hit.instanceId];
      return { assetId: s.assetId, signalId: s.signalId };
    }
    return { assetId: hit.object.userData.assetId as string, signalId: null };
  }

  private updateHover(): void {
    this.pointerDirty = false;
    const hit = this.pointerInside && !this.down ? this.pickAt() : null;
    const id = hit?.assetId ?? null;
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
    this.tween = null;
  };

  private onControlsStart = () => {
    this.userMoved = true;
  };

  private onPointerUp = (e: PointerEvent) => {
    const down = this.down;
    this.down = null;
    if (!down || e.button !== 0) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    this.setPointer(e);
    const hit = this.pickAt();
    this.callbacks.onSelect(hit?.assetId ?? null, hit?.signalId ?? null);
  };

  private onPointerMove = (e: PointerEvent) => {
    this.setPointer(e);
    this.pointerInside = true;
    this.pointerDirty = true;
  };

  private onPointerLeave = () => {
    this.pointerInside = false;
    this.pointerDirty = true;
  };

  private onDoubleClick = (e: MouseEvent) => {
    this.setPointer(e);
    const hit = this.pickAt();
    if (hit) {
      this.focusAsset(hit.assetId);
      return;
    }
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const point = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (point && Math.abs(point.x) < 120 && Math.abs(point.z) < 120) this.callbacks.onGroundPing(point.x, point.z);
  };

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.callbacks.onError('The WebGL context was lost. Reload the page to restore the 3D view.');
  };

  // ------------------------------------------------------------------ camera

  private updateCamera(dt: number): void {
    const tw = this.tween;
    if (!tw) return;
    tw.t = Math.min(1, tw.t + dt / tw.duration);
    const k = easeInOut(tw.t);
    this.camera.position.lerpVectors(tw.fromPos, tw.toPos, k);
    this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, k);
    if (tw.t >= 1) this.tween = null;
  }

  private flyTo(position: THREE.Vector3, target: THREE.Vector3, duration = 0.9): void {
    this.userMoved = true;
    this.tween = {
      fromPos: this.camera.position.clone(),
      toPos: position,
      fromTarget: this.controls.target.clone(),
      toTarget: target,
      t: 0,
      duration,
    };
  }

  /** Move the camera to frame one asset, keeping the current viewing direction. */
  focusAsset(assetId: string): void {
    const v = this.visuals.get(assetId);
    if (!v) return;
    const center = v.box.getCenter(new THREE.Vector3());
    const size = v.box.getSize(new THREE.Vector3()).length();
    const distance = THREE.MathUtils.clamp(size * 1.5 + 12, 16, 70);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    dir.y = Math.max(dir.y, 0.42);
    dir.normalize();
    this.flyTo(center.clone().addScaledVector(dir, distance), center);
  }

  /** Frame a set of assets (used when an incident is opened). */
  focusAssets(assetIds: string[]): void {
    const box = new THREE.Box3();
    for (const id of assetIds) {
      const v = this.visuals.get(id);
      if (v) box.union(v.box);
    }
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const distance = THREE.MathUtils.clamp(size * 1.15 + 18, 26, 150);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    dir.y = Math.max(dir.y, 0.5);
    dir.normalize();
    this.flyTo(center.clone().addScaledVector(dir, distance), center, 1.1);
  }

  resetView(): void {
    const home = this.homePose();
    this.flyTo(home.position, home.target, 1.1);
  }

  /**
   * Tell the engine how much of the canvas is covered by interface panels (px).
   * The projection is shifted so that whatever the camera targets appears in the
   * centre of the *visible* area, not behind a panel.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  setInsets(insets: { left: number; right: number; top: number; bottom: number }): void {
    this.insets = insets;
    this.viewOffsetTarget.set((insets.right - insets.left) / 2, (insets.bottom - insets.top) / 2);
    if (!this.userMoved) {
      // Until the operator takes the camera, keep the whole site framed in the free area.
      this.viewOffset.copy(this.viewOffsetTarget);
      this.applyViewOffset();
      const home = this.homePose();
      this.camera.position.copy(home.position);
      this.controls.target.copy(home.target);
    }
  }

  /** Overview pose that fits the whole site into the area not covered by panels. */
  private homePose(): { position: THREE.Vector3; target: THREE.Vector3 } {
    const freeW = Math.max(0.2, (this.width - this.insets.left - this.insets.right) / this.width);
    const freeH = Math.max(0.2, (this.height - this.insets.top - this.insets.bottom) / this.height);
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const aspect = this.width / this.height;
    // Half-extents of the site as seen from the overview direction, in metres.
    const distance = THREE.MathUtils.clamp(Math.max(60 / (t * aspect * freeW), 35 / (t * freeH)), 70, 400);
    const dir = HOME_POSITION.clone().sub(HOME_TARGET).normalize();
    return { position: HOME_TARGET.clone().addScaledVector(dir, distance), target: HOME_TARGET.clone() };
  }

  private applyViewOffset(): void {
    if (this.viewOffset.lengthSq() < 0.25) this.camera.clearViewOffset();
    else this.camera.setViewOffset(this.width, this.height, this.viewOffset.x, this.viewOffset.y, this.width, this.height);
  }

  // --------------------------------------------------------------- lifecycle

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    this.camera.aspect = w / h;
    this.applyViewOffset();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.unsubscribeContact();
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    dom.removeEventListener('pointerup', this.onPointerUp);
    dom.removeEventListener('pointermove', this.onPointerMove);
    dom.removeEventListener('pointerleave', this.onPointerLeave);
    dom.removeEventListener('dblclick', this.onDoubleClick);
    dom.removeEventListener('webglcontextlost', this.onContextLost);
    this.controls.removeEventListener('start', this.onControlsStart);
    this.controls.dispose();
    this.scene.traverse((obj) => {
      const o = obj as THREE.Mesh;
      if (o.geometry) o.geometry.dispose();
      const material = o.material as THREE.Material | THREE.Material[] | undefined;
      for (const m of Array.isArray(material) ? material : material ? [material] : []) {
        const map = (m as THREE.MeshBasicMaterial).map;
        if (map) map.dispose();
        m.dispose();
      }
    });
    for (const v of this.visualList) v.label.remove();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    dom.remove();
  }
}
