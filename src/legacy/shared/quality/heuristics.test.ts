import { test, expect } from 'vitest';
import {
  scoreObjective,
  weightedTotal,
  DEFAULT_WEIGHTS,
  type ObjectiveMetrics,
} from './heuristics.js';

const base: ObjectiveMetrics = {
  faces: 30000,
  vertices: 15000,
  degenerateFaceRatio: 0,
  meshCount: 1,
  missingNormals: false,
  bboxAspectExtreme: false,
  targetFaceCount: 30000,
  hasUV: true,
  maxTextureSize: 2048,
  hasBaseColorMap: true,
  hasMetalRoughMap: true,
  hasNormalMap: true,
  hasOcclusionMap: true,
  hasEmissiveMap: true,
  pbrApplicable: true,
};

test('clean on-budget PBR mesh scores high on all four objective dims', () => {
  const s = scoreObjective(base);
  expect(s.geometry).toBe(100);
  expect(s.topology).toBe(100);
  expect(s.texture).toBe(100);
  expect(s.pbr).toBe(100);
});

test('degenerate triangles + missing normals tank geometry', () => {
  const s = scoreObjective({ ...base, degenerateFaceRatio: 0.5, missingNormals: true });
  // 100 - 0.5*60 - 20 = 50
  expect(s.geometry).toBe(50);
});

test('topology is null without a target face count', () => {
  expect(scoreObjective({ ...base, targetFaceCount: null }).topology).toBeNull();
});

test('topology penalizes budget overshoot', () => {
  // faces double the target → fit = 1 - clamp(30000/30000) = 0 → 0
  expect(scoreObjective({ ...base, faces: 60000 }).topology).toBe(0);
  // 50% over → fit = 0.5 → 50
  expect(scoreObjective({ ...base, faces: 45000 }).topology).toBe(50);
});

test('texture is null without UV or without a texture', () => {
  expect(scoreObjective({ ...base, hasUV: false }).texture).toBeNull();
  expect(scoreObjective({ ...base, maxTextureSize: 0 }).texture).toBeNull();
});

test('texture tiers by max resolution', () => {
  expect(scoreObjective({ ...base, maxTextureSize: 1024 }).texture).toBe(80);
  expect(scoreObjective({ ...base, maxTextureSize: 256 }).texture).toBe(40);
});

test('pbr is null when not applicable, weighted by maps otherwise', () => {
  expect(scoreObjective({ ...base, pbrApplicable: false }).pbr).toBeNull();
  // only base color (35) + normal (20) = 55
  const s = scoreObjective({
    ...base,
    hasMetalRoughMap: false,
    hasOcclusionMap: false,
    hasEmissiveMap: false,
  });
  expect(s.pbr).toBe(55);
});

test('weightedTotal skips nulls and renormalizes', () => {
  // two dims at 100 and 50, others null → (100+50)/2 = 75
  const t = weightedTotal([
    { value: 100, weight: DEFAULT_WEIGHTS.geometry },
    { value: 50, weight: DEFAULT_WEIGHTS.topology },
    { value: null, weight: DEFAULT_WEIGHTS.texture },
    { value: null, weight: DEFAULT_WEIGHTS.pbr },
    { value: null, weight: DEFAULT_WEIGHTS.prompt_fidelity },
  ]);
  expect(t).toBe(75);
});
