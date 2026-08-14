// Playable-character motion profile domain model. Four-layer model:
//   built-in preset → game default profile → character override → motion mapping
//
// Storage:
//   - presets: pure data, this file
//   - game default profile: <workspace>/.dsh-gen3d/playable-character-profile.json
//   - character override + motion mapping: source character's own
//     *.glb.gen3d-meta.json sidecar, under custom.playableOverride / custom.motionMapping

export type PlaybackMode = 'loop' | 'once' | 'freeze_frame';
export type RootMotionStrategy = 'preserve' | 'remove_xz' | 'remove_xyz';

export interface MotionSlotDef {
  // Stable, code-facing id (PROF4). Display name may change freely.
  slotId: string;
  displayName: string;
  required: boolean;
  playbackMode: PlaybackMode;
  speed: number;
  matchKeywords: string[];
  rootMotion: RootMotionStrategy;
}

export interface GameMotionProfile {
  schemaVersion: 1;
  profileId: string;
  // Bumped on every structural save (PROF3 migration-review trigger for R10).
  profileVersion: number;
  displayName: string;
  slots: MotionSlotDef[];
  updatedAt: string;
}

export interface CharacterMotionOverride {
  schemaVersion: 1;
  // Full effective slot list for this character (PROF6: scoped to just this
  // character, so this REPLACES the game default wholesale — never merged by
  // slotId — else a slot the user deliberately dropped for this character
  // would resurrect from the game default).
  slots: MotionSlotDef[];
  basedOnProfileId: string;
  basedOnProfileVersion: number;
  updatedAt: string;
}

export interface MotionMappingEntry {
  slotId: string;
  // motionRefKey() of the source clip filling this slot; null = unmapped.
  motionRefKey: string | null;
  // True until the user has reviewed/confirmed an auto-suggested mapping (MAP1).
  autoMatched: boolean;
}

export interface MotionMappingDraft {
  schemaVersion: 1;
  mappings: MotionMappingEntry[];
  confirmed: boolean;
  updatedAt: string;
}

export interface ProfilePreset {
  profileId: string;
  displayName: string;
  slots: MotionSlotDef[];
}

function slot(
  slotId: string,
  displayName: string,
  required: boolean,
  rootMotion: RootMotionStrategy,
): MotionSlotDef {
  return {
    slotId,
    displayName,
    required,
    playbackMode: 'loop',
    speed: 1,
    matchKeywords: [slotId],
    rootMotion,
  };
}

// PROF2: four built-in presets. blank-custom-v1 starts with zero slots; PROF5
// requires the user add >=1 required slot before export (enforced at export
// time, not here).
export const BUILTIN_PROFILE_PRESETS: readonly ProfilePreset[] = [
  {
    profileId: 'basic-character-v1',
    displayName: '基础角色',
    slots: [slot('idle', '待机', true, 'preserve'), slot('move', '移动', true, 'remove_xz')],
  },
  {
    profileId: 'action-adventure-v1',
    displayName: '动作冒险',
    slots: [
      slot('idle', '待机', true, 'preserve'),
      slot('move', '移动', true, 'remove_xz'),
      slot('attack', '攻击', true, 'preserve'),
      slot('hit', '受击', false, 'preserve'),
      slot('death', '死亡', false, 'preserve'),
    ],
  },
  {
    profileId: 'platformer-v1',
    displayName: '平台跳跃',
    slots: [
      slot('idle', '待机', true, 'preserve'),
      slot('move', '移动', true, 'remove_xz'),
      slot('jump', '跳跃', true, 'remove_xz'),
      slot('fall', '下落', false, 'preserve'),
      slot('land', '落地', false, 'preserve'),
    ],
  },
  {
    profileId: 'blank-custom-v1',
    displayName: '空白自定义',
    slots: [],
  },
] as const;

export function findPreset(profileId: string): ProfilePreset | null {
  return BUILTIN_PROFILE_PRESETS.find((p) => p.profileId === profileId) ?? null;
}

export function gameProfileFromPreset(profileId: string, now: string): GameMotionProfile {
  const preset = findPreset(profileId) ?? BUILTIN_PROFILE_PRESETS[0]!;
  return {
    schemaVersion: 1,
    profileId: preset.profileId,
    profileVersion: 1,
    displayName: preset.displayName,
    slots: preset.slots.map((s) => ({ ...s, matchKeywords: [...s.matchKeywords] })),
    updatedAt: now,
  };
}

// Effective profile = game default (+) character override (PLAN §5.5). An
// override present REPLACES the slot list wholesale (see CharacterMotionOverride
// doc) rather than merging by slotId.
export function effectiveSlots(
  gameProfile: GameMotionProfile,
  override: CharacterMotionOverride | null,
): MotionSlotDef[] {
  return override ? override.slots : gameProfile.slots;
}

export interface MotionCandidate {
  motionRefKey: string;
  label: string;
}

// MAP1: suggest a slot -> motion mapping by case-insensitive substring match of
// a slot's keywords against each candidate's label. First unclaimed candidate
// wins per slot, in slot order. MAP3 permits the same candidate to be suggested
// for more than one slot (the user confirms/adjusts before saving).
export function autoMatchMotionMapping(
  slots: readonly MotionSlotDef[],
  candidates: readonly MotionCandidate[],
): MotionMappingEntry[] {
  return slots.map((s) => {
    const keywords = s.matchKeywords.map((k) => k.toLowerCase()).filter(Boolean);
    const match = candidates.find((c) => {
      const label = c.label.toLowerCase();
      return keywords.some((k) => label.includes(k));
    });
    return { slotId: s.slotId, motionRefKey: match?.motionRefKey ?? null, autoMatched: true };
  });
}
