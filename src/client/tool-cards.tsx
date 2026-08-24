// gen3d 工具的 keyed tool.call.toolview 卡片 —— 浏览器半边（组件层）。
//
// 为 gen3d_render_preview / gen3d_text_to_3d / gen3d_image_to_3d /
// gen3d_views_to_3d / gen3d_inspect_asset 注册按 wire 工具名分发的行卡片
// （keyed 槽，entryKey = 工具名）；其余 gen3d 工具不注册，走平台默认行。
//
// 数据推导（canonical value / 失败信封 / 状态）在 tool-cards-model.ts（纯函数），
// 本文件只做呈现。组件在数据缺失时退「通用样式行」（参数摘要 + 结果文本首段，
// 语义与平台 GenericToolCard 的习惯一致）——注意绝不能返回 undefined 完事：
// keyed 槽命中即渲染，组件返回 null 不会落回平台 fallback（读 ui-renderer 的
// renderOutletContent 确认：fallback 只在「该 key 无注册」时生效）。
//
// 约定：文案硬编码中文；不引 UI 库（React 18 + 内联样式，与 Gen3dCard 同款）。

import type { CSSProperties, ReactNode } from 'react';

import {
  argsSummary,
  canonicalValue,
  failureOf,
  metaOf,
  pickNumber,
  pickString,
  previewPathOf,
  resultText,
  settled,
  stateOf,
  type Gen3dToolViewProps,
} from './tool-cards-model.js';
import { pluginsFileUrl } from './viewer/viewer-models.js';

export type { Gen3dToolViewProps } from './tool-cards-model.js';

// ── 通用卡片外观（内联样式，浅色主题；与 Gen3dCard 风格一致） ────────────────

const styles: Record<string, CSSProperties> = {
  card: { fontFamily: 'system-ui, sans-serif', fontSize: 13, lineHeight: 1.5, color: '#1a1d21' },
  head: { display: 'flex', alignItems: 'center', gap: 8 },
  badge: { padding: '1px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600, color: '#fff', flex: 'none' },
  badgeRunning: { backgroundColor: '#9e9e9e' },
  badgeOk: { backgroundColor: '#2e7d32' },
  badgeError: { backgroundColor: '#c62828' },
  title: { fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  summary: { color: '#666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  body: { margin: '6px 0 0 24px' },
  facts: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', margin: '4px 0 0' },
  factLabel: { color: '#888', whiteSpace: 'nowrap' },
  factValue: { color: '#1a1d21', wordBreak: 'break-all' },
  code: { background: '#f2f3f5', borderRadius: 6, padding: '8px 10px', fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '4px 0 0', maxHeight: 160, overflow: 'auto' },
  preview: { margin: '6px 0 0', maxWidth: 420 },
  previewImg: { width: '100%', borderRadius: 8, border: '1px solid #e3e5e8', display: 'block' },
  error: { color: '#c62828' },
  warn: { color: '#b26a00' },
  muted: { color: '#888' },
  button: { padding: '1px 8px', fontSize: 12, cursor: 'pointer', marginLeft: 12 },
  inspect: { padding: '1px 8px', fontSize: 12, cursor: 'pointer' },
  foot: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 },
};

/** 事实行汇总渲染（label 固定列）。 */
function FactRows({ facts }: { facts: Array<{ label: string; value: ReactNode }> }) {
  return (
    <div style={styles.facts}>
      {facts.map((fact) => (
        <div key={fact.label} style={{ display: 'contents' }}>
          <span style={styles.factLabel}>{fact.label}</span>
          <span style={styles.factValue}>{fact.value}</span>
        </div>
      ))}
    </div>
  );
}

/** 状态徽标。 */
function StateBadge({ state }: { state: 'running' | 'ok' | 'error' | 'stopped' }) {
  const label = state === 'running' ? '运行中' : state === 'ok' ? '完成' : state === 'error' ? '失败' : '已停止';
  const style = state === 'running' ? styles.badgeRunning : state === 'ok' ? styles.badgeOk : styles.badgeError;
  return <span style={{ ...styles.badge, ...style }}>{label}</span>;
}

/** 卡片公共骨架：状态徽标 + 标题 + 摘要。 */
function CardHead({ state, title, summary }: { state: 'running' | 'ok' | 'error' | 'stopped'; title: string; summary: string }) {
  return (
    <div style={styles.head}>
      <StateBadge state={state} />
      <span style={styles.title}>{title}</span>
      <span style={styles.summary}>{summary}</span>
    </div>
  );
}

/** 通用脚部：状态注记 + inspect 按钮。 */
function PropsFoot({ state, inspect }: { state: 'running' | 'ok' | 'error' | 'stopped'; inspect?: Gen3dToolViewProps['inspect'] }) {
  return (
    <div style={styles.foot}>
      {state === 'error' && <span style={styles.error}>调用失败，详见折叠内容</span>}
      {state === 'stopped' && <span style={styles.warn}>调用被中断</span>}
      {inspect !== undefined && (
        <button type="button" style={styles.inspect} onClick={inspect}>检查详情</button>
      )}
    </div>
  );
}

/** 通用回退行：参数摘要 + 结果文本（数据缺失时退化到这里，绝不返回 undefined）。 */
function GenericRow(props: Gen3dToolViewProps) {
  const state = stateOf(props.block);
  const summary = argsSummary(props.block);
  const output = settled(props.block) ? resultText(props.block).trim() : null;
  return (
    <div style={styles.card}>
      <CardHead state={state} title={props.toolName} summary={summary} />
      {(output !== null && output !== '') && (
        <pre style={styles.code}>{output.slice(0, 2000)}</pre>
      )}
      <PropsFoot state={state} inspect={props.inspect} />
    </div>
  );
}

/** 资产路径 + 打开按钮（openFile 有则给）。 */
function AssetPathRow({ assetPath, openFile }: { assetPath: string; openFile?: Gen3dToolViewProps['openFile'] }) {
  return (
    <span>
      {assetPath}
      {openFile !== undefined && (
        <button type="button" style={styles.button} onClick={() => openFile(assetPath)}>打开文件</button>
      )}
    </span>
  );
}

// ── gen3d_render_preview 卡片 ────────────────────────────────────────────────

/** 预览卡：定稿 ok + previewPng（canonical value 或结果 meta）→ 图片；其余态退通用行。 */
export function RenderPreviewCard(props: Gen3dToolViewProps) {
  if (stateOf(props.block) !== 'ok') return <GenericRow {...props} />;
  const value = canonicalValue(props.block) ?? metaOf(props.block);
  const imagePath = previewPathOf(value);
  if (imagePath === null) return <GenericRow {...props} />;
  const assetPath = pickString(value, 'assetPath');
  const facts = [
    { label: '预览图', value: imagePath },
    ...(assetPath !== null
      ? [{ label: '对应资产', value: <AssetPathRow assetPath={assetPath} openFile={props.openFile} /> }]
      : []),
  ];
  return (
    <div style={styles.card}>
      <CardHead state="ok" title="渲染预览" summary={imagePath} />
      <div style={styles.body}>
        <img style={styles.previewImg} src={pluginsFileUrl(imagePath)} alt={imagePath} />
        <FactRows facts={facts} />
      </div>
      <PropsFoot state="ok" inspect={props.inspect} />
    </div>
  );
}

// ── 生成类卡片（text/image/views_to_3d） ─────────────────────────────────────

/** 生成类结果事实行（canonical value + manifest 的防御性摄取）。 */
function generationFacts(value: Record<string, unknown>, props: Gen3dToolViewProps): ReactNode {
  const manifest = (typeof value.manifest === 'object' && value.manifest !== null
    ? value.manifest as Record<string, unknown>
    : null);
  const custom = (manifest !== null && typeof manifest.custom === 'object' && manifest.custom !== null
    ? manifest.custom as Record<string, unknown>
    : null);
  const facts: Array<{ label: string; value: ReactNode }> = [];
  const assetPath = pickString(value, 'assetPath');
  if (assetPath !== null) facts.push({ label: '资产', value: <AssetPathRow assetPath={assetPath} openFile={props.openFile} /> });
  const provider = pickString(custom, 'provider') ?? pickString(value, 'provider');
  if (provider !== null) facts.push({ label: '供应商', value: provider });
  const faceCount = pickNumber(custom, 'faceCount') ?? pickNumber(value, 'faceCount');
  if (faceCount !== null) facts.push({ label: '目标面数', value: new Intl.NumberFormat('zh-CN').format(faceCount) });
  if (value.cacheHit === true) facts.push({ label: '缓存', value: <span style={styles.warn}>命中（未调供应商）</span> });
  if (value.usedMock === true || (custom?.providerMode === 'mock')) {
    facts.push({ label: '模式', value: <span style={styles.warn}>mock 产物（未配置 key，不消耗配额）</span> });
  }
  if (typeof manifest?.createdAt === 'string') facts.push({ label: '生成时间', value: manifest.createdAt });
  if (typeof manifest?.size === 'number') facts.push({ label: '主文件', value: `${manifest.size} B` });
  if (custom !== null && typeof custom.readiness === 'object' && custom.readiness !== null) {
    const readiness = custom.readiness as Record<string, unknown>;
    const parts: string[] = [];
    if (readiness.rigged === true) parts.push('已绑骨');
    if (readiness.animated === true) parts.push('已套动作');
    if (parts.length > 0) facts.push({ label: 'Readiness', value: parts.join('、') });
  }
  const deps = manifest?.dependencies;
  if (Array.isArray(deps) && deps.length > 0) {
    facts.push({ label: '依赖文件', value: `${deps.length} 个` });
  }
  // 一个字段都取不到：返回 null → 调用方退 GenericRow（不返回 undefined 了事）。
  return facts.length === 0 ? null : <FactRows facts={facts} />;
}

/** 生成类卡片（text_to_3d / image_to_3d / views_to_3d 共用）。 */
export function GenerationCard(props: Gen3dToolViewProps) {
  const state = stateOf(props.block);
  if (state === 'running') {
    return (
      <div style={styles.card}>
        <CardHead state="running" title="3D 生成" summary={argsSummary(props.block)} />
      </div>
    );
  }
  const value = canonicalValue(props.block);
  const failure = failureOf(value);
  if (failure !== null) {
    return (
      <div style={styles.card}>
        <CardHead state="error" title="3D 生成" summary={failure.code} />
        <div style={styles.body}>
          <div style={styles.error}>{failure.message}</div>
          {failure.retryable && <div style={styles.warn}>可重试</div>}
        </div>
        <PropsFoot state="error" inspect={props.inspect} />
      </div>
    );
  }
  const facts = generationFacts(value ?? {}, props);
  if (facts === null) return <GenericRow {...props} />;
  return (
    <div style={styles.card}>
      <CardHead state="ok" title="3D 生成" summary={pickString(value, 'assetPath') ?? '完成'} />
      <div style={styles.body}>{facts}</div>
      <PropsFoot state="ok" inspect={props.inspect} />
    </div>
  );
}

// ── gen3d_inspect_asset 卡片 ─────────────────────────────────────────────────

/** 检查卡：统计（stats 对象逐行）+ 违规（violations/issues/warnings 数组逐条）。 */
export function InspectAssetCard(props: Gen3dToolViewProps) {
  const state = stateOf(props.block);
  if (state !== 'ok') return <GenericRow {...props} />;
  const value = canonicalValue(props.block) ?? metaOf(props.block);
  if (value === null) return <GenericRow {...props} />;
  const assetPath = pickString(value, 'assetPath') ?? pickString(value, 'path');
  const statsRaw = value.stats ?? value.statistics ?? value.summary ?? null;
  const knownStats = typeof statsRaw === 'object' && statsRaw !== null && !Array.isArray(statsRaw)
    ? statsRaw as Record<string, unknown>
    : null;
  const violationsRaw = value.violations ?? value.issues ?? value.warnings ?? null;
  const violations = Array.isArray(violationsRaw) ? violationsRaw : null;
  if (assetPath === null && knownStats === null && violations === null) return <GenericRow {...props} />;

  const facts: Array<{ label: string; value: ReactNode }> = [];
  if (assetPath !== null) facts.push({ label: '资产', value: <AssetPathRow assetPath={assetPath} openFile={props.openFile} /> });
  if (knownStats !== null) {
    for (const [key, v] of Object.entries(knownStats)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        facts.push({ label: key, value: String(v) });
      }
    }
  }
  const imagePath = previewPathOf(value);
  return (
    <div style={styles.card}>
      <CardHead state="ok" title="资产检查" summary={assetPath ?? '检查完成'} />
      <div style={styles.body}>
        <FactRows facts={facts} />
        {violations !== null && (
          <div style={{ marginTop: 6 }}>
            {violations.length === 0
              ? <span style={styles.muted}>未发现违规</span>
              : violations.map((raw, index) => {
                const message = typeof raw === 'string'
                  ? raw
                  : (typeof raw === 'object' && raw !== null
                    ? (typeof (raw as Record<string, unknown>).message === 'string'
                      ? (raw as Record<string, unknown>).message as string
                      : JSON.stringify(raw))
                    : JSON.stringify(raw));
                return <div key={index} style={index === 0 ? { marginTop: 4 } : undefined}><span style={styles.error}>⚠ {message}</span></div>;
              })}
          </div>
        )}
        {imagePath !== null && (
          <img style={{ ...styles.previewImg, marginTop: 6 }} src={pluginsFileUrl(imagePath)} alt="预览" />
        )}
      </div>
      <PropsFoot state="ok" inspect={props.inspect} />
    </div>
  );
}

// ── keyed 条目表（index.ts 据此注册） ─────────────────────────────────────────

export interface ToolviewEntry {
  /** keyed 槽的 key = wire 工具名。 */
  key: string;
  component: (props: Gen3dToolViewProps) => ReactNode;
}

export const GEN3D_TOOLVIEW_ENTRIES: readonly ToolviewEntry[] = [
  { key: 'gen3d_render_preview', component: RenderPreviewCard },
  { key: 'gen3d_text_to_3d', component: GenerationCard },
  { key: 'gen3d_image_to_3d', component: GenerationCard },
  { key: 'gen3d_views_to_3d', component: GenerationCard },
  { key: 'gen3d_inspect_asset', component: InspectAssetCard },
];
