export type Point2 = [number, number];

export interface CityBuilding {
  id: string;
  name?: string;
  height: number;
  heightSource: 'estimate' | 'ctbuh';
  rings: Point2[][];
}

export interface CityRoad {
  id: string;
  width: number;
  walkway: boolean;
  points: Point2[];
}

export interface StreetPlacement {
  kind: 'tree' | 'lamp' | 'bench' | 'sign';
  x: number;
  z: number;
  yaw: number;
}

export interface CityStreet {
  pavingHeight: number;
  paving: Point2[][][];
  placements: StreetPlacement[];
}

export interface CityData {
  version: 1;
  name: string;
  origin: Point2;
  bounds: [number, number, number, number];
  spawn: [number, number, number];
  buildings: CityBuilding[];
  roads: CityRoad[];
  street: CityStreet;
  attribution: { label: string; url: string }[];
}

function requireValue(ok: unknown, field: string): asserts ok {
  if (!ok) throw new Error(`街区数据不合法：${field}`);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function vector(value: unknown, size: number, limit: number): value is number[] {
  return Array.isArray(value) && value.length === size && value.every(
    v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit,
  );
}

export function parseCityData(raw: unknown): CityData {
  requireValue(object(raw), 'root');
  requireValue(raw.version === 1 && typeof raw.name === 'string', 'version/name');
  requireValue(vector(raw.origin, 2, 180), 'origin');
  requireValue(vector(raw.bounds, 4, 2000), 'bounds');
  requireValue(raw.bounds[0]! < raw.bounds[2]! && raw.bounds[1]! < raw.bounds[3]!, 'bounds order');
  requireValue(vector(raw.spawn, 3, 2000) && raw.spawn[1]! >= 0 && raw.spawn[1]! <= 5, 'spawn');
  requireValue(raw.spawn[0]! > raw.bounds[0]! && raw.spawn[0]! < raw.bounds[2]! &&
    raw.spawn[2]! > raw.bounds[1]! && raw.spawn[2]! < raw.bounds[3]!, 'spawn bounds');
  requireValue(Array.isArray(raw.buildings) && raw.buildings.length > 0 && raw.buildings.length <= 10000, 'buildings');
  const ids = new Set<string>();
  for (const b of raw.buildings) {
    requireValue(object(b) && typeof b.id === 'string', 'building id');
    requireValue(!ids.has(b.id), 'duplicate building');
    ids.add(b.id);
    requireValue(b.name === undefined || typeof b.name === 'string', 'building name');
    requireValue(typeof b.height === 'number' && Number.isFinite(b.height) && b.height > 0 && b.height <= 1000, 'height');
    requireValue(b.heightSource === 'estimate' || b.heightSource === 'ctbuh', 'height source');
    requireValue(Array.isArray(b.rings) && b.rings.length > 0 && b.rings.length <= 100, 'rings');
    for (const ring of b.rings) {
      requireValue(Array.isArray(ring) && ring.length >= 3 && ring.length <= 5000 && ring.every(p => vector(p, 2, 2000)), 'ring points');
    }
  }
  requireValue(Array.isArray(raw.roads) && raw.roads.length <= 10000, 'roads');
  for (const road of raw.roads) {
    requireValue(object(road) && typeof road.id === 'string' && typeof road.walkway === 'boolean', 'road');
    requireValue(typeof road.width === 'number' && Number.isFinite(road.width) && road.width > 0 && road.width <= 50, 'road width');
    requireValue(Array.isArray(road.points) && road.points.length >= 2 && road.points.length <= 5000 && road.points.every(p => vector(p, 2, 2000)), 'road points');
  }
  requireValue(object(raw.street) && typeof raw.street.pavingHeight === 'number' && Number.isFinite(raw.street.pavingHeight) && raw.street.pavingHeight > 0 && raw.street.pavingHeight <= 0.3, 'street');
  requireValue(Array.isArray(raw.street.paving) && raw.street.paving.length <= 100, 'paving');
  for (const polygon of raw.street.paving) {
    requireValue(Array.isArray(polygon) && polygon.length > 0 && polygon.length <= 100, 'paving polygon');
    for (const ring of polygon) requireValue(Array.isArray(ring) && ring.length >= 3 && ring.length <= 5000 && ring.every(p => vector(p, 2, 2000)), 'paving ring');
  }
  requireValue(Array.isArray(raw.street.placements) && raw.street.placements.length <= 500, 'placements');
  for (const placement of raw.street.placements) {
    requireValue(object(placement) && ['tree', 'lamp', 'bench', 'sign'].includes(String(placement.kind)) && vector([placement.x, placement.z, placement.yaw], 3, 2000) && placement.yaw === 0, 'placement');
  }
  requireValue(Array.isArray(raw.attribution) && raw.attribution.length > 0, 'attribution');
  for (const entry of raw.attribution) {
    requireValue(object(entry) && typeof entry.label === 'string' && typeof entry.url === 'string', 'attribution entry');
    const url = new URL(entry.url);
    requireValue(url.protocol === 'https:' && !url.username && !url.password, 'attribution URL');
  }
  return raw as unknown as CityData;
}
