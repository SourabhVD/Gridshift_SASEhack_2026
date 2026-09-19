'use client';

/**
 * Sky, sun and ground for the energy scene.
 *
 * Everything is driven by one number: the hour being viewed. A September day in
 * Seattle runs 06:45 → 19:15, and the sun's elevation over that arc decides the
 * background colour, the fog, the key light's colour and intensity, how much
 * hemisphere fill there is, and whether the four lamp posts are lit.
 *
 * Two deliberate cheats keep the picture readable when the sun is down:
 *   - the key light never drops below 14° of elevation, so night shadows still
 *     fall downward instead of raking up from under the ground plane;
 *   - the fill lights are strongest at night, not weakest: the surface palette
 *     bottoms out near 3 % reflectance, so without a generous ambient and a
 *     hemisphere tint that does not follow the near-black sky, a warehouse at
 *     02:00 is a silhouette rather than a shape.
 *
 * Nothing here re-renders on an hour change: the targets are recomputed in a
 * memo and every light is damped toward them inside useFrame, which gives the
 * ~0.6 s dissolve the scrubber wants.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { ANCHORS } from './layout';

/** Civil sunrise / sunset used for the sun arc, in decimal hours. */
const SUNRISE = 6.75;
const SUNSET = 19.25;
/** Solar altitude at noon, Seattle in September. */
const MAX_ELEVATION_DEG = 42;
/** Distance of the key light from the origin. */
const SUN_DISTANCE = 120;
/** Key light is never positioned lower than this, however deep the night. */
const MIN_LIGHT_ELEVATION_DEG = 14;

const NIGHT_SKY = new THREE.Color('#0a0f1a');
const DAY_SKY = new THREE.Color('#a9c6e0');
const GOLD_SKY = new THREE.Color('#b9825f');

const MOON_LIGHT = new THREE.Color('#93a9d1');
const GOLD_LIGHT = new THREE.Color('#ffb26b');
const NOON_LIGHT = new THREE.Color('#fff4e2');

const NIGHT_AMBIENT = new THREE.Color('#8fa8c8');
const DAY_AMBIENT = new THREE.Color('#cfe0f2');
/** Sky tint for the hemisphere fill after dark; the background is far too dark
    to double as a light source. */
const NIGHT_HEMI = new THREE.Color('#33496a');
/** The lawn bounces green back up into the undersides. */
const GROUND_BOUNCE = new THREE.Color('#2c4a2a');

const LAMP_COLOR = '#ffb774';

/** Lamp posts: near each device anchor, plus one on the building's approach. */
const LAMP_POSTS: readonly [number, number][] = [
  [ANCHORS.grid[0] + 5, ANCHORS.grid[2] - 4],
  [ANCHORS.battery[0] + 5, ANCHORS.battery[2] + 3],
  [ANCHORS.ev[0] - 5, ANCHORS.ev[2] - 3],
  [0, 26],
];
const LAMP_HEIGHT = 7;

const DEG = Math.PI / 180;

interface SkyTargets {
  sunPosition: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  skyColor: THREE.Color;
  hemiColor: THREE.Color;
  ambientColor: THREE.Color;
  ambientIntensity: number;
  hemiIntensity: number;
  lampIntensity: number;
}

/** Everything the lights should settle on, for one hour of the day. */
function skyTargets(hour: number): SkyTargets {
  const t = (hour - SUNRISE) / (SUNSET - SUNRISE);
  const elevationDeg = Math.sin(Math.PI * t) * MAX_ELEVATION_DEG;
  const azimuthDeg = THREE.MathUtils.clamp(THREE.MathUtils.lerp(-102, 102, t), -115, 115);

  /** 0 fully dark, 1 proper daylight. */
  const day = THREE.MathUtils.smoothstep(elevationDeg, -3, 12);
  /** 1 through the golden hours either side of the horizon, 0 otherwise. */
  const twilight = THREE.MathUtils.smoothstep(elevationDeg, -9, 4);
  const gold = twilight * (1 - THREE.MathUtils.smoothstep(elevationDeg, 4, 20));

  const lightElevation = Math.max(elevationDeg, MIN_LIGHT_ELEVATION_DEG) * DEG;
  const az = azimuthDeg * DEG;
  const horizontal = Math.cos(lightElevation) * SUN_DISTANCE;
  const sunPosition = new THREE.Vector3(
    Math.sin(az) * horizontal,
    Math.sin(lightElevation) * SUN_DISTANCE,
    Math.cos(az) * horizontal,
  );

  const warm = GOLD_LIGHT.clone().lerp(NOON_LIGHT, 1 - gold);
  const sunColor = MOON_LIGHT.clone().lerp(warm, day);

  const skyColor = NIGHT_SKY.clone().lerp(DAY_SKY, day).lerp(GOLD_SKY, 0.65 * gold);
  const hemiColor = NIGHT_HEMI.clone().lerp(skyColor, day);

  return {
    sunPosition,
    sunColor,
    sunIntensity: 0.9 + 2.6 * day,
    skyColor,
    hemiColor,
    ambientColor: NIGHT_AMBIENT.clone().lerp(DAY_AMBIENT, day),
    ambientIntensity: 0.95 - 0.45 * day,
    hemiIntensity: 1 + 0.6 * day,
    lampIntensity: 62 * (1 - day),
  };
}

/** Time constant of roughly 0.6 s for every hour-driven transition. */
const LAMBDA = 4.5;

export interface SceneEnvironmentProps {
  /** 0–23, the hour being viewed. */
  hour: number;
}

export function SceneEnvironment({ hour }: SceneEnvironmentProps) {
  const targets = useMemo(() => skyTargets(hour), [hour]);

  const backgroundRef = useRef<THREE.Color>(null);
  const fogRef = useRef<THREE.Fog>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const hemiRef = useRef<THREE.HemisphereLight>(null);
  const lampsRef = useRef<THREE.Group>(null);

  /* The shadow camera is set once, imperatively: it has to cover the whole
     lot, from the transformer at x = −24 to the last EV bay out past x = +50. */
  useEffect(() => {
    const sun = sunRef.current;
    if (!sun) return;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = -62;
    cam.right = 62;
    cam.top = 62;
    cam.bottom = -62;
    cam.near = 1;
    cam.far = 260;
    cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.06;
    sun.shadow.radius = 4;
  }, []);

  useFrame((_, delta) => {
    // Guard against a long tab-away producing one huge step.
    const dt = Math.min(delta, 0.1);
    const k = 1 - Math.exp(-LAMBDA * dt);

    const background = backgroundRef.current;
    if (background) background.lerp(targets.skyColor, k);
    const fog = fogRef.current;
    if (fog && background) fog.color.copy(background);

    const sun = sunRef.current;
    if (sun) {
      sun.position.lerp(targets.sunPosition, k);
      sun.color.lerp(targets.sunColor, k);
      sun.intensity = THREE.MathUtils.damp(sun.intensity, targets.sunIntensity, LAMBDA, dt);
    }

    const ambient = ambientRef.current;
    if (ambient) {
      ambient.color.lerp(targets.ambientColor, k);
      ambient.intensity = THREE.MathUtils.damp(
        ambient.intensity,
        targets.ambientIntensity,
        LAMBDA,
        dt,
      );
    }

    const hemi = hemiRef.current;
    if (hemi) {
      hemi.color.lerp(targets.hemiColor, k);
      hemi.intensity = THREE.MathUtils.damp(hemi.intensity, targets.hemiIntensity, LAMBDA, dt);
    }

    const lamps = lampsRef.current;
    if (lamps) {
      for (const child of lamps.children) {
        const light = child.getObjectByName('lamp-light') as THREE.PointLight | undefined;
        if (light) {
          light.intensity = THREE.MathUtils.damp(
            light.intensity,
            targets.lampIntensity,
            LAMBDA,
            dt,
          );
        }
        const head = child.getObjectByName('lamp-head') as THREE.Mesh | undefined;
        const material = head?.material as THREE.MeshStandardMaterial | undefined;
        if (material) {
          material.emissiveIntensity = THREE.MathUtils.damp(
            material.emissiveIntensity,
            targets.lampIntensity / 24,
            LAMBDA,
            dt,
          );
        }
      }
    }
  });

  return (
    <>
      <color ref={backgroundRef} attach="background" args={['#0a0f1a']} />
      <fog ref={fogRef} attach="fog" args={['#0a0f1a', 150, 470]} />

      <ambientLight ref={ambientRef} intensity={0.95} color="#8fa8c8" />
      <hemisphereLight
        ref={hemiRef}
        intensity={1}
        color="#33496a"
        groundColor={GROUND_BOUNCE}
      />
      <directionalLight
        ref={sunRef}
        castShadow
        intensity={0.2}
        color="#93a9d1"
        position={[40, 60, 60]}
      />

      {/* Ground: a lawn, as a disc so the horizon never shows a square edge. It
          runs 260 m out while the fog only starts at 150 m, so the rim has
          faded into the sky long before it could read as an edge — and the lot
          itself, well inside 150 m, stays crisp. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[260, 96]} />
        <meshStandardMaterial color="#3f6b3a" roughness={1} metalness={0} />
      </mesh>

      <group ref={lampsRef}>
        {LAMP_POSTS.map(([x, z]) => (
          <group key={`${x},${z}`} position={[x, 0, z]}>
            <mesh position={[0, LAMP_HEIGHT / 2, 0]} castShadow>
              <cylinderGeometry args={[0.12, 0.18, LAMP_HEIGHT, 6]} />
              <meshStandardMaterial color="#374151" roughness={0.8} flatShading />
            </mesh>
            <mesh name="lamp-head" position={[0, LAMP_HEIGHT + 0.2, 0]}>
              <sphereGeometry args={[0.42, 10, 8]} />
              <meshStandardMaterial
                color="#2b2118"
                emissive={LAMP_COLOR}
                emissiveIntensity={0}
                roughness={0.5}
              />
            </mesh>
            <pointLight
              name="lamp-light"
              position={[0, LAMP_HEIGHT, 0]}
              color={LAMP_COLOR}
              intensity={0}
              distance={34}
              decay={2}
            />
          </group>
        ))}
      </group>
    </>
  );
}

export default SceneEnvironment;
