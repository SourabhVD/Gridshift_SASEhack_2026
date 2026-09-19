'use client';

/**
 * Charging, at two very different scales.
 *
 * Commercial -- a court of painted bays running along +x from the EV anchor,
 * a 1.4 m powder-coated pedestal per bay with a screen that lights teal when
 * the bay is drawing, a coiled lead, and a car in most of them.
 *
 * A bay is "active" when the site's EV draw reaches it --
 * `round(ev_kw / (ev_bays * 11 kW) * bays)`. When `ev_kw` is 0 (night) roughly
 * half the bays stand empty, chosen deterministically so the scene never
 * flickers.
 *
 * Residence -- one bay on the drive, a wall charger on the front-left wall by
 * the meter, and a single car reversed in. The lead is only drawn while the car
 * is actually charging; the rest of the time the coil hangs on the wall.
 *
 * Draw calls -- commercial 5 (apron, pedestals, lit quads, leads, and the one
 * InstancedMesh every car on the court shares), residence 5. If the car model
 * fails to load the procedural stand-in takes those to 9 and 9, which is what
 * they were before the model landed.
 */

import { useEffect, useMemo } from 'react';
import { CatmullRomCurve3, TubeGeometry, Vector3 } from 'three';
import type { BuildingType } from '@/types/api';
import { formatKw } from '@/lib/format';
import { C, DORMANT_KW, MAT, type EvPlan, glow, hash01, isResidence } from './common';
import { Car, CarFleet, chargePort, type CarPlacement } from './Car';
import { Boxes, Clones, RoundedBoxes, type Piece } from './Instanced';
import { NodeLabel } from './NodeLabel';
import { RESIDENCE } from './paths';

const BAY_W = 2.6;
const BAY_D = 5.4;
/** Pedestals stand on the +z aisle, the side the scene is normally viewed from,
 *  so a lit screen and a live lead are never hidden behind the car. */
const PEDESTAL_Z = BAY_D / 2 + 0.3;
const PEDESTAL_H = 1.4;
const CAR_Z = -0.3;

/* -------------------------------------------------------------------------- */
/* The charging lead                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One lead, authored around a pedestal at the origin: three turns of coil
 * hanging off its flank, then a sagging run to the car's rear-left port.
 *
 * Every bay's lead is the same shape, so this single tube is instanced per
 * *live* bay rather than rebuilt -- the whole court's cabling is one draw call.
 */
function buildLeadGeometry(): TubeGeometry {
  const points: Vector3[] = [];
  const turns = 3;
  const coilR = 0.085;
  const top = 1.16;
  const bottom = 0.74;
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * turns * Math.PI * 2;
    points.push(
      new Vector3(0.22 + Math.cos(a) * coilR, top - t * (top - bottom), Math.sin(a) * coilR),
    );
  }
  // ...and out to the port, which sits at (-0.94, 0.86, CAR_Z + 1.55) relative
  // to the bay, i.e. this far from the pedestal.
  const portZ = CAR_Z + 1.55 - PEDESTAL_Z;
  points.push(new Vector3(0.05, 0.5, portZ * 0.28));
  points.push(new Vector3(-0.45, 0.34, portZ * 0.58));
  points.push(new Vector3(-0.88, 0.6, portZ * 0.92));
  points.push(new Vector3(-0.94, 0.86, portZ));
  return new TubeGeometry(
    new CatmullRomCurve3(points, false, 'centripetal', 0.5),
    120,
    0.024,
    6,
    false,
  );
}

/* -------------------------------------------------------------------------- */
/* Commercial court                                                            */
/* -------------------------------------------------------------------------- */

interface Court {
  /** Asphalt apron, bay markings and the pedestal footings. */
  ground: Piece[];
  /** Powder-coated pedestal shells. */
  pedestals: Piece[];
  /** Unlit quads: the pedestal screens. */
  lit: Piece[];
  /** One per live bay; the lead geometry is instanced onto these. */
  leads: Piece[];
  /** One entry per occupied bay; `<CarFleet>` turns these into instances. */
  cars: CarPlacement[];
}

function buildCourt(bays: number, activeBays: number, evKw: number, accent: string): Court {
  const ground: Piece[] = [];
  const pedestals: Piece[] = [];
  const lit: Piece[] = [];
  const leads: Piece[] = [];
  const cars: CarPlacement[] = [];

  const rowW = bays * BAY_W;

  ground.push({ p: [rowW / 2, 0.005, 0], s: [rowW + 0.6, 0.01, BAY_D + 1.2], c: C.asphalt });
  for (let i = 0; i <= bays; i++) {
    ground.push({ p: [i * BAY_W, 0.02, 0], s: [0.12, 0.02, BAY_D], c: C.markings });
  }
  ground.push({ p: [rowW / 2, 0.02, -BAY_D / 2], s: [rowW, 0.02, 0.12], c: C.markings });

  for (let i = 0; i < bays; i++) {
    const x = i * BAY_W + BAY_W / 2;
    const active = i < activeBays;
    // At night half the bays stand empty; by day every modelled bay is taken.
    const occupied = evKw > 0 || hash01(i * 3 + 7) > 0.45;

    ground.push({ p: [x, 0.05, PEDESTAL_Z], s: [0.62, 0.1, 0.56], c: C.concrete });
    pedestals.push({
      p: [x, 0.1 + PEDESTAL_H / 2, PEDESTAL_Z],
      s: [0.4, PEDESTAL_H, 0.34],
      c: C.powder,
    });
    // Screen: dark plastic when idle, teal and above the bloom cut when live.
    lit.push({
      p: [x, 1.12, PEDESTAL_Z + 0.18],
      s: [0.26, 0.34, 0.03],
      c: active ? glow(accent) : C.dark,
    });

    if (active) leads.push({ p: [x, 0, PEDESTAL_Z], s: [1, 1, 1] });
    if (occupied) cars.push({ at: [x, 0, CAR_Z], paint: i, active });
  }

  return { ground, pedestals, lit, leads, cars };
}

/* -------------------------------------------------------------------------- */
/* Residence drive                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A parking apron beside the +x elevation, not a driveway running away from the
 * house: the car is reversed onto it broadside, so the slab has to be long in x
 * and shallow in z. Kept clear of the heat-pump pad at z = 2.8.
 */
const DRIVE: Piece[] = [
  { p: [9.6, 0.04, 6.2], s: [6, 0.08, 3.6], c: C.concrete },
  { p: [9.6, 0.09, 4.6], s: [5.6, 0.02, 0.1], c: C.markings },
  { p: [9.6, 0.09, 7.8], s: [5.6, 0.02, 0.1], c: C.markings },
];

/** Reversed onto the drive, so the rear-left port faces the house. */
const CAR_YAW = -Math.PI / 2;
const RESIDENCE_PORT = chargePort(RESIDENCE.bay, CAR_YAW);

const WALL_CHARGER: Piece[] = [
  { p: RESIDENCE.charger, s: [0.35, 0.55, 0.12], c: C.powder },
  // Back plate, straddling the front wall plane so the unit is bolted to it.
  {
    p: [RESIDENCE.charger[0], RESIDENCE.charger[1], RESIDENCE.frontZ + 0.005],
    s: [0.42, 0.62, 0.03],
    c: C.dark,
  },
];

/**
 * The domestic lead. It drops down the wall and runs along the base of the
 * front elevation before turning out to the car, rather than cutting straight
 * across the lawn.
 */
function buildResidenceLead(): TubeGeometry {
  const curve = new CatmullRomCurve3(
    [
      new Vector3(RESIDENCE.charger[0] + 0.1, RESIDENCE.charger[1] - 0.24, RESIDENCE.charger[2]),
      new Vector3(RESIDENCE.charger[0] + 0.35, 0.36, RESIDENCE.frontZ + 0.24),
      new Vector3(-2.5, 0.1, RESIDENCE.frontZ + 0.3),
      new Vector3(3.5, 0.1, RESIDENCE.frontZ + 0.26),
      new Vector3(6.6, 0.16, RESIDENCE.frontZ - 0.05),
      new Vector3(RESIDENCE_PORT[0] - 0.2, 0.55, RESIDENCE_PORT[2] + 0.1),
      new Vector3(RESIDENCE_PORT[0], RESIDENCE_PORT[1], RESIDENCE_PORT[2]),
    ],
    false,
    'centripetal',
    0.5,
  );
  return new TubeGeometry(curve, 140, 0.03, 6, false);
}

/** The coil that hangs on the wall charger when nothing is plugged in. */
function buildResidenceCoil(): TubeGeometry {
  const points: Vector3[] = [];
  for (let i = 0; i <= 22; i++) {
    const t = i / 22;
    const a = t * 3 * Math.PI * 2;
    points.push(
      new Vector3(
        RESIDENCE.charger[0] + 0.24 + Math.cos(a) * 0.09,
        RESIDENCE.charger[1] - 0.06 - t * 0.34,
        RESIDENCE.charger[2] + Math.sin(a) * 0.07,
      ),
    );
  }
  return new TubeGeometry(
    new CatmullRomCurve3(points, false, 'centripetal', 0.5),
    80,
    0.026,
    6,
    false,
  );
}

/* -------------------------------------------------------------------------- */

export interface EvBaysProps {
  type: BuildingType;
  /** Commercial anchor; the residence lays itself out in world space instead. */
  position: readonly [number, number, number];
  plan: EvPlan;
  /** Real bay count from the building record, for the label. */
  totalBays: number;
  evKw: number;
  accent: string;
}

export function EvBays({ type, position, plan, totalBays, evKw, accent }: EvBaysProps) {
  const residence = isResidence(type);

  /* ---- residence ------------------------------------------------------- */
  const charging = evKw >= DORMANT_KW;
  const residenceLead = useMemo(
    () => (residence ? (charging ? buildResidenceLead() : buildResidenceCoil()) : null),
    [residence, charging],
  );
  useEffect(() => () => residenceLead?.dispose(), [residenceLead]);

  const chargerLit = useMemo<Piece[]>(
    () => [
      {
        p: [RESIDENCE.charger[0], RESIDENCE.charger[1] + 0.09, RESIDENCE.charger[2] + 0.062],
        s: [0.2, 0.13, 0.01],
        c: charging ? glow(accent) : C.dark,
      },
    ],
    [charging, accent],
  );

  /* ---- commercial ------------------------------------------------------ */
  const court = useMemo(
    () => (residence ? null : buildCourt(plan.rendered, plan.activeRendered, evKw, accent)),
    [residence, plan.rendered, plan.activeRendered, evKw, accent],
  );
  const leadGeometry = useMemo(() => (residence ? null : buildLeadGeometry()), [residence]);
  useEffect(() => () => leadGeometry?.dispose(), [leadGeometry]);

  const value = plan.multiplier > 1 ? `${formatKw(evKw)} · ×${plan.multiplier}` : formatKw(evKw);

  if (residence) {
    return (
      <group>
        <Boxes pieces={DRIVE} castShadow={false}>
          <meshStandardMaterial color="#ffffff" {...MAT.concrete} />
        </Boxes>

        <RoundedBoxes pieces={WALL_CHARGER} radius={0.06}>
          <meshStandardMaterial color="#ffffff" {...MAT.powder} />
        </RoundedBoxes>

        <Boxes pieces={chargerLit} castShadow={false}>
          <meshBasicMaterial color="#ffffff" toneMapped={false} />
        </Boxes>

        {residenceLead ? (
          <mesh geometry={residenceLead} castShadow receiveShadow>
            <meshStandardMaterial color={C.rubber} {...MAT.rubber} />
          </mesh>
        ) : null}

        <Car position={RESIDENCE.bay} rotation={[0, CAR_YAW, 0]} color={C.carPaint} />

        <NodeLabel
          // Out over the far end of the apron: at [9, *, 6] it collided with
          // the heat pump's pill in screen space.
          position={[11.5, 2.4, 8.4]}
          name={`EV · ${charging ? 'charging' : 'idle'}`}
          value={value}
        />
      </group>
    );
  }

  if (!court || !leadGeometry) return null;
  const rowW = plan.rendered * BAY_W;

  return (
    <group position={position as [number, number, number]}>
      <Boxes pieces={court.ground} castShadow={false}>
        <meshStandardMaterial color="#ffffff" {...MAT.concrete} />
      </Boxes>

      <RoundedBoxes pieces={court.pedestals} radius={0.045}>
        <meshStandardMaterial color="#ffffff" {...MAT.powder} />
      </RoundedBoxes>

      {/* Pedestal screens. Unlit; only the live ones are above the cut. */}
      <Boxes pieces={court.lit} castShadow={false}>
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </Boxes>

      <Clones geometry={leadGeometry} pieces={court.leads} receiveShadow={false}>
        <meshStandardMaterial color={C.rubber} {...MAT.rubber} />
      </Clones>

      <CarFleet placements={court.cars} />

      <NodeLabel
        position={[rowW / 2, 3.4, 0]}
        name={`EV · ${plan.activeTotal} of ${totalBays} charging`}
        value={value}
      />
    </group>
  );
}

export default EvBays;
