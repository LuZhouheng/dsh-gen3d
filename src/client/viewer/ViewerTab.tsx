// 3D 资产视窗标签页 —— conversation.view 槽位组件（浏览器半边）。
//
// 布局：左侧资产列表（按槽位分组）+ 右侧 WebGL 视口；顶部条放资产名 / 面数 /
// 「重新渲染预览」提示（提示不调工具——CLI 语义下由会话里的 agent 跑
// gen3d_render_preview，本页只负责提示与展示产出的预览文件）。
//
// 数据面：GET /plugins/dsh-gen3d/api/assets（同域；空态 / 加载失败态 / 重试按钮
// 都在本组件内）；GLB 从 /plugins/dsh-gen3d/files/<path> 拉取（AssetViewport）。
//
// 槽位契约：官方 'conversation.view'（kind:list / scope:session / owner:
// { inspect?, onInspectDone? }）未随本仓库 devDeps 安装类型包，本组件按
// 官方 lib/types/client/contract/slots.d.ts 的结构镜像声明自己消费的成员；
// 注册与其余 props 见 index.ts 的注释与该文件。

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

import { AssetViewport, type AssetViewportProps } from './AssetViewport.js';
import {
  formatBytes,
  formatFaceCount,
  groupSlots,
  normalizeAssetsResponse,
  pluginsFileUrl,
  previewKindOf,
  type ViewerAsset,
} from './viewer-models.js';

/** 本组件消费的槽位 props（官方 ConvViewOwnerProps 的 owner 部分本页不消费——inspect
 *  / onInspectDone 由平台转发、本页忽略；标准 kit 只需 sessionId）。 */
export interface ViewerTabProps {
  sessionId: string;
}

type ListState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; assets: ViewerAsset[] };

const styles: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontFamily: 'system-ui, sans-serif', fontSize: 13, color: '#d7dce2', background: '#14171c' },
  topbar: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid #262b33', flex: 'none' },
  title: { fontWeight: 600, fontSize: 14 },
  fact: { color: '#8a93a0', fontSize: 12 },
  hint: { marginLeft: 'auto', color: '#6c7683', fontSize: 12 },
  body: { display: 'flex', flex: 1, minHeight: 0 },
  sidebar: { width: 240, flex: 'none', overflow: 'auto', borderRight: '1px solid #262b33', padding: '8px 6px' },
  groupLabel: { padding: '4px 8px', color: '#8a93a0', fontSize: 12, fontWeight: 600 },
  item: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 6, border: 'none', background: 'transparent', color: '#d7dce2', cursor: 'pointer', fontSize: 13 },
  itemActive: { background: '#2b3138' },
  itemHint: { color: '#6c7683', fontSize: 11 },
  viewport: { flex: 1, minWidth: 0 },
  imagePane: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f1216', overflow: 'auto', padding: 16 },
  imageFit: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' },
  status: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start', padding: '10px 12px', color: '#8a93a0', fontSize: 12 },
  button: { padding: '3px 10px', fontSize: 12, cursor: 'pointer', background: '#242931', color: '#d7dce2', border: '1px solid #3a414b', borderRadius: 6 },
};

export function ViewerTab(_props: ViewerTabProps) {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [triangles, setTriangles] = useState<number | null>(null);
  const [clipCount, setClipCount] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setList({ status: 'loading' });
    fetch('/plugins/dsh-gen3d/api/assets', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<unknown>;
      })
      .then(
        (data) => {
          const result = normalizeAssetsResponse(data);
          setList(result.ok ? { status: 'ready', assets: result.assets } : { status: 'error', error: result.error });
        },
        (error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          const message = error instanceof Error ? error.message : String(error);
          setList({ status: 'error', error: `资产清单获取失败：${message}` });
        },
      );
    return () => { controller.abort() };
  }, [reloadToken]);

  const selectedAsset = useMemo(
    () => (list.status === 'ready' ? list.assets.find((a) => a.assetPath === selectedPath) ?? null : null),
    [list, selectedPath],
  );
  /** 选中项的预览形态：图片直出 <img>，模型 / 其他走 WebGL 视口（视口自带解析错误态）。 */
  const selectedKind = selectedPath === null ? null : previewKindOf(selectedPath);
  const groups = useMemo(
    () => (list.status === 'ready' ? groupSlots(list.assets) : []),
    [list],
  );

  const onStats = useCallback<NonNullable<AssetViewportProps['onStats']>>((stats) => {
    setTriangles(stats.triangles);
    setClipCount(stats.clips ?? 0);
  }, []);

  return (
    <div style={styles.root}>
      <div style={styles.topbar}>
        <span style={styles.title}>3D 资产</span>
        {selectedAsset !== null && (
          <span style={styles.fact}>
            {selectedAsset.name}
            {triangles !== null && triangles > 0 ? ` · ${formatFaceCount(triangles)} 面` : ''}
            {clipCount > 0 ? ` · ${clipCount} 动画` : ''}
          </span>
        )}
        <span style={styles.hint}>
          {selectedAsset === null
            ? '加载完成前不能预览；mock 资产不可渲染属预期'
            : '需要新预览图？让 agent 在会话里运行 gen3d_render_preview 后再回到本页'}
        </span>
      </div>
      <div style={styles.body}>
        <div style={styles.sidebar}>
          {list.status === 'loading' && <div style={styles.status}>加载资产清单…</div>}
          {list.status === 'error' && (
            <div style={styles.status}>
              <span>{list.error}</span>
              <button type="button" style={styles.button} onClick={() => setReloadToken((n) => n + 1)}>重试</button>
            </div>
          )}
          {list.status === 'ready' && list.assets.length === 0 && (
            <div style={styles.status}>
              <span>工作区还没有 3D 资产。让 agent 运行 gen3d_text_to_3d / gen3d_image_to_3d 生成第一个模型。</span>
              <button type="button" style={styles.button} onClick={() => setReloadToken((n) => n + 1)}>重新扫描</button>
            </div>
          )}
          {list.status === 'ready' && groups.map((group) => (
            <div key={group.slot}>
              <div style={styles.groupLabel}>{group.slot}</div>
              {group.assets.map((asset) => {
                const active = asset.assetPath === selectedPath;
                return (
                  <button
                    key={asset.assetPath}
                    type="button"
                    style={active ? { ...styles.item, ...styles.itemActive } : styles.item}
                    onClick={() => { setSelectedPath(asset.assetPath); setTriangles(null) }}
                  >
                    <div>{asset.name}</div>
                    <div style={styles.itemHint}>{asset.size !== undefined ? formatBytes(asset.size) : '…'}</div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div style={styles.viewport}>
          {selectedKind === 'image' && selectedPath !== null ? (
            <div style={styles.imagePane}>
              <img
                src={pluginsFileUrl(selectedPath)}
                alt={selectedAsset?.name ?? selectedPath}
                style={styles.imageFit}
              />
            </div>
          ) : (
            <AssetViewport
              assetPath={selectedPath}
              assetName={selectedAsset?.name ?? ''}
              onStats={onStats}
            />
          )}
        </div>
      </div>
    </div>
  );
}
