// Motion catalog — discovery layer for the apply-motion UI + the
// gen3d:list-motions tool (ADR-0006 / PLAN §8-Q1,Q1b). It wraps the DSH
// MeshyProvider.listMotions (static meshy-actions catalog, no network) with a
// small TTL cache, supplies the Hunyuan v1 fixed set, a quota-safe mock sample,
// and filtering. Listing actions is free (zero credits); with no MESHY_API_KEY
// it returns a deterministic mock sample so the browser still works offline.
// The AI-facing schema never enumerates the ~680 actions — callers filter via
// query/category/rigType (PLAN §8-Q1b).

import { readProviderKey } from '../../config.js';
import { MeshyProvider } from '../../providers/meshy.js';
import {
  HUNYUAN_V1_MOTION_LABELS,
  type MotionSystem,
  type MotionType,
} from '../shared/manifest.js';

// One selectable motion across systems. Rich metadata (category / rigType /
// isFree / preview gif) lives here, resolved on demand by (system,id); it is
// NOT persisted onto assets (PLAN §3-1).
export interface MotionOption {
  system: MotionSystem;
  id: number | string;
  label: string;
  category: string | null;
  rigType: string | null;
  isFree: boolean;
  previewGifUrl: string | null;
}

const HUNYUAN_V1_IDS: readonly MotionType[] = [9, 10, 11, 12, 13, 14, 15, 16];

// Hunyuan v1 fixed motions, for assets rigged via the internal Hunyuan path.
export function hunyuanV1Catalog(): MotionOption[] {
  return HUNYUAN_V1_IDS.map((id) => ({
    system: 'hunyuan_v1' as const,
    id,
    label: HUNYUAN_V1_MOTION_LABELS[id],
    category: 'hunyuan v1',
    rigType: null,
    isFree: false,
    previewGifUrl: null,
  }));
}

// Deterministic no-quota sample so the motion browser renders without a key.
const MOCK_MESHY_MOTIONS: MotionOption[] = [
  { system: 'meshy', id: 28, label: 'Big Wave Hello', category: 'gesture', rigType: 'style_02', isFree: true, previewGifUrl: null },
  { system: 'meshy', id: 101, label: 'Walk', category: 'locomotion', rigType: 'style_02', isFree: true, previewGifUrl: null },
  { system: 'meshy', id: 102, label: 'Run', category: 'locomotion', rigType: 'style_02', isFree: false, previewGifUrl: null },
  { system: 'meshy', id: 201, label: 'Jump', category: 'locomotion', rigType: 'style_02', isFree: false, previewGifUrl: null },
  { system: 'meshy', id: 305, label: 'Idle Dance', category: 'expression', rigType: 'style_02', isFree: false, previewGifUrl: null },
];

const CATALOG_TTL_MS = 10 * 60_000;
const CATALOG_KEY = '__public__';
interface CacheEntry {
  at: number;
  options: MotionOption[];
}
const meshyCache = new Map<string, CacheEntry>();

// Fetch (and TTL-cache) the public Meshy motion catalog (~680 actions; the only
// catalog endpoint — rigType compatibility is filtered client-side via the
// returned `rigType` field). Only positive action ids are surfaced: apply-motion
// drives /animations by a positive action_id, while the bundled free walk/run
// (negative sentinel ids) are delivered at rig time, not via this catalog.
// Quota-safe: no key → deterministic mock sample. `slug` is retained for
// signature parity with the legacy gateway layer; the catalog itself is global.
export async function getMeshyCatalog(
  slug: string,
): Promise<{ usedMock: boolean; options: MotionOption[] }> {
  const key = readProviderKey('meshy');
  if (!key) return { usedMock: true, options: MOCK_MESHY_MOTIONS };
  const hit = meshyCache.get(CATALOG_KEY);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) {
    return { usedMock: false, options: hit.options };
  }
  const actions = await new MeshyProvider().listMotions();
  const options: MotionOption[] = actions
    .filter((a) => typeof a.id === 'number' && a.id > 0)
    .map((a) => ({
      system: 'meshy',
      id: a.id,
      label: a.label,
      category: a.category ?? null,
      rigType: a.rigType ?? null,
      isFree: a.isFree ?? false,
      previewGifUrl: a.previewUrl ?? null,
    }));
  meshyCache.set(CATALOG_KEY, { at: Date.now(), options });
  return { usedMock: false, options };
}

export interface MotionFilter {
  query?: string;
  category?: string;
  rigType?: string;
}

// In-memory filter shared by the UI browser and the AI tool, so both narrow the
// same catalog the same way (PLAN §8-Q1b).
export function filterMotions(options: readonly MotionOption[], f: MotionFilter): MotionOption[] {
  const q = f.query?.trim().toLowerCase();
  return options.filter(
    (o) =>
      (!q || o.label.toLowerCase().includes(q) || String(o.id).includes(q)) &&
      (!f.category || o.category === f.category) &&
      // rigType is degenerate today: the vendored Meshy catalog has no rig-type
      // column (Meshy exposes no per-rig list endpoint), so every option's
      // rigType is null. Match loosely — a requested rigType against an unknown
      // (null) option is treated as a match rather than filtering everything
      // out. PLAN §8-Q1.
      (!f.rigType || o.rigType === null || o.rigType === f.rigType),
  );
}
