/**
 * Shared palette + material helpers for the building models.
 *
 * Everything here is deterministic: no Math.random anywhere in scene/buildings.
 * Colours are plain hex strings so they can be handed straight to JSX materials
 * (r3f creates and disposes those for us); the few THREE.Color objects are
 * module-level constants reused by the colour maths.
 */
import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

export const PALETTE = {
  /** Ground pad slab under every building. */
  pad: '#1c2431',
  /** Lighter plinth / entrance canopy. */
  plinth: '#1f2937',
  plinthLight: '#334155',
  /** Junction box where the conduits arrive. */
  junction: '#374151',
  /** Highlight ring. */
  highlight: '#38bdf8',

  /* office */
  officeGlass: '#1e3a5f',
  officeSpandrel: '#0f172a',
  officeMullion: '#64748b',
  officeScreen: '#475569',

  /* hospital */
  hospitalFacade: '#cbd5e1',
  hospitalTrim: '#e2e8f0',
  hospitalCore: '#dbe3ec',
  red: '#dc2626',
  redBright: '#ef4444',

  /* warehouse */
  metalDark: '#4b5563',
  metalLight: '#6b7280',
  metalTrim: '#374151',
  dockRubber: '#1f2937',

  /* misc */
  roof: '#293548',
  parapet: '#3f4a5c',
  signPost: '#334155',
} as const;

/* -------------------------------------------------------------------------- */
/* Window colour model                                                         */
/* -------------------------------------------------------------------------- */

/** Unlit / cool glass -- loadRatio 0. */
const COOL = new THREE.Color('#1e293b');
/** Warm occupied glow -- loadRatio 1. */
const WARM = new THREE.Color('#fbbf24');
/** Over-threshold alarm tint -- loadRatio >= 2. */
const HOT = new THREE.Color('#ef4444');
/** A pane that is switched off at night. */
const OFF = new THREE.Color('#0a0f1a');
/** Night-time floor: even a lightly loaded building has lights on after dark. */
const NIGHT_LIT = new THREE.Color('#ffd08a');

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Reused by the hex helpers below so nothing allocates per render. */
const scratch = new THREE.Color();

/**
 * How "night" it is, 0..1. Fully lit 18:00-06:00, with a two hour ramp either
 * side so scrubbing the timeline reads as a sunrise / sunset rather than a cut.
 */
export function nightFactor(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 18 || h < 6) return 1;
  if (h < 8) return 1 - (h - 6) / 2; // 06:00 -> 08:00 fade out
  if (h >= 16) return (h - 16) / 2; // 16:00 -> 18:00 fade in
  return 0;
}

/** Emissive intensity for the whole window material, driven by `hour`. */
export function windowEmissiveIntensity(hour: number): number {
  return 0.1 + 1.45 * nightFactor(hour);
}

/**
 * Deterministic pseudo-random in [0, 1) seeded by the pane index. The same pane
 * index always yields the same value, so nothing flickers between renders.
 */
export function hash01(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Fraction of panes that stay dark after sunset. */
export const NIGHT_DARK_FRACTION = 0.35;

/**
 * Daytime tint: a straight `loadRatio` ramp. 0 gives cool dim slate, 1 gives
 * warm amber, and above 1.0 it pulls toward red.
 */
function dayTint(loadRatio: number, out: THREE.Color): THREE.Color {
  // Squared so a half-loaded building reads as a warm bronze rather than full
  // amber -- the lerp happens in linear space, which otherwise blows out fast.
  const t = clamp01(loadRatio);
  out.copy(COOL).lerp(WARM, t * t);
  if (loadRatio > 1) out.lerp(HOT, clamp01(loadRatio - 1));
  return out;
}

/**
 * Colour of a pane that is switched ON: the daytime tint, lifted toward a warm
 * interior glow as night falls so an idle building still reads as occupied.
 * Also used for the office lobby glass and the hospital entrance glazing.
 */
export function litPanelColor(hour: number, loadRatio: number, out: THREE.Color): THREE.Color {
  dayTint(loadRatio, out);
  const night = nightFactor(hour);
  if (night > 0) out.lerp(NIGHT_LIT, 0.55 * night * (1 - clamp01(loadRatio) * 0.6));
  return out;
}

/**
 * Colour for one window pane. After dark ~35% of panes (chosen deterministically
 * by `hash01(index)`) sink toward near-black; the rest use `litPanelColor`.
 * Because the window material multiplies its emissive by the per-instance
 * colour, the dark panes stop glowing for free.
 */
export function panelColor(
  index: number,
  hour: number,
  loadRatio: number,
  out: THREE.Color,
): THREE.Color {
  const night = nightFactor(hour);
  if (night > 0 && hash01(index) < NIGHT_DARK_FRACTION) {
    dayTint(loadRatio, out);
    return out.lerp(OFF, night);
  }
  return litPanelColor(hour, loadRatio, out);
}

/**
 * `litPanelColor` as a CSS hex string, for JSX `color=` props. `scale` dims it:
 * big glazed surfaces (the office lobby, the hospital entrance) need to be
 * darker than a window pane or they blow out at night.
 */
export function litPanelHex(hour: number, loadRatio: number, scale = 1): string {
  litPanelColor(hour, loadRatio, scratch);
  if (scale !== 1) scratch.multiplyScalar(scale);
  return '#' + scratch.getHexString();
}

/* -------------------------------------------------------------------------- */
/* Shader patch                                                                */
/* -------------------------------------------------------------------------- */

/**
 * meshStandardMaterial multiplies `instanceColor` into the diffuse term only --
 * emissive stays uniform across instances. This patch multiplies the emissive
 * term by the instance colour too, so one InstancedMesh can hold both dark and
 * glowing panes. Module-level so its identity is stable and the program is
 * never recompiled.
 */
export function emissiveFromInstanceColor(shader: { fragmentShader: string }): void {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <emissivemap_fragment>',
    [
      '#include <emissivemap_fragment>',
      // `.rgb` because three declares vColor as vec4 in some configurations
      // and as vec3 in others; the swizzle is valid for both.
      '#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR ) || defined( USE_COLOR_ALPHA )',
      '\ttotalEmissiveRadiance *= vColor.rgb;',
      '#endif',
    ].join('\n'),
  );
}

/* -------------------------------------------------------------------------- */
/* Canvas label textures                                                       */
/* -------------------------------------------------------------------------- */

interface LabelOptions {
  width?: number;
  height?: number;
  background?: string;
  color?: string;
  font?: string;
  align?: CanvasTextAlign;
}

/**
 * Renders `text` into a CanvasTexture. Used for the name sign -- one extra draw
 * call, and no webfont download (drei's <Text> pulls a font off the network,
 * which we cannot rely on in the demo). Returns null during SSR.
 */
export function makeLabelTexture(text: string, opts: LabelOptions = {}): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const width = opts.width ?? 512;
  const height = opts.height ?? 128;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = opts.background ?? '#0f172a';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = opts.color ?? '#e2e8f0';
  ctx.font = opts.font ?? '600 ' + Math.round(height * 0.44) + 'px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = opts.align ?? 'center';
  ctx.fillText(text, width / 2, height / 2, width * 0.9);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** The helipad circle + H, drawn once into a texture instead of five meshes. */
export function makeHelipadTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#334155';
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = '#f8fafc';
  ctx.lineWidth = size * 0.045;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.38, 0, Math.PI * 2);
  ctx.stroke();

  // White H
  ctx.fillStyle = '#f8fafc';
  const barW = size * 0.075;
  const barH = size * 0.4;
  const gap = size * 0.16;
  ctx.fillRect(size / 2 - gap - barW / 2, size / 2 - barH / 2, barW, barH);
  ctx.fillRect(size / 2 + gap - barW / 2, size / 2 - barH / 2, barW, barH);
  ctx.fillRect(size / 2 - gap, size / 2 - barW / 2, gap * 2, barW);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
