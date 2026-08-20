// gen3d 设置卡片组件 —— 自绘最小 chrome。
//
// 不引官方 ui-settings-plugins 的卡片件/表单（bundle 纯度门禁止跨插件值导入；
// 官方 cookbook 明说卡片自己渲染 chrome 与 staging）；四行供应商状态徽标 +
// apiKeyEnv 引用输入，写路径走控制器 action（scope.set/unset，节修订栅栏）。
// 文案硬编码中文（插件文案一贯中文）。

import type { CSSProperties } from 'react';
import { useState } from 'react';
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';

import type { Gen3dCardFace, Gen3dCardState, ProviderCardRow } from './gen3d-card-controller.js';

export type Gen3dCardProps =
  PropsRuntime<'settings.plugin.item'>
  & InjectFace<Gen3dCardFace>;

/** 供应商状态行。 */
interface RowProps {
  row: ProviderCardRow;
  /** 整节可写性（写按钮的门槛）。 */
  sectionWritable: boolean;
  onSave(ref: string): void;
  onClear(): void;
}

const styles: Record<string, CSSProperties> = {
  card: { fontFamily: 'system-ui, sans-serif', fontSize: 13, lineHeight: 1.5, maxWidth: 560 },
  title: { margin: '0 0 4px', fontSize: 15, fontWeight: 600 },
  description: { margin: '0 0 12px', color: '#666' },
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #eee' },
  badge: { padding: '1px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600, color: '#fff' },
  badgeReal: { backgroundColor: '#2e7d32' },
  badgeMock: { backgroundColor: '#9e9e9e' },
  refInput: { flex: 1, minWidth: 0, padding: '3px 6px', fontSize: 13, fontFamily: 'monospace' },
  button: { padding: '2px 8px', fontSize: 12, cursor: 'pointer' },
  overridden: { color: '#b26a00', fontSize: 12 },
  footnote: { marginTop: 10, color: '#888', fontSize: 12 },
};

/** 单行：显示名 + real/mock 徽标 + 引用输入 + 保存/清除。 */
function ProviderRow({ row, sectionWritable, onSave, onClear }: RowProps) {
  // 以当前 resolved 引用为初始草稿；resolved 引用外部变化（如清除）时以 key
  // 重挂载本行，草稿随之刷新。
  const [draft, setDraft] = useState(row.apiKeyEnv);
  const canWrite = sectionWritable && row.writable;
  return (
    <div style={styles.row}>
      <span style={{ width: 150 }}>{row.displayName}</span>
      <span
        style={{ ...styles.badge, ...(row.mode === 'real' ? styles.badgeReal : styles.badgeMock) }}
        title={row.mode === 'real' ? '官方 API key 已配置，真实调用可用' : '未配置 key；计费类工具回退确定性 mock（usedMock: true）'}
      >
        {row.mode === 'real' ? 'real' : 'mock'}
      </span>
      <input
        style={styles.refInput}
        value={draft}
        disabled={!canWrite}
        spellCheck={false}
        onChange={(e) => { setDraft(e.target.value) }}
        aria-label={`${row.displayName} 凭证变量名`}
      />
      <button type="button" style={styles.button} disabled={!canWrite} onClick={() => onSave(draft)}>
        保存
      </button>
      <button type="button" style={styles.button} disabled={!sectionWritable} onClick={onClear}>
        清除
      </button>
      {row.overridden && <span style={styles.overridden}>已覆盖</span>}
    </div>
  );
}

/** 卡片：标题 + 四行 + Hunyuan3D TC3 路径说明脚注。 */
export function Gen3dCard(props: Gen3dCardProps) {
  const state = props.useGen3dCard((s) => s);
  if (state.status === 'unavailable') {
    return (
      <div style={styles.card}>
        <h4 style={styles.title}>3D 生成供应商配置</h4>
        <p style={styles.description}>当前部署未开放 gen3d 设置节（设置服务未挂载或连接为进程本地）。</p>
      </div>
    );
  }
  const loading = state.status === 'loading';
  const rows = state.providers.map((row) => (
    <ProviderRow
      key={`${row.providerId}:${row.apiKeyEnv}`}
      row={row}
      sectionWritable={state.writable}
      onSave={(ref) => { void props.setRef(row.providerId, ref) }}
      onClear={() => { void props.clearRef(row.providerId) }}
    />
  ));
  return (
    <div style={styles.card}>
      <h4 style={styles.title}>3D 生成供应商配置</h4>
      <p style={styles.description}>
        四家供应商（Meshy / Hunyuan3D / Tripo3D / Rodin）的官方 API 凭证引用与配置状态。
        凭证变量名缺省即 {`${'MESHY_API_KEY'} / ${'HUNYUAN3D_API_KEY'} / ${'TRIPO3D_API_KEY'} / ${'RODIN_API_KEY'}`}；
        改写引用后，工具侧密钥解析随之改读对应变量名（未配置回退确定性 mock，不消耗配额）。
      </p>
      {loading
        ? <p style={styles.description}>加载中…</p>
        : rows}
      <p style={styles.footnote}>
        注 1：Hunyuan3D 的 TC3 密钥对（HUNYUAN3D_SECRET_ID + HUNYUAN3D_SECRET_KEY，腾讯云 API 3.0 后处理路径）
        不经过凭证域，本卡片只反映 HUNYUAN3D_API_KEY（TokenHub）路径的配置状态；TC3 路径由工具在主机侧读取。
        <br />
        注 2：卡片的 configured 状态来自凭证域（credentials describe，覆盖环境变量与
        $DSH_HOME/.credentials.yaml 层）；直接写在调用目录 &lt;cwd&gt;/.env 的 key 不在凭证域内，卡片不反映，
        工具侧状态以 gen3d_provider_status 工具口径为准。
      </p>
    </div>
  );
}
