// Provider capability catalog + ProviderResult contract.
//
// catalog = static, source-derived planning data (which provider/mode is safe
// to expose). It is NOT a benchmark/scoring runtime — provider-comparison
// conclusions live in docs only (ADR-0001). Pure data + pure functions; no
// filesystem, no network. Persistence orchestration lives in server/.

export type Exposure = 'planned' | 'mock-first' | 'experimental' | 'hidden' | 'blocked';

import type {
  FileFormat,
  FileRole,
  GenerationMode,
  ProviderId,
} from './manifest.js';

export interface ProviderCapability {
  providerId: ProviderId;
  providerName: string;
  capability: string;
  sourceStatus: string;
  exposure: Exposure;
  notes: string;
}

export type PromptCategory = 'character' | 'prop' | 'scene';

// ProviderResult — the pure output of a provider adapter. A provider knows
// nothing about cache or asset-store (ADR-0001 decoupling). It returns the bytes
// (already downloaded from any provider URL) plus role/format so the handler can
// persist them. `sourceJobId` is audit-only, never a stored asset reference.
export interface ProviderResultFile {
  role: FileRole;
  format: FileFormat;
  data: Uint8Array;
}

export interface MeshyTaskRefs {
  /** Text preview (white mesh) task id — only valid input to refine. */
  previewTaskId: string | null;
  /** Final usable mesh task id (refine after auto-texture, else the single submit). */
  resultTaskId: string | null;
}

export interface ProviderResult {
  provider: ProviderId;
  mode: GenerationMode;
  providerMode: 'mock' | 'real';
  sourceJobId: string | null;
  prompt: string | null;
  files: ProviderResultFile[];
  /** Meshy-only preview/result task pair (absent for other providers). */
  meshyTaskRefs?: MeshyTaskRefs;
}

export interface MeshyTextMockArgs {
  prompt: string;
  promptCategory?: PromptCategory;
  enablePbr?: boolean;
  targetPolycount?: number;
}

export const QUALITY_RUBRIC = [
  'geometry',
  'topology',
  'texture',
  'pbr',
  'prompt_fidelity',
] as const;

export const CAPABILITIES: readonly ProviderCapability[] = [
  {
    providerId: 'meshy',
    providerName: 'Meshy',
    capability: 'text / text-to-3D preview',
    sourceStatus: 'Implemented in lab',
    exposure: 'mock-first',
    notes: 'Good M2/M3 candidate. Preserve cache-first behavior before enabling real calls.',
  },
  {
    providerId: 'meshy',
    providerName: 'Meshy',
    capability: 'image / image-to-3D',
    sourceStatus: 'Implemented in lab',
    exposure: 'planned',
    notes: 'Requires image input handling and artifact display.',
  },
  {
    providerId: 'meshy',
    providerName: 'Meshy',
    capability: 'views / multi-image-to-3D',
    sourceStatus: 'Implemented in lab',
    exposure: 'planned',
    notes: 'Meshy accepts image URL arrays rather than Hunyuan named view slots.',
  },
  {
    providerId: 'meshy',
    providerName: 'Meshy',
    capability: 'refine',
    sourceStatus: 'Implemented in lab',
    exposure: 'planned',
    notes: 'Meshy-only second stage; keep provider-specific.',
  },
  {
    providerId: 'hunyuan_workflow',
    providerName: 'Hunyuan workflow',
    capability: 'text',
    sourceStatus: 'Verified main mode',
    exposure: 'planned',
    notes: 'Use hunyuan-3d-v3.1-text2gen-wf with async submit and poll.',
  },
  {
    providerId: 'hunyuan_workflow',
    providerName: 'Hunyuan workflow',
    capability: 'image',
    sourceStatus: 'Verified main mode',
    exposure: 'planned',
    notes: 'Use hunyuan-3d-v3.1-image2gen-wf with async submit and poll.',
  },
  {
    providerId: 'hunyuan_workflow',
    providerName: 'Hunyuan workflow',
    capability: 'views',
    sourceStatus: 'Verified main mode',
    exposure: 'planned',
    notes: 'Use hunyuan-3d-v3.1-views2gen-wf and Hunyuan named view slots.',
  },
  {
    providerId: 'hunyuan_workflow',
    providerName: 'Hunyuan workflow',
    capability: 'geometry and world workflow modes',
    sourceStatus: 'Endpoint reachable, field sanity incomplete',
    exposure: 'hidden',
    notes: 'Keep out of UI and schemas until output shape is verified.',
  },
  {
    providerId: 'hunyuan_rest',
    providerName: 'Hunyuan REST',
    capability: 'pose_standardization',
    sourceStatus: 'Implemented + live-verified 2026-06-10',
    exposure: 'mock-first',
    notes:
      'Tool gen3d:pose-standardization. Synchronous REST; image to A/T-pose standardization (upstream preprocessing, persists a blob, no manifest). Real call confirmed ~20s. Falls back to mock when GEN3D_ENABLE_REAL_PROVIDERS≠1.',
  },
  {
    providerId: 'hunyuan_rest',
    providerName: 'Hunyuan REST',
    capability: 'low_poly',
    sourceStatus: 'Contract from internal PDF; not live-tested',
    exposure: 'planned',
    notes:
      'M13-1 gen3d:retopo-lowpoly. Async submit/poll (hunyuan-3d-low-poly-v1.5). High-poly source retained by default (2026-06-12). Gate 0 verifies Hunyuan can fetch public COS model URLs.',
  },
  {
    providerId: 'hunyuan_rest',
    providerName: 'Hunyuan REST',
    capability: 'motion_retarget v1',
    sourceStatus: 'Verified end-to-end in lab',
    exposure: 'planned',
    notes:
      'M13-3 gen3d:apply-motion. int motion types 9-16 (跨步/摔倒/跳跃/踢腿/挥击/步行/跑步/跳舞, decided 2026-06-12). Input = rigged humanoid FBX (role=rigged_model).',
  },
  {
    providerId: 'hunyuan_rest',
    providerName: 'Hunyuan REST',
    capability: 'auto_rigging',
    sourceStatus: 'Endpoint reachable, not fully verified',
    exposure: 'experimental',
    notes: 'M13-2 gen3d:auto-rig. Gate 1 verifies end-to-end output before default AI exposure.',
  },
  {
    providerId: 'hunyuan_rest',
    providerName: 'Hunyuan REST',
    capability: 'motion_retarget_v2',
    sourceStatus: 'Blocked by unknown literal list',
    exposure: 'blocked',
    notes: 'Endpoint may return 200 while falling back to default motion.',
  },
  {
    providerId: 'rodin',
    providerName: 'Rodin (Hyper3D)',
    capability: 'text / text-to-3D',
    sourceStatus: 'Not on the LiteLLM 3D gateway — getRodinEnv returns null (Rodin disabled, code retained).',
    exposure: 'blocked',
    notes:
      'POST /api/v2/rodin multipart (no image → text mode), poll /api/v2/status by subscription_key, fetch URLs via /api/v2/download. tier=Regular, material=PBR, geometry_file_format=glb, quality_override controls poly count. Not wired to the LiteLLM 3D gateway (no Hyper3D model); rodin.ts code retained, disabled until the gateway adds Rodin.',
  },
  {
    providerId: 'rodin',
    providerName: 'Rodin (Hyper3D)',
    capability: 'image / image-to-3D',
    sourceStatus: 'Not on the LiteLLM 3D gateway — getRodinEnv returns null (Rodin disabled, code retained).',
    exposure: 'blocked',
    notes:
      'Image present selects Image-to-3D. Rodin takes bytes: the provider downloads the (uploaded/COS) image URL and attaches it as a multipart file, sidestepping provider-side URL fetch.',
  },
  {
    providerId: 'rodin',
    providerName: 'Rodin (Hyper3D)',
    capability: 'views / multi-image-to-3D',
    sourceStatus: 'Not on the LiteLLM 3D gateway — getRodinEnv returns null (Rodin disabled, code retained).',
    exposure: 'blocked',
    notes: 'Multiple images attached with condition_mode=concat. Each view URL is downloaded to bytes first.',
  },
];

export function clampTargetPolycount(value: number): number {
  if (!Number.isFinite(value)) return 30000;
  return Math.min(300000, Math.max(1000, Math.round(value)));
}

// Cache key = stable hash of (provider, mode, normalized inputs). Mirrors the
// lab's "provider-mode + sorted non-empty payload" dedup (see ADR-0001 Cache).
export function makeCacheKey(
  provider: ProviderId,
  mode: GenerationMode,
  payload: Record<string, string | number | boolean>,
): string {
  const normalized = Object.keys(payload)
    .filter((key) => payload[key] !== '' && payload[key] !== undefined)
    .sort()
    .map((key) => `${key}:${String(payload[key])}`)
    .join('|');
  return `${provider}-${mode}-${fnv1a(`${provider}|${mode}|${normalized}`)}`;
}

// Deterministic no-quota Meshy text mock. Produces a ProviderResult with a small
// placeholder GLB byte buffer + a preview image so the handler can exercise the
// full persistence path (blob → manifest) without any remote call.
export function generateMeshyTextMockResult(args: MeshyTextMockArgs): {
  cacheKey: string;
  result: ProviderResult;
} {
  const prompt = args.prompt.trim();
  if (!prompt) {
    throw Object.assign(new Error('prompt is required'), { code: 'invalid_prompt' });
  }
  const promptCategory = args.promptCategory ?? 'prop';
  const enablePbr = args.enablePbr ?? true;
  const targetPolycount = clampTargetPolycount(args.targetPolycount ?? 30000);
  const cacheKey = makeCacheKey('meshy', 'text', {
    prompt,
    promptCategory,
    enablePbr,
    targetPolycount,
  });

  return {
    cacheKey,
    result: {
      provider: 'meshy',
      mode: 'text',
      providerMode: 'mock',
      sourceJobId: `mock-${cacheKey}`,
      prompt,
      files: [
        { role: 'source_mesh', format: 'glb', data: mockGlbBytes(cacheKey) },
        { role: 'preview_image', format: 'png', data: MOCK_PNG_BYTES },
      ],
    },
  };
}

// Minimal valid-ish GLB header (magic "glTF" + version 2) padded with a
// deterministic tail. Not a renderable model — a stand-in byte payload so the
// store/manifest path runs end-to-end without a provider call.
function mockGlbBytes(seed: string): Uint8Array {
  const header = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);
  const tail = new TextEncoder().encode(`mock-glb:${seed}`);
  const out = new Uint8Array(header.length + tail.length);
  out.set(header, 0);
  out.set(tail, header.length);
  return out;
}

// 1x1 transparent PNG.
const MOCK_PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
