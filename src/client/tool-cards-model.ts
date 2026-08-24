// gen3d 工具卡片的数据面 —— 纯函数推导（不碰 React / JSX，可单测）。
//
// 输入是 tool.call.toolview 槽位 owner 的冻结块（官方 ToolCallOwnerProps）：
//   - 运行中 → RunningToolCall（argsRaw / name / callId）；
//   - 已定稿 → ToolResultNode（content 块数组 / isError / error / call.argsRaw）。
// 工具侧 output.render 把规范值 JSON 化进 text 块（image 块承载预览图），
// 本层从 text 块反解析出 canonical value → 卡片取的字段。任何解析失败都返回
// null，由卡片层退「通用样式行」（绝不返回 undefined——keyed 槽命中即渲染，
// 组件返回 null 不会落回平台 fallback，见 tool-cards.tsx 文件头结论）。

import type { ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client';

/** tool.call.toolview 槽位 owner props（官方 ToolCallOwnerProps 的结构镜像）。 */
export interface Gen3dToolViewProps {
  /** 工具调用身份（运行/定稿两形态稳定）。 */
  callId: string;
  /** wire 工具名（keyed 派发值）。 */
  toolName: string;
  /** 冻结的运行中调用或定稿结果节点。 */
  block: ToolCallBlock;
  /** 会话工作区根（本层未用，契约镜像保留）。 */
  cwd?: string | undefined;
  /** 宿主账户 home（契约镜像保留）。 */
  home?: string | undefined;
  /** 经 Host 打开工具参数里的文件路径。 */
  openFile?: ((path: string) => void) | undefined;
  /** 在 trajectory 视图检查本调用（可用时）。 */
  inspect?: (() => void) | undefined;
}

/** 是否已定稿（有 kind 字段的是结果节点）。 */
export function settled(block: ToolCallBlock): block is ToolResultNode {
  return 'kind' in block;
}

/** 运行状态串（对齐官方 toolRowModel 的状态语义）。 */
export function stateOf(block: ToolCallBlock): 'running' | 'ok' | 'error' | 'stopped' {
  if (!settled(block)) return 'running';
  if (block.error?.code === 'interrupted') return 'stopped';
  return block.isError ? 'error' : 'ok';
}

/** 参数原文（两形态取值）。 */
export function argsRawOf(block: ToolCallBlock): string {
  return settled(block) ? (block.call?.argsRaw ?? '') : block.argsRaw;
}

/** 定稿结果 text 块拼接（非 text 块忽略——image 块由卡片走文件 URL 展示）。 */
export function resultText(node: ToolResultNode): string {
  const parts: string[] = [];
  for (const block of node.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('\n');
}

/** 反解析 canonical value：text 块拼接后 JSON.parse（工具 renderJson 的产物）。 */
export function canonicalValue(block: ToolCallBlock): Record<string, unknown> | null {
  if (!settled(block)) return null;
  const text = resultText(block).trim();
  if (text === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 定稿失败信封（ok:false 的规范值），无则 null。 */
export function failureOf(
  value: Record<string, unknown> | null,
): { code: string; message: string; retryable: boolean } | null {
  if (value === null || value.ok !== false) return null;
  return {
    code: typeof value.code === 'string' ? value.code : 'unknown',
    message: typeof value.message === 'string' ? value.message : '（无说明）',
    retryable: value.retryable === true,
  };
}

/**
 * 结果事件的工具私有 meta 载荷（tool/result 事件的 meta 字段：opaque to core，
 * 工具拥有形状并在 presentResult 读回；dsh-session 契约见 types.d.ts 注释），
 * 非对象时返回 null。卡片把 meta 作为 canonical value 的并列摄取面。
 */
export function metaOf(block: ToolCallBlock): Record<string, unknown> | null {
  if (!settled(block) || block.meta === undefined) return null;
  return typeof block.meta === 'object' && block.meta !== null && !Array.isArray(block.meta)
    ? block.meta as Record<string, unknown>
    : null;
}

/** 摘要文本截断。 */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 从参数 JSON 取摘要（无参数 JSON 时退 callId）。 */
export function argsSummary(block: ToolCallBlock): string {
  const raw = argsRawOf(block);
  if (raw.trim() === '') return block.callId;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of ['prompt', 'assetPath', 'assetName', 'provider'] as const) {
        const v = record[key];
        if (typeof v === 'string' && v !== '') return truncate(v, 60);
      }
      const first = Object.values(record).find((v) => typeof v === 'string' && v !== '');
      if (typeof first === 'string') return truncate(first, 60);
    }
    if (typeof parsed === 'string' && parsed !== '') return truncate(parsed, 60);
  } catch {
    return truncate(raw, 60);
  }
  return block.callId;
}

/** 预览图路径候选键（与 preview 工具侧字段命名约定一致，宽备）。 */
const PREVIEW_KEYS = ['previewPng', 'previewPath', 'previewImage', 'previewUrl'] as const;

/** 从 canonical value 取预览图工作区相对路径（png/gif/jpg/webp 字尾），无则 null。 */
export function previewPathOf(value: Record<string, unknown> | null): string | null {
  if (value === null) return null;
  for (const key of PREVIEW_KEYS) {
    const v = value[key];
    if (typeof v === 'string' && /\.(png|gif|jpe?g|webp)$/i.test(v)) return v;
  }
  return null;
}

/** 字符串字段取值。 */
export function pickString(value: Record<string, unknown> | null, key: string): string | null {
  const v = value?.[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** 数字字段取值。 */
export function pickNumber(value: Record<string, unknown> | null, key: string): number | null {
  const v = value?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
