// Pure objective quality heuristics (Phase A, no LLM, no DOM, no three import).
// Scale 0–100. The client extracts ObjectiveMetrics from a loaded GLB (see
// src/lib/objectiveMetrics.ts) and calls scoreObjective(); the score-quality tool
// only persists the result. Thresholds are centralized here (ADR-0004).

export interface ObjectiveMetrics {
  faces: number;
  vertices: number;
  degenerateFaceRatio: number;
  meshCount: number;
  missingNormals: boolean;
  bboxAspectExtreme: boolean;
  targetFaceCount: number | null;
  hasUV: boolean;
  maxTextureSize: number;
  hasBaseColorMap: boolean;
  hasMetalRoughMap: boolean;
  hasNormalMap: boolean;
  hasOcclusionMap: boolean;
  hasEmissiveMap: boolean;
  pbrApplicable: boolean;
}

export interface ObjectiveScores {
  geometry: number | null;
  topology: number | null;
  texture: number | null;
  pbr: number | null;
}

export const DEFAULT_WEIGHTS = {
  geometry: 0.2,
  topology: 0.2,
  texture: 0.2,
  pbr: 0.2,
  prompt_fidelity: 0.2,
} as const;

const DEGENERATE_PENALTY = 60;
const MISSING_NORMALS_PENALTY = 20;
const ASPECT_PENALTY = 15;
const ISLAND_SOFT_CAP = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v);

export function scoreGeometry(m: ObjectiveMetrics): number {
  let s = 100;
  s -= clamp(m.degenerateFaceRatio, 0, 1) * DEGENERATE_PENALTY;
  if (m.missingNormals) s -= MISSING_NORMALS_PENALTY;
  if (m.bboxAspectExtreme) s -= ASPECT_PENALTY;
  if (m.meshCount > ISLAND_SOFT_CAP) s -= Math.min(15, (m.meshCount - ISLAND_SOFT_CAP) * 2);
  return clamp(round(s), 0, 100);
}

export function scoreTopology(m: ObjectiveMetrics): number | null {
  if (m.targetFaceCount === null || m.targetFaceCount <= 0) return null;
  const fit = 1 - clamp(Math.abs(m.faces - m.targetFaceCount) / m.targetFaceCount, 0, 1);
  return clamp(round(100 * fit), 0, 100);
}

export function scoreTexture(m: ObjectiveMetrics): number | null {
  if (!m.hasUV || m.maxTextureSize <= 0) return null;
  if (m.maxTextureSize >= 2048) return 100;
  if (m.maxTextureSize >= 1024) return 80;
  if (m.maxTextureSize >= 512) return 60;
  return 40;
}

export function scorePbr(m: ObjectiveMetrics): number | null {
  if (!m.pbrApplicable) return null;
  let s = 0;
  if (m.hasBaseColorMap) s += 35;
  if (m.hasMetalRoughMap) s += 30;
  if (m.hasNormalMap) s += 20;
  if (m.hasOcclusionMap) s += 10;
  if (m.hasEmissiveMap) s += 5;
  return clamp(round(s), 0, 100);
}

export function scoreObjective(m: ObjectiveMetrics): ObjectiveScores {
  return {
    geometry: scoreGeometry(m),
    topology: scoreTopology(m),
    texture: scoreTexture(m),
    pbr: scorePbr(m),
  };
}

export function weightedTotal(dims: { value: number | null; weight: number }[]): number | null {
  let sum = 0;
  let w = 0;
  for (const d of dims) {
    if (d.value !== null) {
      sum += d.value * d.weight;
      w += d.weight;
    }
  }
  return w > 0 ? round(sum / w) : null;
}
