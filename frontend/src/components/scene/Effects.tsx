'use client';

/**
 * The post-processing chain, mounted only when `useQuality()` says 'high'.
 *
 * Order matters and is not the order the effects are named in:
 *
 *   Bloom        runs first, on the HDR buffer, so only values that are
 *                genuinely above 1.0 in linear light bleed. Everything the
 *                scene wants to glow (conduits, flow particles, lamp heads,
 *                lit windows) is authored `toneMapped={false}` or with an
 *                emissiveIntensity >= 2 for exactly this reason.
 *   ToneMapping  @react-three/postprocessing forces the renderer to
 *                NoToneMapping while a composer is mounted, so the ACES curve
 *                the Canvas asks for has to be re-applied here. It still reads
 *                `gl.toneMappingExposure`, so the exposure set on the Canvas is
 *                the single source of truth for both quality levels.
 *   Vignette     a small corner falloff, applied to the graded image.
 *   SMAA         last, on the final LDR image, which is where edge detection
 *                belongs. This is why the Canvas turns MSAA off in 'high'.
 */

import { Bloom, EffectComposer, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';

export function Effects() {
  return (
    <EffectComposer multisampling={0}>
      <Bloom
        mipmapBlur
        intensity={0.55}
        luminanceThreshold={1.05}
        luminanceSmoothing={0.25}
      />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Vignette eskil={false} offset={0.25} darkness={0.35} />
      <SMAA />
    </EffectComposer>
  );
}

export default Effects;
