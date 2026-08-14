
// mergePlayableCharacter — merge rigged base + mapped motion GLBs into one
// multi-clip playable GLB (PLAN §5.5 / ANIM2 / MAP3 / F1).
// Pure function over bytes — no disk I/O. Logic adapted from hellforge
// scripts/merge-gen3d-motions.ts (inlined; do not import games/).

import { Document, NodeIO, VertexLayout, type Animation, type Node } from '@gltf-transform/core';
import { mergeDocuments, prune, unpartition } from '@gltf-transform/functions';
import type { RootMotionStrategy } from '../shared/playable-profile.js';

export interface MergeSlotInput {
  slotId: string;
  motionGlbBytes: Uint8Array;
  rootMotion: RootMotionStrategy;
}

export interface MergePlayableInput {
  baseRiggedGlbBytes: Uint8Array;
  /** Already filtered: required mapped + filled optional; stable export order. */
  slots: readonly MergeSlotInput[];
}

export type MergePlayableErrorCode =
  | 'empty_slots'
  | 'base_read_failed'
  | 'motion_read_failed'
  | 'motion_clip_count'
  | 'root_joint_missing'
  | 'write_failed'
  | 'validation_failed';

export type MergePlayableResult =
  | { ok: true; bytes: Uint8Array; clipNames: string[] }
  | { ok: false; code: MergePlayableErrorCode; message: string; slotId?: string };

const ROOT_JOINT_RE = /^(hips|root)$/i;

function findRootJoint(nodes: readonly Node[]): Node | null {
  for (const n of nodes) {
    const name = n.getName() || '';
    if (ROOT_JOINT_RE.test(name.trim())) return n;
  }
  // Fallback: any node whose name contains hips/root as a word-ish substring.
  for (const n of nodes) {
    const name = (n.getName() || '').toLowerCase();
    if (/(^|[^a-z])(hips|root)([^a-z]|$)/i.test(name)) return n;
  }
  return null;
}

/**
 * Apply root-motion strategy to translation channels targeting Hips|Root.
 * Mutates `anim` in place. Returns false when strategy needs a joint but none found.
 */
export function applyRootMotionStrategy(anim: Animation, strategy: RootMotionStrategy, joints: readonly Node[]): boolean {
  if (strategy === 'preserve') return true;
  const root = findRootJoint(joints);
  if (!root) return false;

  for (const channel of anim.listChannels()) {
    if (channel.getTargetPath() !== 'translation') continue;
    if (channel.getTargetNode() !== root) continue;
    const sampler = channel.getSampler();
    if (!sampler) continue;
    const output = sampler.getOutput();
    if (!output) continue;
    const arr = output.getArray();
    if (!arr || arr.length < 3) continue;
    const next = new Float32Array(arr.length);
    next.set(arr as Float32Array);
    for (let i = 0; i + 2 < next.length; i += 3) {
      if (strategy === 'remove_xz' || strategy === 'remove_xyz') {
        next[i] = 0; // X
        next[i + 2] = 0; // Z
      }
      if (strategy === 'remove_xyz') {
        next[i + 1] = 0; // Y
      }
    }
    output.setArray(next);
  }
  return true;
}

function validateMerged(doc: Document, expectedClips: number): string | null {
  const root = doc.getRoot();
  if (root.listMeshes().length < 1) return 'merged GLB has no meshes';
  if (root.listSkins().length < 1) return 'merged GLB has no skin';
  // Engine emits skeleton 1:1 with skins; require ≥1 skin-backed hierarchy.
  if (root.listAnimations().length !== expectedClips) {
    return `expected ${expectedClips} animation clips, got ${root.listAnimations().length}`;
  }
  // Skinned nodes should sit at unit world transform (PLAN §5.5).
  for (const node of root.listNodes()) {
    if (!node.getSkin()) continue;
    const t = node.getTranslation();
    const r = node.getRotation();
    const s = node.getScale();
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
    const unitT = near(t[0], 0) && near(t[1], 0) && near(t[2], 0);
    const unitR = near(r[0], 0) && near(r[1], 0) && near(r[2], 0) && near(r[3], 1);
    const unitS = near(s[0], 1) && near(s[1], 1) && near(s[2], 1);
    if (!unitT || !unitR || !unitS) {
      return `skinned node ${JSON.stringify(node.getName())} is not at unit world TRS`;
    }
  }
  return null;
}

/**
 * Merge rigged base + per-slot motion GLBs into one engine-compatible GLB.
 * Callers must enforce F1 (missing required slots) BEFORE invoking this.
 */
export async function mergePlayableCharacter(input: MergePlayableInput): Promise<MergePlayableResult> {
  if (input.slots.length === 0) {
    return { ok: false, code: 'empty_slots', message: 'No slots to export (add ≥1 required mapped slot).' };
  }

  const io = new NodeIO();
  io.setVertexLayout(VertexLayout.SEPARATE);

  let base: Document;
  try {
    base = await io.readBinary(input.baseRiggedGlbBytes);
  } catch (err) {
    return {
      ok: false,
      code: 'base_read_failed',
      message: err instanceof Error ? err.message : 'Failed to read rigged base GLB',
    };
  }

  const baseOriginalNodes = new Set<Node>();
  const baseNodesByName = new Map<string, Node>();
  for (const n of base.getRoot().listNodes()) {
    baseOriginalNodes.add(n);
    const name = n.getName();
    if (name) baseNodesByName.set(name, n);
  }

  // Drop base rest/bind clips (PLAN §5.5).
  for (const anim of base.getRoot().listAnimations()) anim.dispose();

  for (const slot of input.slots) {
    let motion: Document;
    try {
      motion = await io.readBinary(slot.motionGlbBytes);
    } catch (err) {
      return {
        ok: false,
        code: 'motion_read_failed',
        message: err instanceof Error ? err.message : `Failed to read motion for slot ${slot.slotId}`,
        slotId: slot.slotId,
      };
    }
    const clips = motion.getRoot().listAnimations();
    if (clips.length !== 1) {
      return {
        ok: false,
        code: 'motion_clip_count',
        message: `Slot ${slot.slotId}: motion must contain exactly 1 animation clip, got ${clips.length}`,
        slotId: slot.slotId,
      };
    }
    clips[0]!.setName(slot.slotId);
    mergeDocuments(base, motion);
  }

  // Remap channel targets from motion-copied joints → base skeleton joints.
  for (const anim of base.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) {
      const t = ch.getTargetNode();
      if (t && !baseOriginalNodes.has(t)) {
        const name = t.getName();
        const rep = name ? baseNodesByName.get(name) : undefined;
        if (rep) ch.setTargetNode(rep);
      }
    }
  }

  // Drop extra scenes + motion-copied nodes.
  const scenes = base.getRoot().listScenes();
  for (let i = 1; i < scenes.length; i++) scenes[i]!.dispose();
  for (const n of base.getRoot().listNodes()) {
    if (!baseOriginalNodes.has(n)) n.dispose();
  }

  // Apply per-slot root motion AFTER remap, using base joints.
  const baseJoints = base.getRoot().listNodes();
  for (const anim of base.getRoot().listAnimations()) {
    const slot = input.slots.find((s) => s.slotId === anim.getName());
    if (!slot) continue;
    const ok = applyRootMotionStrategy(anim, slot.rootMotion, baseJoints);
    if (!ok) {
      return {
        ok: false,
        code: 'root_joint_missing',
        message: `Slot ${slot.slotId}: root motion ${slot.rootMotion} needs a Hips|Root joint, none found`,
        slotId: slot.slotId,
      };
    }
  }

  await base.transform(prune(), unpartition());

  const clipNames = base.getRoot().listAnimations().map((a) => a.getName());
  const validationError = validateMerged(base, input.slots.length);
  if (validationError) {
    return { ok: false, code: 'validation_failed', message: validationError };
  }

  try {
    const bytes = await io.writeBinary(base);
    return { ok: true, bytes, clipNames };
  } catch (err) {
    return {
      ok: false,
      code: 'write_failed',
      message: err instanceof Error ? err.message : 'Failed to write merged GLB',
    };
  }
}

/** Resolve which slots will actually export (F1 / empty optional). */
export function resolveExportSlots(args: {
  slots: readonly { slotId: string; required: boolean; rootMotion: RootMotionStrategy }[];
  mappings: readonly { slotId: string; motionRefKey: string | null }[];
}):
  | { ok: true; exportSlotIds: string[]; mappingBySlot: Map<string, string> }
  | { ok: false; code: 'missing_required' | 'no_required_slots'; message: string; missingSlots: string[] } {
  const map = new Map(args.mappings.map((m) => [m.slotId, m.motionRefKey]));
  const required = args.slots.filter((s) => s.required);
  if (required.length === 0) {
    return {
      ok: false,
      code: 'no_required_slots',
      message: 'Profile has no required slots (PROF5: add ≥1 required slot before export).',
      missingSlots: [],
    };
  }
  const missing = required.filter((s) => !map.get(s.slotId)).map((s) => s.slotId);
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'missing_required',
      message: `Missing required motion slots: ${missing.join(', ')}`,
      missingSlots: missing,
    };
  }
  const exportSlotIds: string[] = [];
  const mappingBySlot = new Map<string, string>();
  for (const s of args.slots) {
    const key = map.get(s.slotId) ?? null;
    if (!key) continue; // empty optional — omit
    exportSlotIds.push(s.slotId);
    mappingBySlot.set(s.slotId, key);
  }
  return { ok: true, exportSlotIds, mappingBySlot };
}
