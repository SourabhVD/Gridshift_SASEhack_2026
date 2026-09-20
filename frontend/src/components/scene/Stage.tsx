'use client';

/**
 * The surface the site stands on -- and deliberately, almost nothing else.
 *
 * There is no lawn, no sky and no drive. The 3D view is not a window onto a
 * field; it is the top of a dark dashboard, and the way to make it feel
 * embedded rather than pasted on is to let the page's own colour be the
 * background. So the Canvas clears to transparent, the scene has no
 * `background`, and everything below exists only to stop the models floating:
 *
 *   - a shadow catcher: one very large disc with `ShadowMaterial`, invisible
 *     except where the sun's shadow falls on it. It gives the long directional
 *     shadow that says "ten in the morning" without introducing a floor colour
 *     that would then have to be reconciled with the page.
 *   - drei <ContactShadows>: a soft occlusion pool directly under the geometry,
 *     which is what actually welds a building to a surface. Its material is an
 *     ordinary alpha-blended plane, so it composites over the transparent
 *     background and onto the page exactly as it would over a floor.
 *   - fog in the page's own colour, so anything far enough back dissolves into
 *     the background rather than ending.
 *
 * The result reads as an object resting on the dashboard rather than as a
 * diorama in a box.
 */

import { useMemo } from 'react';
import { ContactShadows } from '@react-three/drei';
import type { BuildingType } from '@/types/api';
import type { ViewLevel } from '@/lib/store';
import { focusLot } from './Environment';

/**
 * --color-base, the page background.
 *
 * The scene is the page's hero now, not an inset panel: the fog, the shadow
 * tint and `bg-base` all have to be the same black or the frame shows up as a
 * rectangle exactly where the hero is trying not to have one.
 */
export const PAGE_BASE = '#000000';

/**
 * How dark the sun's cast shadow is allowed to get on the bare page. Lower than
 * it would be on a lawn: there is no lit surface next to it to judge it
 * against, so a shadow that reads as "strong sunlight" outdoors reads as a hole
 * punched in the dashboard here. Raised again for the true-black page -- a
 * shadow tinted #000 over a #000 ground has nothing left to darken, so what
 * actually reads is the alpha, and 0.36 of it had stopped registering.
 */
const SUN_SHADOW_OPACITY = 0.4;
/** The contact pool is lighter; the two stack wherever both apply. */
const CONTACT_OPACITY = 0.22;

/**
 * Contact shadows sit 4 cm up so that nothing at grade -- a device pad, a
 * painted bay, the catcher itself -- is caught by their upward-looking camera
 * and painted black.
 */
const CONTACT_Y = 0.04;

/**
 * Fog, per level.
 *
 * At site level the camera is 60-120 m out and 150 m is where "far away"
 * starts. At portfolio it is ~450 m up, so the SAME numbers would fog the whole
 * campus into the background -- the depth cue would eat the subject. The
 * portfolio band starts past the nearest lot and only ever touches the far
 * corners, which is all it is there to do.
 */
const SITE_FOG: [number, number] = [150, 650];
const CAMPUS_FOG: [number, number] = [430, 1300];

export interface StageProps {
  /** 0-23, the hour being viewed. Only used to re-bake the contact shadows. */
  hour: number;
  type: BuildingType;
  level: ViewLevel;
  campusTypes: readonly BuildingType[];
}

export function Stage({ hour, type, level, campusTypes }: StageProps) {
  const campusKey = campusTypes.join(',');
  const lot = useMemo(
    () => focusLot(level, type, campusTypes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [level, type, campusKey],
  );
  const fog = level === 'portfolio' ? CAMPUS_FOG : SITE_FOG;

  return (
    <>
      {/* No <color attach="background"> on purpose: the scene stays
          transparent and the dashboard shows through. */}
      <fog attach="fog" args={[PAGE_BASE, fog[0], fog[1]]} />

      {/* Shadow catcher. Invisible wherever nothing is shadowed, which is most
          of it, so there is no floor colour to reconcile with the page. Tinted
          to the page's own black rather than pure black, so the shadow deepens
          the background instead of punching through it. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[400, 64]} />
        <shadowMaterial
          transparent
          color={PAGE_BASE}
          opacity={SUN_SHADOW_OPACITY}
          depthWrite={false}
        />
      </mesh>

      {/* One bake is enough -- the geometry never moves. Keyed so a building
          swap or an hour change regenerates it.

          Site level only. A 1024 map stretched over a 260 m campus is a 25 cm
          texel, which is not a contact shadow -- it is a grey smudge under four
          buildings. Up there the sun's own cast shadow carries the weight. */}
      {level === 'site' && (
        <ContactShadows
          key={`${type}-${Math.round(hour)}`}
          position={[lot.centre.x, CONTACT_Y, lot.centre.z]}
          /* Follows the lot, so a 25 m house lot is not paying for a 120 m map. */
          scale={lot.half * 2}
          resolution={1024}
          blur={2.2}
          opacity={CONTACT_OPACITY}
          /* Only the first 12 m above grade occludes. Higher than that and a
             38 m tower paints a grey slab that no sun direction explains. */
          far={12}
          frames={1}
        />
      )}
    </>
  );
}

export default Stage;
