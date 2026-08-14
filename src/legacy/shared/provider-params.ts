import type { GenerationMode } from './manifest.js';

export type ProviderKey = 'hunyuan_workflow' | 'meshy' | 'rodin';

export type ParamType = 'enum' | 'bool' | 'int' | 'text';

export interface ParamOption {
  value: string;
  label: string;
}

export interface ParamField {
  key: string;
  label: string;
  type: ParamType;
  options?: ParamOption[];
  min?: number;
  max?: number;
  default?: string | number | boolean;
  help?: string;
  appliesToModes: GenerationMode[];
  verified: boolean;
}

export const providerParamSpec: Record<ProviderKey, ParamField[]> = {
  meshy: [
    {
      key: 'ai_model',
      label: '模型版本',
      type: 'enum',
      options: [
        { value: 'meshy-6', label: 'Meshy 6（标准）' },
        { value: 'meshy-5', label: 'Meshy 5（标准）' },
        { value: 'meshy-t2', label: 'Meshy T2（Smart Topology）' },
        { value: 'meshy-t1', label: 'Meshy T1（Smart Topology 旧）' },
      ],
      default: 'meshy-6',
      help: '选 Smart Topology 网格类型时用 T2/T1；标准网格用 Meshy 5/6',
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
    {
      key: 'model_type',
      label: '网格类型',
      type: 'enum',
      options: [
        { value: 'standard', label: '标准' },
        { value: 'smart-topology', label: 'Smart Topology（控面）' },
        { value: 'lowpoly', label: '低面数（已弃用）' },
      ],
      help: 'Smart Topology：用上方目标面数档控面（约 100–15k，推荐 T2）；会忽略重建网格/拓扑。lowpoly 已弃用。',
      appliesToModes: ['image'],
      verified: true,
    },
    {
      key: 'hd_texture',
      label: '4K 贴图 (hd_texture)',
      type: 'bool',
      help: '仅 Meshy 6 / latest；贴图 4096²，更清晰也更耗额度',
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
    {
      key: 'texture_prompt',
      label: '贴图提示词',
      type: 'text',
      help: '文生走 refine；图/多视图直接贴图。留空则文生沿用主 prompt',
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
    {
      key: 'texture_image_url',
      label: '贴图参考图 URL',
      type: 'text',
      help: '公开可访问的贴图参考图（PNG/JPG）；文生 refine 或图/多视图贴图引导',
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
    {
      key: 'remove_lighting',
      label: '去除贴图光照 (remove_lighting)',
      type: 'bool',
      help: 'Meshy 6：去掉高光/阴影，便于引擎重打光；官方默认开启，此处显式可控',
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
    {
      key: 'should_remesh',
      label: '重建网格',
      type: 'bool',
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
    {
      key: 'topology',
      label: '拓扑',
      type: 'enum',
      options: [
        { value: 'triangle', label: '三角面' },
        { value: 'quad', label: '四边面' },
      ],
      help: '仅在「重建网格」开启时生效；Smart Topology 下忽略',
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
    {
      key: 'decimation_mode',
      label: '自适应减面',
      type: 'enum',
      options: [
        { value: '1', label: '超高' },
        { value: '2', label: '高' },
        { value: '3', label: '中' },
        { value: '4', label: '低' },
      ],
      help: '设置后覆盖「目标面数」；Smart Topology 下勿用',
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
    {
      key: 'pose_mode',
      label: '姿态模式',
      type: 'enum',
      options: [
        { value: 'a-pose', label: 'A-pose' },
        { value: 't-pose', label: 'T-pose' },
      ],
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
  ],
  rodin: [
    {
      key: 'tier',
      label: '模型档',
      type: 'enum',
      options: [
        { value: 'Regular', label: 'Regular' },
        { value: 'Gen-2', label: 'Gen-2' },
        { value: 'Detail', label: 'Detail' },
        { value: 'Smooth', label: 'Smooth' },
        { value: 'Sketch', label: 'Sketch' },
      ],
      default: 'Regular',
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
    {
      key: 'quality',
      label: '面数档位',
      type: 'enum',
      options: [
        { value: 'high', label: '高' },
        { value: 'medium', label: '中' },
        { value: 'low', label: '低' },
        { value: 'extra-low', label: '极低' },
      ],
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
    {
      key: 'mesh_mode',
      label: '拓扑',
      type: 'enum',
      options: [
        { value: 'Quad', label: '四边面' },
        { value: 'Raw', label: 'Raw (三角)' },
      ],
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
    {
      key: 'material',
      label: '材质类型',
      type: 'enum',
      options: [
        { value: 'PBR', label: 'PBR' },
        { value: 'Shaded', label: 'Shaded' },
        { value: 'All', label: 'All' },
      ],
      default: 'PBR',
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
    {
      key: 'quality_override',
      label: '自定义面数',
      type: 'int',
      min: 1000,
      max: 200000,
      help: '设置后覆盖「面数档位」与目标面数',
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
    {
      key: 'TAPose',
      label: 'T/A 姿态',
      type: 'bool',
      appliesToModes: ['text', 'image', 'views'],
      verified: true,
    },
    {
      key: 'use_original_alpha',
      label: '使用原始透明通道',
      type: 'bool',
      appliesToModes: ['image', 'views'],
      verified: true,
    },
  ],
  // Hunyuan advanced knobs are mostly top-level (face_count / enable_pbr /
  // enableFbxUrl). Keep this empty so the Meshy-style adv panel stays clean;
  // enableFbxUrl is a dedicated SetupSidebar checkbox (typed on LiteLLM).
  hunyuan_workflow: [],
};

const clampInt = (n: number, min?: number, max?: number): number => {
  let v = Math.round(n);
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  return v;
};

export function filterProviderParams(
  provider: ProviderKey,
  mode: GenerationMode,
  raw: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw) return out;
  for (const f of providerParamSpec[provider] ?? []) {
    if (!f.verified) continue;
    if (!f.appliesToModes.includes(mode)) continue;
    const v = raw[f.key];
    if (v === undefined || v === null) continue;
    if (f.type === 'bool') {
      if (typeof v === 'boolean') out[f.key] = v;
    } else if (f.type === 'int') {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) out[f.key] = clampInt(n, f.min, f.max);
    } else if (f.type === 'enum') {
      if (typeof v === 'string' && (f.options ?? []).some((o) => o.value === v)) out[f.key] = v;
    } else if (f.type === 'text') {
      if (typeof v === 'string' && v.trim()) out[f.key] = v.trim();
    }
  }
  return out;
}
