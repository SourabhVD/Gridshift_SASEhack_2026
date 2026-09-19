'use client';

/**
 * Lighting for the energy scene, and the one place the day is modelled.
 *
 * ---------------------------------------------------------------------------
 * MATERIAL CONTRACT -- read this before authoring a material anywhere in
 * scene/buildings or scene/devices.
 * ---------------------------------------------------------------------------
 * The renderer runs ACES filmic tone mapping at an exposure of 1.05, and every
 * surface is lit by a sky HDRI as well as by the sun. That
 * changes what a colour means:
 *
 *   - Albedo must be physically plausible. Nothing brighter than #f2f2f2 and
 *     nothing darker than #141414: a real painted wall reflects 80 % at most,
 *     and real asphalt still reflects 6 %. Pure #ffffff clips after tone
 *     mapping, and pure #000000 reads as a hole in the render because there is
 *     no flat ambient term left to lift it.
 *   - Roughness is the main storyteller now. Matte architectural surfaces sit
 *     at 0.7-1.0, painted metal around 0.4-0.6, glass 0.05-0.15 with
 *     metalness 0. Anything left on the default 1.0 / 0.0 pair looks like
 *     unfinished clay next to the paving.
 *   - Emissive is only a glow if it exceeds 1.0 in linear light. Bloom's
 *     luminance threshold is 1.05, so use `toneMapped={false}` on a bright
 *     colour, or an `emissiveIntensity` of 2 or more. An emissive at 0.3 does
 *     not glow; it just fails to receive shadow.
 *   - Metalness is binary in the real world: 0 or 1, never 0.5.
 *
 * ---------------------------------------------------------------------------
 *
 * Everything below is driven by one number: the hour being viewed. A September
 * day in Seattle runs 06:45 -> 19:15, and the sun's elevation over that arc
 * decides the sun's colour and intensity, the hemisphere fill and how strongly
 * the environment map contributes. Three lights, no more: an HDRI for
 * reflections and ambient, one shadow-casting sun, and a low hemisphere to keep
 * the shaded sides from going flat. `dayModel` and `lotOf` are exported because
 * Stage.tsx works to the same day and the same lot.
 *
 * Nothing here re-renders on an hour change: the targets are recomputed in a
 * memo and every light is damped toward them inside useFrame, which gives the
 * ~0.6 s dissolve the scrubber wants.
 */

import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Environment } from '@react-three/drei';
import * as THREE from 'three';
import type { BuildingType } from '@/types/api';
import { BUILDING_SPECS, type GroundAnchor, anchorsFor, ridgeY } from './layout';

/* -------------------------------------------------------------------------- */
/* The day                                                                     */
/* -------------------------------------------------------------------------- */

/** Civil sunrise / sunset used for the sun arc, in decimal hours. */
const SUNRISE = 6.75;
const SUNSET = 19.25;
/** Solar altitude at noon, Seattle in September. */
const MAX_ELEVATION_DEG = 42;
/** Distance of the sun from the lot centre. Only the direction matters. */
const SUN_DISTANCE = 130;
/**
 * The shadow-casting light is never allowed below this. A sun at half a degree
 * throws a shadow a hundred metres long, which no ortho frustum can hold and
 * which reads as a light leak rather than as dusk.
 */
const MIN_LIGHT_ELEVATION_DEG = 7;

/** 5600 K: the sun near noon. */
const SUN_NOON = new THREE.Color('#ffe7d0');
/** 2800 K: the sun on the horizon. */
const SUN_HORIZON = new THREE.Color('#ffa957');

/* The colour of the sky the site stands under. It is never drawn -- the scene
   has no background -- but the hemisphere light is tinted with it, which is how
   a shaded wall knows whether it is noon or dusk. */

/** Deep blue-grey, never black: the night sky still has a city under it. */
const NIGHT_HORIZON = new THREE.Color('#151d2b');
/** Pale blue haze at noon. */
const DAY_HORIZON = new THREE.Color('#c2d4e2');
/** Warm band along the horizon through the golden hours. */
const GOLD_HORIZON = new THREE.Color('#d9a173');

/** Hemisphere sky tint after dark; the background is far too dark to reuse. */
const NIGHT_HEMI = new THREE.Color('#2d3d59');
/**
 * What the hemisphere light puts into downward-facing surfaces. There is no
 * lawn to bounce any more -- the surface under the site is the dashboard card
 * -- so this is a neutral dark slate rather than grass green.
 */
const GROUND_BOUNCE = new THREE.Color('#1b2430');

/** CC0, Poly Haven. 1K equirectangular, ~1.1 MB, served from /public. */
const HDRI = '/hdri/overcast_soil_puresky_1k.hdr';

const DEG = Math.PI / 180;

export interface DayModel {
  /** Where to put the shadow-casting sun, relative to the lot centre. */
  sunOffset: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  /** 0 fully dark, 1 proper daylight. */
  day: number;
  /** 1 through the golden hours either side of the horizon, 0 otherwise. */
  gold: number;
  /** Sky colour for this hour. Tints the hemisphere fill; never drawn. */
  horizonColor: THREE.Color;
  hemiColor: THREE.Color;
  hemiIntensity: number;
  /** Multiplier on the sky HDRI. */
  envIntensity: number;
  /** Y rotation of that map, so its bright patch tracks the sun. */
  envRotationY: number;
}

/** Everything the lights should settle on, for one hour of the day. */
export function dayModel(hour: number): DayModel {
  const t = (hour - SUNRISE) / (SUNSET - SUNRISE);
  const elevationDeg = Math.sin(Math.PI * t) * MAX_ELEVATION_DEG;
  const azimuthDeg = THREE.MathUtils.clamp(THREE.MathUtils.lerp(-102, 102, t), -115, 115);
  const az = azimuthDeg * DEG;

  /* Wide enough at the bottom that 06:00 and 20:00 read as dusk, not as 03:00. */
  const day = THREE.MathUtils.smoothstep(elevationDeg, -10, 7);
  const gold =
    THREE.MathUtils.smoothstep(elevationDeg, -6, 6) *
    (1 - THREE.MathUtils.smoothstep(elevationDeg, 6, 18));

  const lightElevation = Math.max(elevationDeg, MIN_LIGHT_ELEVATION_DEG) * DEG;
  const horizontal = Math.cos(lightElevation) * SUN_DISTANCE;
  const sunOffset = new THREE.Vector3(
    Math.sin(az) * horizontal,
    Math.sin(lightElevation) * SUN_DISTANCE,
    Math.cos(az) * horizontal,
  );

  const horizonColor = NIGHT_HORIZON.clone()
    .lerp(DAY_HORIZON, day)
    .lerp(GOLD_HORIZON, 0.7 * gold);

  return {
    sunOffset,
    /* A low sun is a warm sun; at noon it is barely tinted at all. */
    sunColor: SUN_NOON.clone().lerp(SUN_HORIZON, gold),
    /* Orange light carries less energy, so the golden hour is a dimmer one too. */
    sunIntensity: day * (4.4 - 2 * gold),
    day,
    gold,
    horizonColor,
    hemiColor: NIGHT_HEMI.clone().lerp(horizonColor, day),
    /* The HDRI is the daytime fill and the hemisphere only covers for it at
       night. Both at once flattens the render: an overcast sky map already
       lights every upward face, and a hemisphere on top of it erases the sun. */
    hemiIntensity: 0.18 - 0.05 * day,
    envIntensity: 0.08 + 0.52 * day,
    envRotationY: az,
  };
}

/* -------------------------------------------------------------------------- */
/* The lot                                                                     */
/* -------------------------------------------------------------------------- */

/** How far the EV bays run out along +x from their anchor, cars included. */
export function evRun(type: BuildingType): number {
  /* A house has a driveway, not a charging court. */
  return type === 'residence' ? 10 : 32;
}

export interface Lot {
  /** Ground-plane centre of everything that has to be lit and shadowed. */
  centre: THREE.Vector3;
  /** Half-width of a square that contains the lot and its shadows. */
  half: number;
}

/**
 * The shadow frustum, sized per site.
 *
 * Centring it on the lot rather than on the origin is worth roughly a third of
 * the shadow map: a commercial site runs from the transformer at x = -24 out
 * past the last EV bay beyond x = +54, so a frustum centred on the building
 * spends half its texels on empty ground. The height term is the slack a raking
 * shadow needs -- a 38 m tower at 20 degrees of elevation throws one a long
 * way, and a 9 m house does not, which is why the residence gets a frustum a
 * third of the size and four times the texel density.
 */
export function lotOf(type: BuildingType): Lot {
  const [width, depth] = BUILDING_SPECS[type].footprint;
  const anchors = anchorsFor(type);
  /* The residence hangs its batteries on a gable wall, so it has no third
     ground anchor to make room for. */
  const ground: GroundAnchor[] =
    anchors.battery === 'wall'
      ? [anchors.grid, anchors.ev]
      : [anchors.grid, anchors.battery, anchors.ev];

  const xs = ground.map((a) => a[0]);
  const zs = ground.map((a) => a[2]);

  const minX = Math.min(-width / 2, ...xs) - 6;
  const maxX = Math.max(width / 2, anchors.ev[0] + evRun(type), ...xs) + 6;
  const minZ = Math.min(-depth / 2, ...zs) - 6;
  const maxZ = Math.max(depth / 2, ...zs) + 8;

  const span = Math.max(maxX - minX, maxZ - minZ) / 2;

  return {
    centre: new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2),
    half: THREE.MathUtils.clamp(span + ridgeY(type) * 0.6, 20, 62),
  };
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

/** Time constant of roughly 0.6 s for every hour-driven transition. */
const LAMBDA = 4.5;

export interface SceneEnvironmentProps {
  /** 0-23, the hour being viewed. */
  hour: number;
  /** Sizes the shadow frustum to the site. */
  type: BuildingType;
}

export function SceneEnvironment({ hour, type }: SceneEnvironmentProps) {
  const target = useMemo(() => dayModel(hour), [hour]);
  const lot = useMemo(() => lotOf(type), [type]);

  const sunRef = useRef<THREE.DirectionalLight>(null);
  const sunTargetRef = useRef<THREE.Object3D>(null);
  const hemiRef = useRef<THREE.HemisphereLight>(null);

  /* The sun aims at the lot centre, which is also where its shadow camera is
     centred. Set once: the target object is a real child of the scene, so its
     world matrix is maintained for us. */
  useEffect(() => {
    const sun = sunRef.current;
    const sunTarget = sunTargetRef.current;
    if (sun && sunTarget) sun.target = sunTarget;
  }, []);

  useEffect(() => {
    const sun = sunRef.current;
    if (!sun) return;
    sun.shadow.mapSize.set(4096, 4096);
    const camera = sun.shadow.camera;
    camera.left = -lot.half;
    camera.right = lot.half;
    camera.top = lot.half;
    camera.bottom = -lot.half;
    camera.near = 20;
    camera.far = SUN_DISTANCE + lot.half + 60;
    camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.02;
    /* three 0.186 dropped PCFSoftShadowMap, so the Canvas asks for PCF, which
       is the variant that actually reads this. At 4096 over a 124 m frustum a
       texel is 3 cm, so 6 of them is an 18 cm penumbra: soft, not smeared. */
    sun.shadow.radius = 6;
    sun.shadow.needsUpdate = true;
  }, [lot]);

  /* Scratch, so useFrame allocates nothing. */
  const sunPosition = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, delta) => {
    // Guard against a long tab-away producing one huge step.
    const dt = Math.min(delta, 0.1);
    const k = 1 - Math.exp(-LAMBDA * dt);

    const scene = state.scene;
    scene.environmentIntensity = THREE.MathUtils.damp(
      scene.environmentIntensity,
      target.envIntensity,
      LAMBDA,
      dt,
    );
    scene.environmentRotation.y = THREE.MathUtils.damp(
      scene.environmentRotation.y,
      target.envRotationY,
      LAMBDA,
      dt,
    );

    const sun = sunRef.current;
    if (sun) {
      sunPosition.copy(lot.centre).add(target.sunOffset);
      sun.position.lerp(sunPosition, k);
      sun.color.lerp(target.sunColor, k);
      sun.intensity = THREE.MathUtils.damp(sun.intensity, target.sunIntensity, LAMBDA, dt);
    }

    const hemi = hemiRef.current;
    if (hemi) {
      hemi.color.lerp(target.hemiColor, k);
      hemi.intensity = THREE.MathUtils.damp(hemi.intensity, target.hemiIntensity, LAMBDA, dt);
    }
  });

  return (
    <>
      {/* Reflections and ambient come from one 1 MB CC0 sky HDRI (Poly Haven,
          "Overcast Soil Pure Sky"), which is what makes glass and painted metal
          read as outdoors rather than as tinted plastic. drei caches the
          decode, so a building switch does not re-fetch it.

          `background={false}` is the whole point: the scene has no background
          at all, so the dashboard card shows through and the HDRI is only ever
          seen in a reflection.

          It gets its own Suspense boundary so the models and the sun do not
          wait on a texture download. Until it lands the scene is lit by the sun
          and the hemisphere alone -- dimmer, but never wrong -- and
          `environmentIntensity` damps in from wherever it is when it arrives. */}
      <Suspense fallback={null}>
        <Environment files={HDRI} background={false} />
      </Suspense>

      <hemisphereLight
        ref={hemiRef}
        intensity={0.95}
        color={NIGHT_HEMI}
        groundColor={GROUND_BOUNCE}
      />

      <object3D ref={sunTargetRef} position={[lot.centre.x, 0, lot.centre.z]} />
      <directionalLight
        ref={sunRef}
        castShadow
        intensity={0}
        color={SUN_NOON}
        position={[lot.centre.x + 40, 90, lot.centre.z + 60]}
      />
    </>
  );
}

export default SceneEnvironment;
