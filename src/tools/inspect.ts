// gen3d_inspect_asset —— 本地资产体检（零网络零配额）。
//
// 用 NodeIO 直接读 GLB（Draco 自动解码），统计几何 / 材质 / 贴图 / 动画 /
// 骨架指标，并按预算档（与技能文档严格一致）给出通过/违规判定：
// - hero-character：tris ≤ 30000、贴图边长 ≤ 2048、材质 ≤ 2
// - prop：tris ≤ 5000、贴图边长 ≤ 1024、材质 ≤ 2
// - environment：tris ≤ 50000、贴图边长 ≤ 2048、材质 ≤ 4
//
// violations 为人类可读字符串数组（逐条列出超限项），passed = 无违规。
// render 输出人话摘要（text-only 模型可直接读）。
//
// 失败语义与 preview 一致：asset_not_found / asset_unreadable（解析失败）。

import { readFile } from 'node:fs/promises';

import type { Document } from '@gltf-transform/core';

import { readGlb } from '../render/glb-reader.js';
import {
  defineGen3dTool,
  getStore,
  resultSchema,
  ToolError,
  type Gen3dToolSpec,
} from './common.js';
import { resolveAssetPath } from './preview.js';

// ── 预算档（与 skills 文档严格一致；别处引用本表） ────────────────────────────

export type InspectBudget = 'hero-character' | 'prop' | 'environment';

export interface InspectBudgetRule {
  label: string;
  maxTris: number;
  /** 贴图最大边长（px）。 */
  maxTextureEdge: number;
  maxMaterials: number;
}

export const INSPECT_BUDGETS: Record<InspectBudget, InspectBudgetRule> = {
  'hero-character': { label: '英雄角色', maxTris: 30000, maxTextureEdge: 2048, maxMaterials: 2 },
  prop: { label: '道具/小物件', maxTris: 5000, maxTextureEdge: 1024, maxMaterials: 2 },
  environment: { label: '环境/场景', maxTris: 50000, maxTextureEdge: 2048, maxMaterials: 4 },
};

export const INSPECT_BUDGET_NAMES = Object.keys(INSPECT_BUDGETS) as InspectBudget[];

function asBudget(raw: unknown): InspectBudget {
  const v = String(raw ?? 'hero-character');
  if (!(INSPECT_BUDGET_NAMES as string[]).includes(v)) {
    throw new ToolError('invalid_args', `budget 不支持：${v}（可选 ${INSPECT_BUDGET_NAMES.join(' / ')}）`);
  }
  return v as InspectBudget;
}

// ── 统计 ────────────────────────────────────────────────────────────────────

export interface InspectStats {
  vertices: number;
  triangles: number;
  materialCount: number;
  /** 贴图：文件名/序号 + 尺寸（未知为 null）。 */
  textures: { name: string; mimeType: string | null; width: number | null; height: number | null }[];
  /** 动画 clips：名字 + 时长秒。 */
  animations: { name: string; duration: number }[];
  hasSkeleton: boolean;
  /** 绑了缩放骨架的节点数（有 skin 且有 mesh）。 */
  skinnedMeshCount: number;
}

/** 统计 Document（纯只读；点数口径 = POSITION accessor 计数和）。 */
export function inspectDocument(doc: Document): InspectStats {
  const root = doc.getRoot();

  let vertices = 0;
  let triangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const count = pos.getCount();
      vertices += count;
      if (prim.getMode() !== 4 && prim.getMode() !== 5 && prim.getMode() !== 6) continue;
      const idx = prim.getIndices();
      if (idx) {
        triangles += Math.floor(idx.getCount() / 3);
      } else if (prim.getMode() === 4) {
        triangles += Math.floor(count / 3);
      } else {
        triangles += count - 2; // strip / fan
      }
    }
  }
  if (triangles < 0) triangles = 0;

  const textures = root.listTextures().map((t, i) => {
    let width: number | null = null;
    let height: number | null = null;
    try {
      const size = t.getSize();
      if (size) {
        width = size[0];
        height = size[1];
      }
    } catch {
      // 尺寸解析失败（编码异常等）：保持 null，violations 不涉及
    }
    let mimeType: string | null = null;
    try {
      mimeType = t.getMimeType();
    } catch {
      mimeType = null;
    }
    return { name: t.getName() || `texture_${i}`, mimeType, width, height };
  });

  const animations = root.listAnimations().map((a, index) => {
    let duration = 0;
    for (const sampler of a.listSamplers()) {
      const input = sampler.getInput();
      if (!input) continue;
      const max = input.getMax([]);
      if (max.length > 0 && Number.isFinite(max[0]!)) {
        duration = Math.max(duration, max[0]!);
      } else {
        const arr = input.getArray();
        if (arr && arr.length > 0) duration = Math.max(duration, Number(arr[arr.length - 1]) || 0);
      }
    }
    return { name: a.getName() || `clip_${index}`, duration };
  });

  const skins = root.listSkins();
  const skinnedMeshCount = root.listNodes().filter((n) => n.getSkin() !== null && n.getMesh() !== null).length;

  return {
    vertices,
    triangles,
    materialCount: root.listMaterials().length,
    textures,
    animations,
    hasSkeleton: skins.length > 0,
    skinnedMeshCount,
  };
}

// ── 预算判定 ────────────────────────────────────────────────────────────────

export interface InspectValue {
  ok: true;
  assetPath: string;
  budget: InspectBudget;
  stats: InspectStats;
  /** 人类可读违规条目（每条一句话；空 = 通过）。 */
  violations: string[];
  passed: boolean;
}

/** 按预算档判定统计结果 → 违规条目（人话）。 */
export function evaluateBudget(budget: InspectBudget, stats: InspectStats): string[] {
  const rule = INSPECT_BUDGETS[budget];
  const violations: string[] = [];
  if (stats.triangles > rule.maxTris) {
    violations.push(
      `三角形数 ${stats.triangles} 超出「${rule.label}」预算上限 ${rule.maxTris}`,
    );
  }
  for (const tex of stats.textures) {
    const edge = Math.max(tex.width ?? 0, tex.height ?? 0);
    if (edge > rule.maxTextureEdge) {
      violations.push(
        `贴图「${tex.name}」边长 ${tex.width}×${tex.height} 超出「${rule.label}」预算上限 ${rule.maxTextureEdge}px`,
      );
    }
  }
  if (stats.materialCount > rule.maxMaterials) {
    violations.push(
      `材质数 ${stats.materialCount} 超出「${rule.label}」预算上限 ${rule.maxMaterials}`,
    );
  }
  return violations;
}

function renderInspect(_args: Record<string, unknown>, value: InspectValue): { type: 'text'; text: string }[] {
  const s = value.stats;
  const lines = [
    `资产体检：${value.assetPath}（预算档：${value.budget} = ${INSPECT_BUDGETS[value.budget]!.label}）`,
    `几何：${s.vertices} 顶点 / ${s.triangles} 三角形`,
    `材质：${s.materialCount} 个`,
    `贴图：${s.textures.length} 张` +
      (s.textures.length > 0
        ? `（${s.textures.map((t) => `${t.name} ${t.width ?? '?'}×${t.height ?? '?'}`).join('；')}）`
        : ''),
    `动画：${s.animations.length} 个 clips` +
      (s.animations.length > 0
        ? `（${s.animations.map((a) => `${a.name} ${a.duration.toFixed(2)}s`).join('；')}）`
        : ''),
    `骨架：${s.hasSkeleton ? '有' : '无'}（蒙皮网格 ${s.skinnedMeshCount} 个）`,
  ];
  if (value.passed) {
    lines.push(`预算判定：通过（${INSPECT_BUDGETS[value.budget]!.label} 档内）`);
  } else {
    lines.push(`预算判定：不通过（${value.violations.length} 条违规）`);
    for (const v of value.violations) lines.push(`- ${v}`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

const inspectSpec: Gen3dToolSpec<InspectValue> = {
  name: 'gen3d_inspect_asset',
  description:
    '本地资产体检（不调用任何 provider、不消耗配额）：读 GLB 统计顶点数、三角形数、材质数、贴图（数量与尺寸）、动画 clips（名称与时长）、骨架（有/无、蒙皮网格数），并按预算档（hero-character / prop / environment）给出通过或逐条违规。用于生成后校验资产是否在目标预算内、以及排查上一步为何渲染/绑定失败。',
  parameters: {
    asset: { type: 'string', required: true, description: '资产名（不含扩展名）或相对路径（assets/3d/characters/hero.glb）' },
    budget: {
      type: 'string',
      enum: INSPECT_BUDGET_NAMES,
      description: '预算档：hero-character（角色，3 万面）/ prop（道具，5 千面）/ environment（环境，5 万面）（默认 hero-character）',
    },
  },
  output: {
    schema: resultSchema({
      assetPath: { type: 'string', description: '资产相对路径' },
      budget: { type: 'string', description: '预算档' },
      stats: {
        type: 'json',
        description: '统计全量（顶点/三角形/材质/贴图/动画/骨架；详情见文本摘要）',
      },
      violations: { type: 'array', items: { type: 'string' }, description: '违规条目（人类可读；空 = 通过）' },
      passed: { type: 'boolean', description: '是否在预算档内' },
    }),
    render: renderInspect,
    // prose render（text-only 模型可读）；统计与违规经 presentationMeta
    // 递给 web 侧 keyed 卡片（src/client/tool-cards.tsx，从 tool/result.meta 摄取）。
    presentationMeta: (_args, value) => ({
      assetPath: value.assetPath,
      budget: value.budget,
      stats: value.stats as unknown as Record<string, unknown>,
      violations: [...value.violations],
      passed: value.passed,
    }),
  },
  async run(args) {
    const store = getStore();
    const assetRaw = typeof args.asset === 'string' ? args.asset.trim() : '';
    if (assetRaw === '') throw new ToolError('invalid_args', 'asset 必须是非空字符串');
    const budget = asBudget(args.budget);

    const assetPath = await resolveAssetPath(store, assetRaw);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(store.absolutePath(assetPath)));
    } catch {
      throw new ToolError('asset_not_found', `资产不存在：${assetPath}`);
    }

    let doc;
    try {
      doc = await readGlb(bytes);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ToolError('asset_unreadable', `GLB 解析失败（可能是旧版占位 mock 或损坏文件）：${reason}`);
    }

    const stats = inspectDocument(doc);
    const violations = evaluateBudget(budget, stats);
    return { ok: true, assetPath, budget, stats, violations, passed: violations.length === 0 };
  },
};

export const gen3dInspectAsset = defineGen3dTool(inspectSpec);
