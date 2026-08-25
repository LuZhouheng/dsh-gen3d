// 视角数据层单测：清单归一 / 分组 / URL 构造 / 字节与面数格式化。纯 TS 数据面。

import { describe, expect, it } from 'vitest';

import {
  formatBytes,
  groupSlots,
  normalizeAssetsResponse,
  pluginsFileUrl,
  previewKindOf,
  viewerAssetName,
} from './viewer-models.js';

describe('normalizeAssetsResponse', () => {
  it('接受裸数组（assetPath 字段）', () => {
    const result = normalizeAssetsResponse([
      { assetPath: 'assets/3d/characters/hero.glb', size: 1024 },
    ]);
    expect(result).toEqual({
      ok: true,
      assets: [
        {
          assetPath: 'assets/3d/characters/hero.glb',
          slot: 'characters',
          name: 'hero',
          size: 1024,
          sidecar: undefined,
          fields: { assetPath: 'assets/3d/characters/hero.glb', size: 1024 },
        },
      ],
    });
  });

  it('接受 { assets } / { data } / { items } 包装', () => {
    for (const wrapper of ['assets', 'data', 'items'] as const) {
      const result = normalizeAssetsResponse({ [wrapper]: [{ path: 'assets/3d/meshes/cube.glb' }] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.assets[0]!.assetPath).toBe('assets/3d/meshes/cube.glb');
        // path 变体：槽位从路径推断
        expect(result.assets[0]!.slot).toBe('meshes');
      }
    }
  });

  it('条目缺路径串 / 非对象时跳过', () => {
    const result = normalizeAssetsResponse([
      { size: 1 },
      'not-an-object',
      null,
      { file: 'assets/3d/characters/foo.fbx' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assets).toHaveLength(1);
  });

  it('结构完全不认识返回错误', () => {
    const result = normalizeAssetsResponse({ hello: 'world' });
    expect(result.ok).toBe(false);
  });

  it('排序：characters 组在前，组内按名字', () => {
    const result = normalizeAssetsResponse([
      { assetPath: 'assets/3d/meshes/zbox.glb', slot: 'meshes' },
      { assetPath: 'assets/3d/characters/boy.glb', slot: 'characters' },
      { assetPath: 'assets/3d/characters/alpha.glb', slot: 'characters' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assets.map((a) => a.name)).toEqual(['alpha', 'boy', 'zbox']);
    }
  });
});

describe('groupSlots', () => {
  it('按 characters/meshes 顺序分组，未知槽位最后', () => {
    const result = normalizeAssetsResponse([
      { assetPath: 'assets/3d/meshes/m.glb' },
      { assetPath: 'assets/3d/characters/c.glb' },
      { assetPath: 'assets/3d/other/o.glb' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(groupSlots(result.assets).map((g) => g.slot)).toEqual(['characters', 'meshes', 'assets']);
    }
  });
});

describe('pluginsFileUrl', () => {
  it('路径分段 encode，保留 / 分隔', () => {
    expect(pluginsFileUrl('assets/3d/characters/hero 角色.glb'))
      .toBe('/plugins/dsh-gen3d/files/assets/3d/characters/hero%20%E8%A7%92%E8%89%B2.glb');
  });
});

describe('previewKindOf', () => {
  it('GLB/glTF → model；大小写不敏感', () => {
    expect(previewKindOf('assets/3d/characters/hero.glb')).toBe('model');
    expect(previewKindOf('a/b/c.GLB')).toBe('model');
    expect(previewKindOf('a/b/scene.gltf')).toBe('model');
  });
  it('常见图片 → image', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'PNG']) {
      expect(previewKindOf(`assets/3d/characters/hero-thumb.${ext}`)).toBe('image');
    }
  });
  it('fbx / 无扩展名 / 未知 → other（走模型视口的错误态）', () => {
    expect(previewKindOf('assets/3d/characters/hero.rigged_model.fbx')).toBe('other');
    expect(previewKindOf('noext')).toBe('other');
  });
});

describe('viewerAssetName / formatBytes', () => {
  it('显示名去 .glb 后缀', () => {
    expect(viewerAssetName('assets/3d/characters/hero.GLB')).toBe('hero');
  });
  it('字节人性化', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MiB');
  });
});
