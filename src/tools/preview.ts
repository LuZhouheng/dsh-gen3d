// gen3d_render_preview —— 本地视口级预览渲染（零网络零配额）。
//
// 把资产的 GLB 读进来，用纯 JS 软光栅渲染器（src/render/soft-renderer.ts）
// 出 turntable 预览：
// - PNG contact-sheet（N 视角横向拼图）与 GIF turntable（动图）各一份写盘到
//   <workspace>/.dsh-gen3d/previews/<stem>-contact.png / <stem>-turntable.gif；
// - 两张图各存一份到 attachments（ctx.attachments.saveImage，经模块级注入
//   setPreviewAttachmentStore 接入，装配层在 inject 'attachments' 后注入），
//   output.render 返回 [text, image, image] 三块；
// - text 块必须自足：text-only 模型看不到图，需要资产路径 / 面数 / 视角数 /
//   预览文件相对路径。
//
// 前台执行（不进 ctx.jobs 后台化）：图片块必须留在最终结果里，后台任务
// 只回 jobId 会丢掉附件。
//
// 失败语义：资产不存在 → asset_not_found；GLB 解析失败（如旧版 36B 占位
// mock 字节）→ asset_unrenderable（含原因）；模型无可渲染三角形同样
// asset_unrenderable。全部经 defineGen3dTool → toToolFailure 包成失败信封。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { encodeGif, encodePng } from '../render/encode.js';
import { readGlb } from '../render/glb-reader.js';
import { contactSheet, renderTurntable, type RenderStyle } from '../render/soft-renderer.js';
import { Gen3dStore } from '../storage.js';
import {
  defineGen3dTool,
  getStore,
  resultSchema,
  sanitizeStem,
  ToolError,
  type ContentBlock,
  type Gen3dToolSpec,
} from './common.js';

// ── attachments 注入（装配层 set；头less 无该服务时为 null，attached=false） ──

/** ImageAttachmentRef 的结构投影（@deepseek-ai/dsh-attachment 未在依赖里，
 * 这里按字段形状声明，仅工具层使用）。 */
export interface ImageAttachmentRefLike {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

/** ctx.attachments 的最小接口面（saveImage 足够本工具使用）。 */
export interface AttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRefLike>;
}

let attachmentStore: AttachmentStoreLike | null = null;

/** 注入附件服务（src/index.ts 装配层调用；测试注入 fake）。 */
export function setPreviewAttachmentStore(store: AttachmentStoreLike | null): void {
  attachmentStore = store;
}

// ── 资产解析（preview / inspect 共用） ───────────────────────────────────────

/** 按名字或相对路径解析资产：名字按 basename（含/不含 .glb）或 userLabel 匹配。 */
export async function resolveAssetPath(store: Gen3dStore, asset: string): Promise<string> {
  const wanted = asset.trim();
  if (wanted === '') {
    throw new ToolError('invalid_args', 'asset 必须是资产名或相对路径');
  }
  // 含路径分隔符：相对路径直解（score_quality 同款）
  if (wanted.includes('/') || wanted.endsWith('.glb')) {
    const path = wanted.endsWith('.glb') ? wanted : `${wanted.replace(/\/+$/, '')}.glb`;
    if (await store.hasAsset(path)) return path;
    if (wanted.includes('/')) throw new ToolError('asset_not_found', `资产不存在：${wanted}`);
    // 名字带扩展名也算名字匹配（下面的回落会处理）
  }
  const stem = wanted.replace(/\.glb$/i, '').toLowerCase();
  const assets = await store.listAssets();
  const matches = assets.filter((a) => {
    const base = a.assetPath.split('/').pop() ?? '';
    const baseStem = base.replace(/\.glb$/i, '').toLowerCase();
    if (baseStem === stem) return true;
    return a.sidecar?.custom.userLabel?.toLowerCase() === stem;
  });
  if (matches.length === 0) {
    throw new ToolError('asset_not_found', `工作区没有名为「${wanted}」的资产（可用 gen3d_list_assets 查看全部）`);
  }
  if (matches.length > 1) {
    throw new ToolError(
      'ambiguous_asset',
      `「${wanted}」匹配多个资产：${matches.map((m) => m.assetPath).join('、')}，请用相对路径指定`,
    );
  }
  return matches[0]!.assetPath;
}

// ── 工具定义 ────────────────────────────────────────────────────────────────

interface PreviewValue {
  ok: true;
  assetPath: string;
  /** attachments 引用（未注入附件服务时为 null；文本块自足）。 */
  previewPng: ImageAttachmentRefLike | null;
  previewGif: ImageAttachmentRefLike | null;
  faces: number;
  angles: number;
  size: number;
  style: RenderStyle;
  /** 两张图是否都已存入 attachments。 */
  attached: boolean;
}

/** image 内容块（本地 DSL 的 ContentBlock 只声明 text；render 桥接处放宽）。 */
type RenderBlock = ContentBlock | { type: 'image'; attachment: ImageAttachmentRefLike };

const STYLE_ENUM = ['shaded', 'clay', 'wireframe'] as const;
const BG_ENUM = ['dark', 'light'] as const;

function asInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.round(n);
  if (v < min) throw new ToolError('invalid_args', `数值超出范围（${min}–${max}）：${v}`);
  if (v > max) throw new ToolError('invalid_args', `数值超出范围（${min}–${max}）：${v}`);
  return v;
}

function asStyle(raw: unknown): RenderStyle {
  const v = String(raw ?? 'shaded');
  if (!(STYLE_ENUM as readonly string[]).includes(v)) {
    throw new ToolError('invalid_args', `style 不支持：${v}（可选 ${STYLE_ENUM.join(' / ')}）`);
  }
  return v as RenderStyle;
}

function asBackground(raw: unknown): 'dark' | 'light' {
  const v = String(raw ?? 'dark');
  if (!(BG_ENUM as readonly string[]).includes(v)) {
    throw new ToolError('invalid_args', `background 不支持：${v}（可选 ${BG_ENUM.join(' / ')}）`);
  }
  return v as 'dark' | 'light';
}

/** 预览文件工作区相对路径（落盘、prose、presentationMeta 共用同一 stem 规则）。 */
function previewFilePaths(assetPath: string): { png: string; gif: string } {
  const stem = sanitizeStem(assetPath.split('/').pop()?.replace(/\.glb$/i, '') ?? '', 'asset');
  return {
    png: `.dsh-gen3d/previews/${stem}-contact.png`,
    gif: `.dsh-gen3d/previews/${stem}-turntable.gif`,
  };
}

function renderPreview(args: Record<string, unknown>, value: PreviewValue): RenderBlock[] {
  const paths = previewFilePaths(value.assetPath);
  const lines = [
    `预览已生成（后台本地渲染，不消耗配额）：${value.assetPath}`,
    `模型面数：${value.faces}；视角数：${value.angles}；渲染尺寸：${value.size}px；样式：${value.style}`,
    `预览文件（工作区相对路径）：${paths.png}（多视角接触板）`,
    `${paths.gif}（旋转动图）`,
    value.attached
      ? '两张图片已作为附件随本结果返回。'
      : '当前运行无附件服务（headless），图片已写盘，请按上述文件路径查看。',
  ];
  const blocks: RenderBlock[] = [{ type: 'text', text: lines.join('\n') }];
  if (value.previewPng) blocks.push({ type: 'image', attachment: value.previewPng });
  if (value.previewGif) blocks.push({ type: 'image', attachment: value.previewGif });
  return blocks;
}

const previewSpec: Gen3dToolSpec<PreviewValue> = {
  name: 'gen3d_render_preview',
  description:
    '本地渲染视口级预览（不调用任何 provider、不消耗配额）：读 GLB 用内置软渲染器出多视角 turntable，生成 PNG 接触板 + GIF 动图写盘到 .dsh-gen3d/previews/ 并作为图片附件返回。用于在生成后直观确认模型外形（面数 / 比例 / 轮廓），支持 shaded / clay / wireframe 三种样式。',
  parameters: {
    asset: { type: 'string', required: true, description: '资产名（不含扩展名，如 hero）或相对路径（assets/3d/characters/hero.glb）' },
    angles: { type: 'integer', description: '环绕视角数 4–24（默认 8）' },
    size: { type: 'integer', description: '渲染边长 256–1024 像素（默认 768）' },
    style: { type: 'string', enum: STYLE_ENUM, description: "渲染样式：shaded 正常着色 / clay 纯色陶土 / wireframe 网状线框（默认 shaded）" },
    background: { type: 'string', enum: BG_ENUM, description: '背景：dark 深色 / light 浅色（默认 dark）' },
  },
  output: {
    schema: resultSchema({
      assetPath: { type: 'string', description: '资产相对路径' },
      previewPng: { type: 'json', description: 'PNG 接触板附件引用（无附件服务时为 null）' },
      previewGif: { type: 'json', description: 'GIF 动图附件引用（无附件服务时为 null）' },
      faces: { type: 'integer', description: '模型三角形数' },
      angles: { type: 'integer', description: '实际视角数' },
      size: { type: 'integer', description: '渲染边长' },
      style: { type: 'string', description: '渲染样式' },
      attached: { type: 'boolean', description: '图片是否已存入 attachments' },
    }),
    render: renderPreview as unknown as Gen3dToolSpec<PreviewValue>['output']['render'],
    // render 是 prose（text-only 模型自足），结构化展示数据走 presentationMeta：
    // web 侧 keyed 卡片（src/client/tool-cards.tsx）从 tool/result.meta 取
    // previewPng/previewGif 的【文件路径】（注意与规范值里的附件引用对象不同）。
    presentationMeta: (_args, value) => {
      const paths = previewFilePaths(value.assetPath);
      return {
        assetPath: value.assetPath,
        previewPng: paths.png,
        previewGif: paths.gif,
        faces: value.faces,
        angles: value.angles,
        size: value.size,
        style: value.style,
        attached: value.attached,
      };
    },
  },
  async run(args) {
    const store = getStore();
    const assetRaw = typeof args.asset === 'string' ? args.asset.trim() : '';
    if (assetRaw === '') throw new ToolError('invalid_args', 'asset 必须是非空字符串');
    const angles = asInt(args.angles, 8, 4, 24);
    const size = asInt(args.size, 768, 256, 1024);
    const style = asStyle(args.style);
    const background = asBackground(args.background);

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
      throw new ToolError('asset_unrenderable', `GLB 解析失败（可能是旧版占位 mock 或损坏文件）：${reason}`);
    }

    let result;
    try {
      result = renderTurntable(doc, { size, angles, style, background });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ToolError('asset_unrenderable', `渲染失败：${reason}`);
    }
    if (result.faces === 0) {
      throw new ToolError('asset_unrenderable', `模型不含可渲染三角形：${assetPath}`);
    }

    const sheet = contactSheet(result.frames);
    const pngBytes = encodePng(sheet);
    const gifBytes = encodeGif(result.frames);

    // 落盘 <workspace>/.dsh-gen3d/previews/<stem>-[contact|turntable].<fmt>
    const stem = sanitizeStem(assetPath.split('/').pop()?.replace(/\.glb$/i, '') ?? '', 'asset');
    const previewDir = join(store.workspaceRoot, '.dsh-gen3d', 'previews');
    await mkdir(previewDir, { recursive: true });
    const contactName = `${stem}-contact.png`;
    const turntableName = `${stem}-turntable.gif`;
    await writeFile(join(previewDir, contactName), pngBytes);
    await writeFile(join(previewDir, turntableName), gifBytes);

    // attachments（可缺省：headless 无附件服务时 attached=false，文本块自足）
    let previewPng: ImageAttachmentRefLike | null = null;
    let previewGif: ImageAttachmentRefLike | null = null;
    let attached = false;
    if (attachmentStore) {
      try {
        previewPng = await attachmentStore.saveImage({ data: pngBytes, mediaType: 'image/png', name: contactName });
        previewGif = await attachmentStore.saveImage({ data: gifBytes, mediaType: 'image/gif', name: turntableName });
        attached = previewPng !== null && previewGif !== null;
      } catch {
        // 附件失败不视为工具失败：图片已落盘，文本块说明即可
        previewPng = null;
        previewGif = null;
        attached = false;
      }
    }

    return {
      ok: true,
      assetPath,
      previewPng,
      previewGif,
      faces: result.faces,
      angles,
      size,
      style,
      attached,
    };
  },
};

export const gen3dRenderPreview = defineGen3dTool(previewSpec);
