import { test, expect } from 'vitest';
import {
  BUILTIN_PROFILE_PRESETS,
  autoMatchMotionMapping,
  effectiveSlots,
  findPreset,
  gameProfileFromPreset,
  type CharacterMotionOverride,
} from './playable-profile.js';

test('four built-in presets exist with the exact PROF2 ids', () => {
  const ids = BUILTIN_PROFILE_PRESETS.map((p) => p.profileId);
  expect(ids).toEqual([
    'basic-character-v1',
    'action-adventure-v1',
    'platformer-v1',
    'blank-custom-v1',
  ]);
});

test('blank-custom-v1 has zero slots (PROF5 enforced at export time, not here)', () => {
  const preset = findPreset('blank-custom-v1');
  expect(preset?.slots).toEqual([]);
});

test('basic-character-v1 has idle+move both required, move defaults remove_xz', () => {
  const preset = findPreset('basic-character-v1');
  const idle = preset?.slots.find((s) => s.slotId === 'idle');
  const move = preset?.slots.find((s) => s.slotId === 'move');
  expect(idle?.required).toBe(true);
  expect(idle?.rootMotion).toBe('preserve');
  expect(move?.required).toBe(true);
  expect(move?.rootMotion).toBe('remove_xz');
});

test('action-adventure-v1: idle/move/attack required, hit/death optional', () => {
  const preset = findPreset('action-adventure-v1')!;
  const required = preset.slots.filter((s) => s.required).map((s) => s.slotId);
  const optional = preset.slots.filter((s) => !s.required).map((s) => s.slotId);
  expect(required.sort()).toEqual(['attack', 'idle', 'move']);
  expect(optional.sort()).toEqual(['death', 'hit']);
});

test('platformer-v1: idle/move/jump required, fall/land optional', () => {
  const preset = findPreset('platformer-v1')!;
  const required = preset.slots.filter((s) => s.required).map((s) => s.slotId);
  const optional = preset.slots.filter((s) => !s.required).map((s) => s.slotId);
  expect(required.sort()).toEqual(['idle', 'jump', 'move']);
  expect(optional.sort()).toEqual(['fall', 'land']);
});

test('findPreset returns null for an unknown id', () => {
  expect(findPreset('nonexistent-v1')).toBeNull();
});

test('gameProfileFromPreset starts at profileVersion 1 and clones preset slots (no shared references)', () => {
  const now = '2026-07-13T00:00:00.000Z';
  const profile = gameProfileFromPreset('basic-character-v1', now);
  expect(profile.profileVersion).toBe(1);
  expect(profile.profileId).toBe('basic-character-v1');
  expect(profile.updatedAt).toBe(now);
  profile.slots[0]!.displayName = 'mutated';
  expect(findPreset('basic-character-v1')!.slots[0]!.displayName).not.toBe('mutated');
});

test('gameProfileFromPreset clones matchKeywords arrays too, not just the slot object', () => {
  const profile = gameProfileFromPreset('basic-character-v1', '2026-07-13T00:00:00.000Z');
  profile.slots[0]!.matchKeywords.push('leaked');
  expect(findPreset('basic-character-v1')!.slots[0]!.matchKeywords).not.toContain('leaked');
});

test('gameProfileFromPreset falls back to the first preset for an unknown id', () => {
  const profile = gameProfileFromPreset('nonexistent-v1', '2026-07-13T00:00:00.000Z');
  expect(profile.profileId).toBe(BUILTIN_PROFILE_PRESETS[0]!.profileId);
});

test('effectiveSlots: no override → game profile slots', () => {
  const profile = gameProfileFromPreset('action-adventure-v1', '2026-07-13T00:00:00.000Z');
  expect(effectiveSlots(profile, null)).toBe(profile.slots);
});

test('effectiveSlots: override REPLACES wholesale, does not merge by slotId', () => {
  const profile = gameProfileFromPreset('action-adventure-v1', '2026-07-13T00:00:00.000Z');
  const override: CharacterMotionOverride = {
    schemaVersion: 1,
    // Deliberately drops 'hit'/'death' present in the game default — a merge-
    // by-slotId implementation would resurrect them; effectiveSlots must not.
    slots: [
      { slotId: 'idle', displayName: '待机', required: true, playbackMode: 'loop', speed: 1, matchKeywords: ['idle'], rootMotion: 'preserve' },
    ],
    basedOnProfileId: profile.profileId,
    basedOnProfileVersion: profile.profileVersion,
    updatedAt: '2026-07-13T00:00:00.000Z',
  };
  const result = effectiveSlots(profile, override);
  expect(result).toEqual(override.slots);
  expect(result.some((s) => s.slotId === 'hit')).toBe(false);
});

test('autoMatchMotionMapping: matches by case-insensitive keyword substring', () => {
  const preset = findPreset('basic-character-v1')!;
  const result = autoMatchMotionMapping(preset.slots, [
    { motionRefKey: 'meshy:1', label: 'Idle_Breathing' },
    { motionRefKey: 'meshy:2', label: 'Walking_Move_Forward' },
  ]);
  expect(result.find((r) => r.slotId === 'idle')?.motionRefKey).toBe('meshy:1');
  expect(result.find((r) => r.slotId === 'move')?.motionRefKey).toBe('meshy:2');
  expect(result.every((r) => r.autoMatched)).toBe(true);
});

test('autoMatchMotionMapping: unmatched slot gets null motionRefKey', () => {
  const preset = findPreset('basic-character-v1')!;
  const result = autoMatchMotionMapping(preset.slots, [
    { motionRefKey: 'meshy:9', label: 'Totally_Unrelated_Clip' },
  ]);
  expect(result.find((r) => r.slotId === 'idle')?.motionRefKey).toBeNull();
});

test('autoMatchMotionMapping: MAP3 allows the same candidate to fill multiple slots', () => {
  const slots = [
    { slotId: 'idle', displayName: '待机', required: true, playbackMode: 'loop' as const, speed: 1, matchKeywords: ['generic'], rootMotion: 'preserve' as const },
    { slotId: 'move', displayName: '移动', required: true, playbackMode: 'loop' as const, speed: 1, matchKeywords: ['generic'], rootMotion: 'remove_xz' as const },
  ];
  const result = autoMatchMotionMapping(slots, [{ motionRefKey: 'meshy:1', label: 'Generic_Clip' }]);
  expect(result[0]!.motionRefKey).toBe('meshy:1');
  expect(result[1]!.motionRefKey).toBe('meshy:1');
});
