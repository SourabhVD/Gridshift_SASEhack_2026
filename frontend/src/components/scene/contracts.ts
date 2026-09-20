import type { Building, EnergyFlows } from '@/types/api';
export type SceneMode = 'baseline' | 'optimized';
export type SceneRunStatus = 'idle' | 'running' | 'awaiting_approval' | 'approved' | 'rejected' | 'failed';
/** Implemented by scene/buildings (sibling agent). Renders ONLY the building shell + ground pad + signage at the origin. */
export interface BuildingModelProps { building: Building; loadRatio: number; /* grid_kw / threshold, may exceed 1 */ hour: number; /* 0-23, drives window lights */ highlighted: boolean; }
/** Implemented by scene/devices (sibling agent). Renders transformer, battery, EV bays+cars, rooftop solar + HVAC, conduits with flowing particles, and floating kW labels. */
export interface DevicesProps { building: Building; flows: EnergyFlows; mode: SceneMode; overThreshold: boolean; activeNodes: ReadonlySet<import('./layout').SceneNode>; running: boolean; /** A background site on the campus: static props only -- no particles, labels, rings or pick targets, and the conduits drop to their dormant gauge. See devices/lite.ts. */ lite?: boolean; }
/** Your top-level component (same shape as the 2D EnergyFlowDiagramProps). */
export interface EnergySceneProps { building: Building | null; flows: EnergyFlows | null; hour: number; mode: SceneMode; overThreshold: boolean; activeTool: string | null; runStatus: SceneRunStatus; className?: string; /** Fill the parent box instead of holding a 16/9 frame, and blend to the page background rather than to a card. Set by the card-free panel. */ fill?: boolean; }
