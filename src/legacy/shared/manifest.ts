// Gen3DAssetManifest — the durable handoff contract between the generator and
// downstream modules (3d pipeline, game generation). M9: an Asset is a per-game file,
// keyed by its game-relative path
// (`assetPath`, e.g. assets/3d/characters/hero.glb), NOT a random UUID. The main
// GLB is the identity; same-basename sidefiles (preview PNG, external texture)
// are dependencies. Downstream modules reference assets by assetPath, never by
// provider URL.

import type { CharacterMotionOverride, MotionMappingDraft } from './playable-profile.js';

export type ProviderId = 'meshy' | 'hunyuan_workflow' | 'hunyuan_rest' | 'rodin';

export type GenerationMode = 'text' | 'image' | 'views' | 'refine';

// Provider mode tag. `mock` marks no-quota deterministic fixtures so a manifest
// produced without a real call is never mistaken for a real generation.
export type ProviderMode = 'mock' | 'real';

export type AssetKind = 'mesh' | 'animation';

// Where the asset lands in the game's 3D asset tree. The value maps 1:1 to a
// directory under assets/3d/ (see ADR-0002 / 03-WORKSPACE-LAYOUT.md).
export type AssetSlot = 'characters' | 'meshes';

export const ASSET_SLOT_DIRS: Record<AssetSlot, string> = {
  characters: 'characters',
  meshes: 'meshes',
};

// Durable file roles. source_mesh/preview_image/texture come from generation;
// rigged_model/animation_clip/animated_model are appended by wb-3d-pipeline.
export type FileRole =
  | 'source_mesh'
  | 'rigged_model'
  | 'preview_image'
  | 'texture'
  | 'animation_clip'
  | 'animated_model';

export type FileFormat = 'glb' | 'fbx' | 'obj' | 'mtl' | 'usdz' | 'stl' | 'png' | 'jpg' | 'webp' | 'mp4';

export type SkeletonProfile = 'humanoid' | 'unknown';

// Motion type for animated_model files. Hunyuan motion_retarget v1 fixed motions
// are ints 9–16 (跨步/摔倒/跳跃/踢腿/挥击/步行/跑步/跳舞; see ADR-0003 §③). Stored
// structurally so idempotency / enumeration / downstream selection never parse
// file names. Kept as the hunyuan_v1 subset of MotionRef + a legacy on-disk
// field (older sidecars wrote a bare `motionType`; sidecarToManifest upgrades it).
export type MotionType = 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;

// Which animation "system" produced a clip. Public beta uses Meshy; Hunyuan v1
// (8 fixed motions) stays for internal/dev; hunyuan_v2 is reserved for the
// 48-motion B-line once it unblocks (ADR-0006 §Decision 3 / PLAN §8-Q2,Q7).
export type MotionSystem = 'hunyuan_v1' | 'hunyuan_v2' | 'meshy';

// Generalized, structural motion descriptor (ADR-0006, Q2 = option 1). One
// discriminated union subsumes all three systems and is designed once so adding
// hunyuan_v2 later does not touch the contract. Stored MINIMALLY as
// {system,id,label}; rich metadata (category / preview gif / rigType / isFree)
// is resolved on demand from the P2 motion catalog by (system,id), never
// persisted (PLAN §3-1). The idempotency key is `${system}:${id}`.
export type MotionRef =
  | { system: 'hunyuan_v1'; id: MotionType; label: string }
  | { system: 'hunyuan_v2'; id: string; label: string }
  | { system: 'meshy'; id: number; label: string };

// Stable dedup / idempotency key for a motion across systems.
export function motionRefKey(ref: MotionRef): string {
  return `${ref.system}:${ref.id}`;
}

// Canonical labels for the 8 Hunyuan v1 motions (跨步/摔倒/…). Kept here (not in
// the UI) so the server can build a MotionRef label and upgrade legacy sidecars.
export const HUNYUAN_V1_MOTION_LABELS: Record<MotionType, string> = {
  9: '跨步',
  10: '摔倒',
  11: '跳跃',
  12: '踢腿',
  13: '挥击',
  14: '步行',
  15: '跑步',
  16: '跳舞',
};

// Upgrade a legacy bare `motionType` (int 9–16) to a full MotionRef.
export function motionRefFromLegacy(id: MotionType): MotionRef {
  return { system: 'hunyuan_v1', id, label: HUNYUAN_V1_MOTION_LABELS[id] ?? `动作 ${id}` };
}

// Reserved Meshy ids for the free walk/run clips bundled in a /rigging result.
// These are NOT real Meshy action_ids (those are positive), so reserving
// negatives lets the bundled clips dedupe + render like any other motion
// without colliding with a real action (PLAN §3-4 / §8-Q6).
export const MESHY_FREE_WALK_ID = -1;
export const MESHY_FREE_RUN_ID = -2;

export interface ManifestFile {
  fileId: string;
  role: FileRole;
  format: FileFormat;
  // Game-relative path of the on-disk file (e.g. assets/3d/characters/hero.glb).
  // The main source_mesh GLB path equals the manifest's assetPath identity.
  storageKey: string;
  bytes: number;
  sha256: string;
  // Same-origin Studio URL when the blob can be streamed locally. Preview/
  // download only; not assumed reachable by external providers.
  localUrl: string | null;
  // Rigging readiness. Only meaningful for role=rigged_model FBX inputs that
  // motion_retarget consumes. Plain mesh→fbx conversions stay hasSkeleton=false.
  hasSkeleton: boolean;
  skeletonProfile: SkeletonProfile;
  animationInputReady: boolean;
  // For role=animated_model files: which motion this clip is, structural (not
  // parsed from the file name) so multiple motions coexist and apply-motion
  // stays idempotent per motion. `motionRef` is the generalized descriptor
  // (any system); `motionType` is the legacy hunyuan_v1-only field, still
  // populated for that system so older readers keep working. Undefined for
  // non-animated roles.
  motionRef?: MotionRef;
  motionType?: MotionType;
}

// Five-dimension quality rubric kept as null placeholders. Scoring is manual/
// out-of-band background knowledge per ADR-0001; not produced at generation time.
export interface QualityScore {
  geometry: number | null;
  topology: number | null;
  texture: number | null;
  pbr: number | null;
  prompt_fidelity: number | null;
  total: number | null;
}

export type QualityDimSource = 'auto' | 'ai' | 'manual';

export interface QualityDim {
  value: number | null;
  source: QualityDimSource;
}

export interface QualityReport {
  geometry: QualityDim;
  topology: QualityDim;
  texture: QualityDim;
  pbr: QualityDim;
  prompt_fidelity: QualityDim;
  total: number | null;
  method: 'auto' | 'auto+ai' | 'manual' | 'mixed';
  rater: string;
  notes: string;
  scoredAt: string;
}

export function emptyQualityReport(): QualityReport {
  const dim = (): QualityDim => ({ value: null, source: 'auto' });
  return {
    geometry: dim(),
    topology: dim(),
    texture: dim(),
    pbr: dim(),
    prompt_fidelity: dim(),
    total: null,
    method: 'auto',
    rater: '',
    notes: '',
    scoredAt: '',
  };
}

export function reportToScore(r: QualityReport): QualityScore {
  return {
    geometry: r.geometry.value,
    topology: r.topology.value,
    texture: r.texture.value,
    pbr: r.pbr.value,
    prompt_fidelity: r.prompt_fidelity.value,
    total: r.total,
  };
}

export interface Gen3DAssetManifest {
  manifestVersion: 1;
  // Canonical identity: the game-relative path of the main GLB (ADR-0002).
  assetPath: string;
  // The 3D asset slot this lives in (characters | meshes).
  assetSlot: AssetSlot;
  kind: AssetKind;
  provider: ProviderId;
  providerMode: ProviderMode;
  mode: GenerationMode;
  // Original provider job/task id, for audit. Not a stored-asset reference.
  // For Meshy text after auto-refine this is the refine (result) task id.
  sourceJobId: string | null;
  // Meshy preview vs result task pair. Manual refine MUST use previewTaskId;
  // auto-rig prefers resultTaskId (final textured mesh). Absent for non-Meshy.
  meshyTaskRefs?: {
    previewTaskId: string | null;
    resultTaskId: string | null;
  };
  // Upstream asset paths consumed to produce this one (e.g. image→mesh).
  sourceInputAssetPaths: string[];
  prompt: string | null;
  // Optional user-defined display name. Overrides the auto-generated caption
  // (prompt first-line or mode name) everywhere the asset is shown.
  userLabel?: string | null;
  files: ManifestFile[];
  // Readiness flags answer "what can downstream do with this asset".
  readiness: {
    hasSourceMesh: boolean;
    rigged: boolean;
    animated: boolean;
  };
  // Rig-chain identity once the asset is rigged (ADR-0006). apply-motion reads
  // rig.rigTaskId (Meshy) and dispatches by rig.rigProvider. Undefined until rigged.
  rig?: RigChain;
  quality: QualityScore;
  targetFaceCount?: number | null;
  createdAt: string;
  updatedAt: string;
}

// ─── v2 workspace-contract sidecar (03-WORKSPACE-LAYOUT.md) ──────────────────
//
// On disk every asset file gets a `<name>.glb.gen3d-meta.json` sidecar in the
// v2 contract shape (NOT engine pack `*.meta.json`). gen3d-private fields
// (provider/mode/job/cacheKey/readiness…) live under `custom`. Same-basename
// sidefiles go in `dependencies[]`.

export interface SidecarDependency {
  // Path relative to the sidecar's directory (e.g. hero.png, hero.texture.png).
  path: string;
  // sha256:<hex>.
  hash: string;
  // Role of the dependency file (preview_image, texture, rigged_model, …).
  kind: string;
  // Rigging metadata for rigged_model / animated_model attached files, so
  // sidecarToManifest can restore them instead of writing hasSkeleton:false. Only
  // set by appendDerivedFiles (a verified rig step); generation never sets these.
  hasSkeleton?: boolean;
  skeletonProfile?: SkeletonProfile;
  animationInputReady?: boolean;
  // For animated_model deps: the generalized motion descriptor (any system).
  motionRef?: MotionRef;
  // Legacy hunyuan_v1-only field, still read for back-compat with sidecars
  // written before motionRef existed (upgraded in sidecarToManifest).
  motionType?: MotionType;
}

// Rig-chain identity persisted on a rigged asset (ADR-0006 §Decision 3). Meshy
// animation MUST be driven by Meshy's own rig_task_id (it does not accept an
// external FBX), so apply-motion dispatches strictly by the recorded system and
// reads rigTaskId from here. Hunyuan REST only needs the local rigged FBX, so
// rigTaskId is null there.
export interface RigChain {
  rigProvider: 'meshy' | 'hunyuan_rest';
  // Meshy rig task id (input to /animations). null for the Hunyuan path.
  rigTaskId: string | null;
  // Meshy rig skeleton type (e.g. style_01); used to filter compatible actions.
  rigType: string | null;
  // Meshy rig task expiry (epoch ms; ~3 days). Used to detect rig_expired.
  rigExpiresAt: number | null;
}

export interface PlayableDeliverySnapshot {
  modelPath: string;
  playablePath: string;
  profileId: string;
  profileVersion: number;
  clipSlotIds?: string[];
  slotGuidRegistry: Record<string, string>;
  mappingFingerprint: string;
  exportedAt: string;
}

export interface AssetSidecar {
  schemaVersion: 1;
  producer: {
    plugin: string;
    pluginVersion: string;
    pipelineId?: string;
  };
  createdAt: string;
  // sha256:<hex> of the main asset file.
  contentHash: string;
  size: number;
  // Asset type label (e.g. gen3d-character, gen3d-mesh).
  type: string;
  dependencies: SidecarDependency[];
  // gen3d-private namespace. Not part of the cross-plugin contract.
  custom: {
    provider: ProviderId;
    providerMode: ProviderMode;
    mode: GenerationMode;
    assetSlot: AssetSlot;
    sourceJobId: string | null;
    prompt: string | null;
    userLabel?: string | null;
    sourceInputAssetPaths: string[];
    faceCount?: number;
    readiness: Gen3DAssetManifest['readiness'];
    // The cacheKey that produced this asset, for delete→tombstone reverse lookup.
    cacheKey?: string;
    quality?: QualityReport;
    meshyTaskRefs?: Gen3DAssetManifest['meshyTaskRefs'];
    // Rig-chain identity (ADR-0006), set by a verified rig step. apply-motion
    // dispatches by custom.rig.rigProvider and reads rig.rigTaskId (Meshy).
    rig?: RigChain;
    // Playable-character layer (PLAN-2026-07-13 §4.1, ADR-0008). Only ever set
    // on characters slot assets. Absent = this character uses the game default
    // profile unmodified with no motion mapping drafted yet.
    playableOverride?: CharacterMotionOverride;
    motionMapping?: MotionMappingDraft;
    // Last successful playable delivery snapshot (PLAN §5.6 / UX1 one-click update).
    playableDelivery?: PlayableDeliverySnapshot;
  };
}

export const FILE_ROLES: readonly FileRole[] = [
  'source_mesh',
  'rigged_model',
  'preview_image',
  'texture',
  'animation_clip',
  'animated_model',
];

export function emptyQuality(): QualityScore {
  return {
    geometry: null,
    topology: null,
    texture: null,
    pbr: null,
    prompt_fidelity: null,
    total: null,
  };
}

export function computeReadiness(files: readonly ManifestFile[]): Gen3DAssetManifest['readiness'] {
  return {
    hasSourceMesh: files.some((file) => file.role === 'source_mesh'),
    rigged: files.some((file) => file.role === 'rigged_model' && file.hasSkeleton),
    animated: files.some(
      (file) => file.role === 'animated_model' || file.role === 'animation_clip',
    ),
  };
}

// Resolve the single file a consumer wants by role (+ optional format), instead
// of parsing file names or URLs. The main mesh is selectFile(files,
// 'source_mesh', 'glb'); the preview is selectFile(files, 'preview_image').
export function selectFile(
  files: readonly ManifestFile[],
  role: FileRole,
  format?: FileFormat,
): ManifestFile | null {
  return (
    files.find((file) => file.role === role && (format ? file.format === format : true)) ?? null
  );
}

// All files of a role (e.g. every animated_model clip), for enumeration. The UI
// lists existing motions from animated_model files' structural motionType.
export function selectFiles(
  files: readonly ManifestFile[],
  role: FileRole,
  format?: FileFormat,
): ManifestFile[] {
  return files.filter((file) => file.role === role && (format ? file.format === format : true));
}
