'use client';

/**
 * Free-standing name sign on the pad, in front of the building. The text is
 * drawn into a CanvasTexture (see materials.ts) so there is no webfont fetch
 * and no extra geometry per glyph.
 */
import type * as THREE from 'three';
import { useEffect, useMemo } from 'react';
import { makeLabelTexture, PALETTE } from './materials';

export interface NameSignProps {
  name: string;
  /** Position of the sign base. */
  position: [number, number, number];
  /** Panel width in metres. */
  width?: number;
  height?: number;
  /** Rotation about Y. Default faces +z. */
  ry?: number;
  accent?: string;
}

export function NameSign({
  name,
  position,
  width = 6,
  height = 1.4,
  ry = 0,
  accent = PALETTE.highlight,
}: NameSignProps) {
  const texture = useMemo(
    () =>
      makeLabelTexture(name.toUpperCase(), {
        width: 640,
        height: 160,
        background: '#0b1220',
        color: '#e2e8f0',
      }),
    [name],
  );

  useEffect(() => {
    const current: THREE.CanvasTexture | null = texture;
    return () => {
      current?.dispose();
    };
  }, [texture]);

  const postH = 1.1;

  return (
    <group position={position} rotation={[0, ry, 0]}>
      {/* two posts */}
      <mesh position={[0, postH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.9, postH, 0.25]} />
        <meshStandardMaterial color={PALETTE.signPost} roughness={0.8} metalness={0.2} />
      </mesh>
      {/* panel */}
      <mesh position={[0, postH + height / 2, 0.06]} castShadow receiveShadow>
        <boxGeometry args={[width, height, 0.18]} />
        <meshStandardMaterial
          map={texture}
          emissiveMap={texture}
          color={texture ? '#ffffff' : '#0b1220'}
          emissive="#ffffff"
          emissiveIntensity={0.45}
          roughness={0.7}
          metalness={0.1}
        />
      </mesh>
      {/* accent bar under the panel */}
      <mesh position={[0, postH + 0.06, 0.1]} castShadow receiveShadow>
        <boxGeometry args={[width, 0.12, 0.22]} />
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={0.9}
          roughness={0.6}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

export default NameSign;
