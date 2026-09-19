import type { Building, EnergyFlows } from '@/types/api';
export type SceneMode = 'baseline' | 'optimized';
export type SceneRunStatus = 'idle' | 'running' | 'awaiting_approval' | 'approved' | 'rejected' | 'failed';
/** Implemented by scene/buildings (sibling agent). Renders ONLY the building shell + ground pad + signage at the origin. */
export interface BuildingModelProps { building: Building; loadRatio: number; /* grid_kw / threshold, may exceed 1 */ hour: number; /* 0-23, drives window lights */ highlighted: boolean; }
/** Implemented by scene/devices (sibling agent). Renders transformer, battery, EV bays+cars, rooftop solar + HVAC, conduits with flowing particles, and floating kW labels. */
export interface DevicesProps { building: Building; flows: EnergyFlows; mode: SceneMode; overThreshold: boolean; activeNodes: ReadonlySet<import('./layout').SceneNode>; running: boolean; }
/** Your top-level component (same shape as the 2D EnergyFlowDiagramProps). */
export interface EnergySceneProps { building: Building | null; flows: EnergyFlows | null; hour: number; mode: SceneMode; overThreshold: boolean; activeTool: string | null; runStatus: SceneRunStatus; className?: string; }
