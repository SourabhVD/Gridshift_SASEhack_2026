'use client';

/**
 * Draws a generated model, or the procedural prop it stands in for.
 *
 * `useGLTF` reports a failed fetch by *throwing out of render*, and Suspense
 * only catches the promise, not the error -- so without a boundary a missing or
 * corrupt file under `public/models` would take the whole Canvas down instead
 * of one prop. There is no retry: if the file is not there on the first paint
 * it will not be there on the second, and a scene that quietly draws its
 * procedural shell is the right outcome.
 *
 * Error boundary outside, Suspense inside, so the one stand-in serves both the
 * in-flight frame and the permanent failure.
 */

import { Component, Suspense, type ReactNode } from 'react';

export interface GlbOrFallbackProps {
  /** Only used in the warning, so a console line names the file that failed. */
  src: string;
  /** The procedural prop. Drawn while loading, and for good if loading fails. */
  fallback: ReactNode;
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
}

class ModelBoundary extends Component<GlbOrFallbackProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn(
      '[scene] ' + this.props.src + ' did not load; drawing the procedural prop',
      error,
    );
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function GlbOrFallback(props: GlbOrFallbackProps) {
  return (
    <ModelBoundary {...props}>
      <Suspense fallback={props.fallback}>{props.children}</Suspense>
    </ModelBoundary>
  );
}

export default GlbOrFallback;
