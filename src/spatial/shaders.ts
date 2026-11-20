/**
 * GLSL for the ATLAS look: dark solid equipment, cyan edge light, and a sonar
 * wavefront that is evaluated per-fragment from the *same* pulse state the Sonar
 * Engine uses for its contact logic - the picture and the mechanism cannot drift apart.
 */
import * as THREE from 'three';
import { MAX_PULSES } from '../sonar/SonarEngine';

export const MAX_FOCUS = 12;

export const COLORS = {
  background: new THREE.Color(0.006, 0.011, 0.019),
  cyan: new THREE.Color(0.38, 0.6, 0.78),
  standby: new THREE.Color(0.3, 0.42, 0.56),
  advisory: new THREE.Color(1.0, 0.82, 0.32),
  warning: new THREE.Color(1.0, 0.5, 0.12),
  critical: new THREE.Color(1.0, 0.16, 0.18),
  atRisk: new THREE.Color(0.95, 0.72, 0.5),
  white: new THREE.Color(0.85, 0.95, 1.0),
};

const PULSES = /* glsl */ `
uniform vec4 uPulses[${MAX_PULSES}];
float sonarWave(vec2 p) {
  float w = 0.0;
  for (int i = 0; i < ${MAX_PULSES}; i++) {
    vec4 pu = uPulses[i];
    if (pu.w <= 0.0) continue;
    float band = distance(p, pu.xy) - pu.z;
    float front = exp(-band * band * 0.3);
    float trail = smoothstep(-11.0, 0.0, band) * step(band, 0.0);
    w += (front + 0.3 * trail) * pu.w;
  }
  return w;
}
`;

const WORLD_VERTEX = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  #ifdef ATLAS_SURFACE
  vNormal = normalize(mat3(modelMatrix) * normal);
  #else
  vNormal = vec3(0.0, 1.0, 0.0);
  #endif
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const ASSET_UNIFORMS = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uStatusColor;
uniform float uStatus;
uniform float uBeat;
uniform float uReveal;
uniform float uSelected;
uniform float uHover;
uniform float uDim;
uniform float uTime;
`;

const SURFACE_FRAGMENT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
${ASSET_UNIFORMS}
${PULSES}
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorld);
  float lambert = clamp(dot(n, normalize(vec3(0.35, 0.85, 0.4))) * 0.5 + 0.5, 0.0, 1.0);
  float fres = pow(1.0 - abs(dot(n, v)), 2.5);
  // Horizontal scan contours on upright faces, every 0.8 m.
  float contour = (1.0 - smoothstep(0.0, 0.04, abs(fract(vWorld.y * 1.25) - 0.5))) * (1.0 - abs(n.y));
  float wave = sonarWave(vWorld.xz);
  float beat = mix(1.0, 0.7 + 0.3 * sin(uTime * 4.2), uBeat);
  vec3 base = mix(uColor, uStatusColor, uStatus);
  float lum = 0.016 + 0.04 * lambert + 0.045 * fres;
  lum += uReveal * (0.04 + 0.15 * lambert + 0.32 * fres + 0.14 * contour);
  lum += wave * (0.2 + 0.5 * fres + 0.38 * contour);
  lum += uStatus * beat * (0.09 + 0.24 * fres);
  lum += uSelected * (0.07 + 0.24 * fres) + uHover * 0.06;
  lum *= mix(1.0, 0.3, uDim);
  gl_FragColor = vec4(base * lum, 1.0);
}
`;

const EDGE_FRAGMENT = /* glsl */ `
varying vec3 vWorld;
${ASSET_UNIFORMS}
${PULSES}
void main() {
  float wave = sonarWave(vWorld.xz);
  float beat = mix(1.0, 0.7 + 0.3 * sin(uTime * 4.2), uBeat);
  vec3 base = mix(uColor, uStatusColor, uStatus);
  float lum = 0.15 + uReveal * 0.9 + wave * 1.5 + uStatus * beat * 0.85 + uSelected * 0.9 + uHover * 0.45;
  // Restraint: several effects coinciding must not blow the edge out to white.
  lum = min(lum, 1.75);
  lum *= mix(1.0, 0.28, uDim);
  gl_FragColor = vec4(base * lum, 1.0);
}
`;

const GROUND_FRAGMENT = /* glsl */ `
varying vec3 vWorld;
uniform float uTime;
uniform vec3 uBackground;
uniform vec4 uFocus[${MAX_FOCUS}];
${PULSES}
float gridLine(vec2 p, float size, float width) {
  vec2 c = p / size;
  vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
  return 1.0 - min(min(g.x, g.y) / width, 1.0);
}
void main() {
  vec2 p = vWorld.xz;
  float d = length(p - vec2(0.0, -2.0));
  float fade = smoothstep(190.0, 55.0, d);
  float minor = gridLine(p, 2.0, 1.0) * 0.05;
  float major = gridLine(p, 10.0, 1.15) * 0.16;
  vec3 cyan = vec3(0.36, 0.54, 0.7);
  vec3 col = vec3(0.01, 0.017, 0.028) + cyan * (minor + major);
  float lines = minor + major;
  for (int i = 0; i < ${MAX_PULSES}; i++) {
    vec4 pu = uPulses[i];
    if (pu.w <= 0.0) continue;
    float band = distance(p, pu.xy) - pu.z;
    float front = exp(-band * band * 1.1);
    float trail = smoothstep(-16.0, 0.0, band) * step(band, 0.0);
    col += cyan * (front * 0.85 + trail * (0.05 + lines * 5.0)) * pu.w;
  }
  for (int j = 0; j < ${MAX_FOCUS}; j++) {
    vec4 f = uFocus[j];
    if (f.z <= 0.0) continue;
    float dd = distance(p, f.xy);
    float disc = 1.0 - smoothstep(f.z * 0.35, f.z, dd);
    float ring = exp(-pow(dd - f.z, 2.0) * 2.4);
    vec3 fc = f.w > 2.5 ? vec3(1.0, 0.16, 0.18) : (f.w > 1.5 ? vec3(1.0, 0.5, 0.12) : (f.w > 0.5 ? vec3(1.0, 0.82, 0.32) : vec3(0.95, 0.72, 0.5)));
    float pulse = f.w > 0.5 ? 0.75 + 0.25 * sin(uTime * 3.0) : 0.6;
    col += fc * (disc * 0.045 + ring * 0.22 * pulse + disc * lines * 0.7);
  }
  gl_FragColor = vec4(mix(uBackground, col, fade), 1.0);
}
`;

const RELATION_VERTEX = /* glsl */ `
attribute float aT;
attribute vec3 aColor;
attribute float aGlow;
attribute float aFocus;
varying float vT;
varying vec3 vColor;
varying float vGlow;
void main() {
  vT = aT;
  vGlow = aGlow;
  vColor = mix(aColor, vec3(1.0, 0.62, 0.22), aFocus);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RELATION_FRAGMENT = /* glsl */ `
uniform float uTime;
varying float vT;
varying vec3 vColor;
varying float vGlow;
void main() {
  if (vGlow < 0.01) discard;
  // Dashes travel from supplier to consumer: the direction of dependency.
  float phase = fract(vT * 7.0 - uTime * 0.55);
  float dash = smoothstep(0.0, 0.12, phase) * (1.0 - smoothstep(0.45, 0.6, phase));
  gl_FragColor = vec4(vColor * vGlow * (0.3 + 0.9 * dash), 1.0);
}
`;

export interface SharedUniforms {
  uPulses: { value: THREE.Vector4[] };
  uTime: { value: number };
}

export interface AssetUniforms {
  uColor: { value: THREE.Color };
  uStatusColor: { value: THREE.Color };
  uStatus: { value: number };
  uBeat: { value: number };
  uReveal: { value: number };
  uSelected: { value: number };
  uHover: { value: number };
  uDim: { value: number };
}

export function createSharedUniforms(): SharedUniforms {
  return {
    uPulses: { value: Array.from({ length: MAX_PULSES }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uTime: { value: 0 },
  };
}

export function createAssetUniforms(): AssetUniforms {
  return {
    uColor: { value: COLORS.cyan.clone() },
    uStatusColor: { value: COLORS.warning.clone() },
    uStatus: { value: 0 },
    uBeat: { value: 0 },
    uReveal: { value: 0 },
    uSelected: { value: 0 },
    uHover: { value: 0 },
    uDim: { value: 0 },
  };
}

/** Surface and edge materials for one asset. They share the asset's uniform objects. */
export function createAssetMaterials(shared: SharedUniforms, own: AssetUniforms): { surface: THREE.ShaderMaterial; edge: THREE.ShaderMaterial } {
  const uniforms = { ...shared, ...own };
  const surface = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: WORLD_VERTEX,
    fragmentShader: SURFACE_FRAGMENT,
    defines: { ATLAS_SURFACE: '' },
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const edge = new THREE.ShaderMaterial({ uniforms, vertexShader: WORLD_VERTEX, fragmentShader: EDGE_FRAGMENT });
  return { surface, edge };
}

export function createGroundMaterial(shared: SharedUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uBackground: { value: COLORS.background.clone() },
      uFocus: { value: Array.from({ length: MAX_FOCUS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    },
    vertexShader: WORLD_VERTEX,
    fragmentShader: GROUND_FRAGMENT,
  });
}

export function createRelationMaterial(shared: SharedUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime },
    vertexShader: RELATION_VERTEX,
    fragmentShader: RELATION_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
