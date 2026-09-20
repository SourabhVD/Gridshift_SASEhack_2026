'use client';

/**
 * The four feeders: one conduit from the substation bus to each site's grid
 * intake, carrying that site's own import.
 *
 * This is the campus-scale version of the five runs inside a lot, and it keeps
 * the same reading rules so the two never contradict each other:
 *
 *   thickness   that site's grid_kw as a share of the busiest site this hour,
 *               0.25 m to 0.9 m
 *   particles   beads running substation -> site, because a feeder only ever
 *               delivers; speed is the same share
 *   colour      the grid channel, and the grid channel's two states -- alert
 *               when that site is over its own cap, good when it is running an
 *               optimized plan that holds it under
 *
 * The one InstancedMesh rule holds here too: `FlowParticles` carries every bead
 * on all four lines, so the whole campus costs four tubes and one particle
 * mesh. The tube itself is `devices/Conduit`, unchanged -- a feeder and a site
 * run are the same object at two scales, and giving them two implementations
 * would be two places for the colour states to drift apart.
 */

import { useMemo } from 'react';
import { CatmullRomCurve3 } from 'three';
import type { Building } from '@/types/api';
import { Conduit, type ConduitScale } from './devices/Conduit';
import { FlowParticles, type ParticleStream } from './devices/FlowParticles';
import { C, MAX_PARTICLES } from './devices/common';
import { feedRoute } from './world';

/** A utility feeder is a bigger object than a site's own armoured run. */
const MIN_RADIUS = 0.25;
const MAX_RADIUS = 0.9;
/** Quantised, so the TubeGeometry is rebuilt on a step and not on a kW. */
const RADIUS_BUCKETS = 8;
/** Below this the site is effectively off and its feeder goes quiet. */
const DORMANT_KW = 1;

/** What one site's feeder is doing this hour. */
export interface FeedReading {
  id: string;
  building: Building;
  gridKw: number;
  /** Over that site's own billed cap. */
  over: boolean;
  /** Holding under the cap on an optimized plan. */
  good: boolean;
}

/**
 * Same shape `Conduit` wants, solved for the campus band rather than the lot
 * band. Quantise first, then derive the radius from the bucket, so `radius` is
 * a stable memo dependency.
 */
function feedScale(kw: number, maxKw: number): ConduitScale {
  const magnitude = Math.abs(kw);
  const share = maxKw > 0 ? Math.min(1, magnitude / maxKw) : 0;
  const dormant = magnitude < DORMANT_KW;
  const bucket = Math.min(RADIUS_BUCKETS - 1, Math.floor(share * RADIUS_BUCKETS));
  return {
    radius: MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * ((bucket + 0.5) / RADIUS_BUCKETS),
    dormant,
    count: dormant ? 0 : Math.min(MAX_PARTICLES, 10 + Math.round(22 * share)),
    speed: 0.05 + 0.22 * share,
  };
}

export interface FeedLinesProps {
  readings: readonly FeedReading[];
}

export function FeedLines({ readings }: FeedLinesProps) {
  /* Routing depends only on which sites exist, so the curves -- and with them
     the tube geometries and the particle lookup tables -- survive every hour
     and every colour change. */
  const key = readings.map((r) => r.building.type).join(',');
  const curves = useMemo(
    () =>
      readings.map(
        (reading) =>
          new CatmullRomCurve3(feedRoute(reading.building.type), false, 'centripetal', 0.5),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const maxKw = useMemo(
    () => Math.max(1, ...readings.map((reading) => Math.abs(reading.gridKw))),
    [readings],
  );

  const lines = useMemo(
    () =>
      readings.map((reading, i) => ({
        id: reading.id,
        curve: curves[i],
        scale: feedScale(reading.gridKw, maxKw),
        /* Alert outranks good: a site that is over its cap is over its cap
           whatever mode the page is in. */
        color: reading.over ? C.alert : reading.good ? C.good : C.grid,
      })),
    [readings, curves, maxKw],
  );

  const streams = useMemo<ParticleStream[]>(
    () =>
      lines.map((line) => ({
        curve: line.curve,
        count: line.scale.count,
        speed: line.scale.speed,
        /* Authored substation -> site, and a feeder only ever delivers. */
        reverse: false,
        color: line.color,
        radius: line.scale.radius,
      })),
    [lines],
  );

  if (lines.length === 0) return null;

  return (
    <group name="feed-lines">
      {lines.map((line) => (
        <Conduit key={line.id} curve={line.curve} scale={line.scale} color={line.color} />
      ))}
      <FlowParticles streams={streams} />
    </group>
  );
}

export default FeedLines;
