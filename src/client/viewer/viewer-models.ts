// 3D 资产视窗的数据模型层 —— 纯函数数据面，不碰 React / three（可单测）。
//
// 数据来源：插件 host 半边自注册的 webServer 前缀路由（同域）：
//   GET /plugins/dsh-gen3d/api/assets  —— 资产清单（host 半边契约：StoredAsset[]
//     项目至少带 assetPath；本层做防御性归一，形状未知时容错降级，不抛错）
//   GET /plugins/dsh-gen3d/files/<path>  —— 资产 / 预览文件字节（GLB、PNG…）
// 清单响应形态保守接受：裸数组 / { assets } / { data } / { items }，且包裹层的
// ok 与否不影响解析（取得到条目就算数）；条目字段沿 host 半边 storage.ts 的
// StoredAsset 命名（assetPath / slot / sidecar），另兼容 path / file 变体。

/** 一条可预览资产（显示面用；字段缺失均降级）。 */
export interface ViewerAsset {
  /** 工作区相对路径（如 assets/3d/characters/hero.glb），即 files 路由的入参。 */
  assetPath: string;
  /** 槽位（characters / meshes / 未知串）。 */
  slot: string;
  /** 显示名（去 .glb 后缀）。 */
  name: string;
  /** 主文件字节数（有则显示）。 */
  size?: number;
  /** sidecar 结构（host 契约里 undefined 表示缺失；本层不解释，原样透传）。 */
  sidecar?: unknown;
  /** 扫描到的已知字符串字段（调试友好的字段名快照，非契约）。 */
  fields: Record<string, unknown>;
}

export type AssetsLoadResult =
  | { ok: true; assets: ViewerAsset[] }
  | { ok: false; error: string };

/** 顺序即分组渲染顺序。 */
const SLOT_ORDER = ['characters', 'meshes'] as const;

/** 从路径推断槽位（沿 storage.ts 的 ASSET_SLOT_DIRS 布局）。 */
function slotFromPath(assetPath: string): string {
  if (assetPath.includes('/meshes/')) return 'meshes';
  if (assetPath.includes('/characters/')) return 'characters';
  return 'assets';
}

/** 显示名：取末段基底、剥掉 .glb 后缀。 */
export function viewerAssetName(assetPath: string): string {
  const base = assetPath.split('/').pop() ?? assetPath;
  return base.replace(/\.glb$/i, '');
}

/** 条目归一：非对象 / 无路径串 → null（跳过）。 */
function normalizeItem(raw: unknown): ViewerAsset | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const assetPath = pickPathString(item);
  if (assetPath === null) return null;
  const slot = typeof item.slot === 'string' && item.slot !== ''
    ? item.slot
    : slotFromPath(assetPath);
  return {
    assetPath,
    slot,
    name: viewerAssetName(assetPath),
    size: typeof item.size === 'number' ? item.size : undefined,
    sidecar: item.sidecar,
    fields: item,
  };
}

/** 条目路径字段：assetPath（host 契约）> path > file。 */
function pickPathString(item: Record<string, unknown>): string | null {
  for (const key of ['assetPath', 'path', 'file'] as const) {
    const v = item[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

/** 从响应里取条目数组（wrapper key 由窄到宽）。 */
function itemsOf(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  for (const key of ['assets', 'data', 'items'] as const) {
    const v = record[key];
    if (Array.isArray(v)) return v;
  }
  return null;
}

/** 归一资产清单响应；结构完全不认识时返回错误文案（由组件显示）。 */
export function normalizeAssetsResponse(data: unknown): AssetsLoadResult {
  const items = itemsOf(data);
  if (items === null) {
    return { ok: false, error: '资产清单接口返回无法识别的结构（需要数组或 assets/data/items 键）' };
  }
  const assets: ViewerAsset[] = [];
  for (const raw of items) {
    const asset = normalizeItem(raw);
    if (asset !== null) assets.push(asset);
  }
  assets.sort((a, b) => {
    const si = SLOT_ORDER.indexOf(a.slot as (typeof SLOT_ORDER)[number]);
    const sj = SLOT_ORDER.indexOf(b.slot as (typeof SLOT_ORDER)[number]);
    const gi = si === -1 ? SLOT_ORDER.length : si;
    const gj = sj === -1 ? SLOT_ORDER.length : sj;
    return gi - gj || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  return { ok: true, assets };
}

/** 槽位分组（保持 SLOT_ORDER，未知槽位按名字排最后）。 */
export function groupSlots(assets: readonly ViewerAsset[]): Array<{ slot: string; assets: ViewerAsset[] }> {
  const bySlot = new Map<string, ViewerAsset[]>();
  for (const asset of assets) {
    const list = bySlot.get(asset.slot) ?? [];
    list.push(asset);
    bySlot.set(asset.slot, list);
  }
  const keys = [...bySlot.keys()];
  keys.sort((a, b) => {
    const ia = SLOT_ORDER.indexOf(a as (typeof SLOT_ORDER)[number]);
    const ib = SLOT_ORDER.indexOf(b as (typeof SLOT_ORDER)[number]);
    return (ia === -1 ? SLOT_ORDER.length : ia) - (ib === -1 ? SLOT_ORDER.length : ib);
  });
  return keys.map((slot) => ({ slot, assets: bySlot.get(slot) ?? [] }));
}

/** 路径 → 插件文件路由 URL（逐段 encode，保留层级分隔）。 */
export function pluginsFileUrl(path: string): string {
  return `/plugins/dsh-gen3d/files/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** 字节数人类可读（KiB/MiB，保留 1 位）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** 面数人类可读（万进位示例：30 000）。 */
export function formatFaceCount(count: number): string {
  return new Intl.NumberFormat('zh-CN').format(count);
}
