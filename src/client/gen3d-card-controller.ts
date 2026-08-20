// gen3d 设置卡片控制器 —— 浏览器半边数据面。
//
// 通过 ctx.settingsScope.bind({ namespace: 'gen3d' }) 读写设置节：resolved
// value 恒含四家缺省引用（host 半边 schema 默认即 PROVIDER_ENV_KEYS），user
// 层字段存在即显式覆盖；configured/writable 事实经凭证域 wire 面
// api.credentials.describe({refs}) 取得（永不含值，与官方 WebSearchCard 同款）。
// 状态徽标语义对齐 gen3d_provider_status：configured → real，否则 mock 回退。
//
// 本面完全自包含：命名空间与字段名本地拼写（client 面不得值导入 host 模块——
// bundle 纯度门；官方惯例见 WebSearchCard 的 WEB_SEARCH_NS）。与 host 半边
// src/settings.ts 的命名空间 / 字段名 / 缺省引用一致性由 host 侧单测钉死
// （src/settings.test.ts），client 侧只做结构镜像。

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client';
import {
  createSnapshotStore,
  type SettingsScope,
  type SettingsScopeSnapshot,
  type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client';

/** 四家供应商（顺序即卡片行序；与 host 半边 ProviderId 同串的结构镜像）。 */
export type Gen3dProviderId = 'meshy' | 'hunyuan3d' | 'tripo3d' | 'rodin';

/** 设置节的结构镜像（只读字符串字段；host 半边 schema 保证 resolved 恒含四引用）。 */
interface Gen3dSection {
  meshyApiKeyEnv?: string;
  hunyuan3dApiKeyEnv?: string;
  tripo3dApiKeyEnv?: string;
  rodinApiKeyEnv?: string;
}

/** 本面注册的命名空间（= host 半边 GEN3D_SETTINGS_NAMESPACE 同串）。 */
export const GEN3D_CARD_KEY = 'gen3d';

/** 四家供应商（顺序即卡片行序）。 */
const PROVIDER_IDS: readonly Gen3dProviderId[] = ['meshy', 'hunyuan3d', 'tripo3d', 'rodin'];

/** 供应商显示名（与 src/tools/generation.ts PROVIDER_NAMES 同口径的浏览器侧副本）。 */
const PROVIDER_DISPLAY: Record<Gen3dProviderId, string> = {
  meshy: 'Meshy',
  hunyuan3d: 'Hunyuan3D（腾讯混元）',
  tripo3d: 'Tripo3D',
  rodin: 'Rodin（Hyper3D）',
};

/** 供应商 → 节内字段名（= host 半边 PROVIDER_SETTING_KEYS 同串）。 */
const SETTING_KEY: Record<Gen3dProviderId, keyof Gen3dSection> = {
  meshy: 'meshyApiKeyEnv',
  hunyuan3d: 'hunyuan3dApiKeyEnv',
  tripo3d: 'tripo3dApiKeyEnv',
  rodin: 'rodinApiKeyEnv',
};

/** 凭证域对一引用报告的只读面（describe 永不含值）。 */
interface CredentialInfo {
  configured: boolean;
  writable: boolean;
}

/** 一行供应商状态。 */
export interface ProviderCardRow {
  providerId: Gen3dProviderId;
  displayName: string;
  /** 生效中的凭证引用（resolved 缺省即 PROVIDER_ENV_KEYS 对应变量名）。 */
  apiKeyEnv: string;
  /** 凭证域对该引用报告的状态。 */
  configured: boolean;
  /** 凭证域是否可写（env 遮蔽该引用时只读）。 */
  writable: boolean;
  /** 对齐 provider-status 语义：configured → real，否则 mock 回退。 */
  mode: 'real' | 'mock';
  /** user 层存在该字段（用户显式覆盖过引用）。 */
  overridden: boolean;
}

/** 卡片整体快照。 */
export interface Gen3dCardState {
  status: 'loading' | 'ready' | 'unavailable';
  /** 设置文档可写性（memory 模式 / 只读 provider 恒 false）。 */
  writable: boolean;
  providers: ProviderCardRow[];
}

/** 注册进槽的面：hooks 是 SnapshotStore（渲染器绑成 useGen3dCard 选择器钩子），
 *  其余成员作为 action 直通组件 props。 */
export interface Gen3dCardFace {
  hooks: { gen3dCard: SnapshotStore<Gen3dCardState> };
  setRef(providerId: Gen3dProviderId, ref: string): Promise<void>;
  clearRef(providerId: Gen3dProviderId): Promise<void>;
}

/**
 * 控制器：设置节快照 + 凭证域 describe → 状态投影；setRef/clearRef 写回
 * user 层（scope.set 以节修订栅栏，写后重读凭证状态）。
 */
export class Gen3dCardController {
  private readonly store: SnapshotStore<Gen3dCardState>;

  constructor(
    private readonly scope: SettingsScope<Gen3dSection>,
    private readonly api: Pick<IApiClient, 'credentials'>,
  ) {
    this.store = createSnapshotStore<Gen3dCardState>({ status: 'loading', writable: false, providers: [] });
    this.scope.subscribe(() => { void this.refresh() });
    void this.refresh();
  }

  /** 节快照 + 已取回的凭证信息 → 卡片状态。 */
  private project(
    snap: SettingsScopeSnapshot<Gen3dSection>,
    credential: Record<string, CredentialInfo>,
  ): Gen3dCardState {
    const section = snap.value;
    const providers: ProviderCardRow[] = PROVIDER_IDS.map((id) => {
      const apiKeyEnv = section === undefined ? '' : (section[SETTING_KEY[id]] ?? '');
      const info = credential[apiKeyEnv];
      const configured = info?.configured ?? false;
      return {
        providerId: id,
        displayName: PROVIDER_DISPLAY[id],
        apiKeyEnv,
        configured,
        writable: info?.writable ?? true,
        mode: configured ? 'real' : 'mock',
        overridden: isFieldOverridden(snap, SETTING_KEY[id]),
      };
    });
    return { status: snap.status, writable: snap.writable, providers };
  }

  /** 重读设置节 + 凭证域并发布新快照（凭证域不可达时保持 last-good，卡片仍可用）。 */
  async refresh(): Promise<void> {
    const snap = this.scope.getSnapshot();
    if (snap.status !== 'ready' || snap.value === undefined) {
      this.store.set(this.project(snap, {}));
      return;
    }
    const refs = PROVIDER_IDS.map((id) => snap.value![SETTING_KEY[id]] ?? '').filter((ref) => ref !== '');
    const unique = [...new Set(refs)];
    const credential: Record<string, CredentialInfo> = {};
    if (unique.length > 0) {
      try {
        const response = await this.api.credentials.describe({ refs: unique });
        if (response.result.ok) {
          for (const ref of unique) {
            const view = response.result.value.credentials[ref];
            // 未知但合法的引用按未配置处理，且视为可写（由 Host 裁决写入）。
            credential[ref] = view === undefined
              ? { configured: false, writable: true }
              : { configured: view.configured, writable: view.writable };
          }
        }
      } catch (_credentialReadFailure) {
        // 凭证 RPC 失败：不发布半截状态，保留 last-good 快照。
        return;
      }
    }
    this.store.set(this.project(snap, credential));
  }

  /** 写一个引用到 user 层（空串视作清除）。 */
  async setRef(providerId: Gen3dProviderId, ref: string): Promise<void> {
    if (ref.trim() === '') return this.clearRef(providerId);
    await this.scope.set(SETTING_KEY[providerId], ref.trim());
    await this.refresh();
  }

  /** 清除引用（回到 schema 缺省 = PROVIDER_ENV_KEYS 对应变量名）。 */
  async clearRef(providerId: Gen3dProviderId): Promise<void> {
    await this.scope.unset(SETTING_KEY[providerId]);
    await this.refresh();
  }

  /** 注册进槽的面。 */
  inject(): Gen3dCardFace {
    return {
      hooks: { gen3dCard: this.store },
      setRef: (id, ref) => this.setRef(id, ref),
      clearRef: (id) => this.clearRef(id),
    };
  }
}

/** user 层字段"存在"即覆盖标记（与设置文档语义一致：值相等仍是覆盖）。 */
function isFieldOverridden(
  snap: SettingsScopeSnapshot<Gen3dSection>,
  field: keyof Gen3dSection,
): boolean {
  const user = snap.user;
  return typeof user === 'object' && user !== null && Object.prototype.hasOwnProperty.call(user, field);
}
