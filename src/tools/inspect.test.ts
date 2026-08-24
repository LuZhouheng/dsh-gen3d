// gen3d_inspect_asset 单测 —— 零网络零配额体检：
// 1. mock 角色 GLB：统计口径正确（顶点/三角形/材质/贴图/动画/骨架），
//    hero-character 预算通过；
// 2. 超预算用例：高面数资产（> 30000 tris）与多材质资产（> 2 材质）→ violations 逐条；
//    低预算档 prop（≤5000）对 mock 中高面数模型违规；
// 3. 占位字节 GLB → asset_unreadable；缺失资产 → asset_not_found；
// 4. 预算档 string 非法 → invalid_args；render 摘要可读（text-only 模型自足）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';

import { buildMockCharacterGlb, MOCK_CHARACTER_FACES } from '../legacy/shared/mock-mesh.js';
import { configureToolDeps } from './common.js';
import { gen3dInspectAsset, INSPECT_BUDGETS, inspectDocument } from './inspect.js';
import { glbBytes, makeStore, writeWorkspaceFile } from './test-helpers.js';

const EXEC = { signal: new AbortController().signal };

let tmp: ReturnType<typeof makeStore>;

beforeEach(() => {
  tmp = makeStore();
  configureToolDeps({ store: tmp.store });
});

afterEach(() => {
  configureToolDeps({});
  tmp.cleanup();
});

/** 高面数资产：N×M 网格平面（2*N*M 三角形）。 */
async function buildGridGlb(rows: number, cols: number): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  const positions: number[] = [];
  const normals: number[] = [];
  for (let r = 0; r <= rows; r += 1) {
    for (let c = 0; c <= cols; c += 1) {
      positions.push(c, 0, r);
      normals.push(0, 1, 0);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const a = r * (cols + 1) + c;
      const b = a + 1;
      const d = (r + 1) * (cols + 1) + c;
      const e = d + 1;
      indices.push(a, b, d, b, e, d);
    }
  }
  const pos = doc.createAccessor().setType('VEC3').setArray(Float32Array.from(positions)).setBuffer(buffer);
  const nrm = doc.createAccessor().setType('VEC3').setArray(Float32Array.from(normals)).setBuffer(buffer);
  const idx = doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(indices)).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('NORMAL', nrm).setIndices(idx);
  scene.addChild(doc.createNode('grid').setMesh(doc.createMesh('grid').addPrimitive(prim)));
  return new NodeIO().writeBinary(doc);
}

/** 多材质资产：四个 quad 各挂一个材质。 */
async function buildMultiMaterialGlb(materials: number): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  for (let i = 0; i < materials; i += 1) {
    const pos = doc.createAccessor().setType('VEC3').setArray(
      new Float32Array([i, 0, 0, i + 0.8, 0, 0, i, 0, 0.8]),
    ).setBuffer(buffer);
    const nrm = doc.createAccessor().setType('VEC3').setArray(
      new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    ).setBuffer(buffer);
    const material = doc.createMaterial('m').setBaseColorFactor([1, i / materials, 0, 1]);
    const prim = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('NORMAL', nrm).setMaterial(material);
    scene.addChild(doc.createNode('tri').setMesh(doc.createMesh('mesh').addPrimitive(prim)));
  }
  return new NodeIO().writeBinary(doc);
}

async function saveAsset(fileName: string, data: Uint8Array): Promise<string> {
  const saved = await tmp.store.saveAsset({
    slot: 'characters',
    fileName,
    data,
    sidecar: {
      custom: {
        provider: 'meshy',
        providerMode: 'mock',
        mode: 'text',
        sourceJobId: 'job-1',
        prompt: 'test',
        sourceInputAssetPaths: [],
        readiness: { hasSourceMesh: true, rigged: false, animated: false },
      },
    },
  });
  return saved.assetPath;
}

describe('gen3d_inspect_asset', () => {
  it('mock 角色：统计口径正确 + hero-character 预算通过', async () => {
    const assetPath = await saveAsset('hero.glb', buildMockCharacterGlb('inspect-seed'));
    const out = (await gen3dInspectAsset.execute({ asset: 'hero', budget: 'hero-character' }, EXEC)) as {
      ok: boolean;
      assetPath: string;
      budget: string;
      stats: { vertices: number; triangles: number; materialCount: number; textures: unknown[]; animations: unknown[]; hasSkeleton: boolean; skinnedMeshCount: number };
      violations: string[];
      passed: boolean;
    };
    expect(out.ok).toBe(true);
    expect(out.assetPath).toBe(assetPath);
    expect(out.stats.triangles).toBe(MOCK_CHARACTER_FACES);
    expect(out.stats.triangles).toBeGreaterThanOrEqual(1000);
    expect(out.stats.triangles).toBeLessThanOrEqual(3000);
    expect(out.stats.vertices).toBeGreaterThan(0);
    expect(out.stats.materialCount).toBe(1);
    expect(out.stats.textures).toHaveLength(0);
    expect(out.stats.animations).toHaveLength(0);
    expect(out.stats.hasSkeleton).toBe(false);
    expect(out.stats.skinnedMeshCount).toBe(0);
    expect(out.violations).toEqual([]);
    expect(out.passed).toBe(true);
  });

  it('presentationMeta 递统计与违规（web keyed 卡片摄取面）', async () => {
    const assetPath = await saveAsset('hero.glb', buildMockCharacterGlb('inspect-seed'));
    const out = (await gen3dInspectAsset.execute({ asset: 'hero', budget: 'hero-character' }, EXEC)) as Record<string, unknown>;
    const meta = gen3dInspectAsset.output.presentationMeta?.({ asset: 'hero' }, out);
    expect(meta).toMatchObject({ assetPath, budget: 'hero-character', passed: true, violations: [] });
    const stats = (meta as { stats: { triangles: number; vertices: number } }).stats;
    expect(stats.triangles).toBe(MOCK_CHARACTER_FACES);
    expect(stats.vertices).toBeGreaterThan(0);
  });

  it('超预算构造：>30000 tris 对 hero-character 违规（数值断言），对 environment 通过（≤50000）', async () => {
    // 125×125 → 31250 tris > 30000
    const assetPath = await saveAsset('big.glb', await buildGridGlb(125, 125));
    const hero = (await gen3dInspectAsset.execute({ asset: 'big', budget: 'hero-character' }, EXEC)) as {
      ok: boolean;
      stats: { triangles: number };
      violations: string[];
      passed: boolean;
    };
    expect(hero.stats.triangles).toBeGreaterThan(INSPECT_BUDGETS['hero-character'].maxTris);
    expect(hero.passed).toBe(false);
    expect(hero.violations.some((v) => v.includes('30000'))).toBe(true);

    const env = (await gen3dInspectAsset.execute({ asset: assetPath, budget: 'environment' }, EXEC)) as {
      stats: { triangles: number };
      violations: string[];
      passed: boolean;
    };
    expect(env.stats.triangles).toBeLessThanOrEqual(INSPECT_BUDGETS.environment.maxTris);
    expect(env.passed).toBe(true);
  });

  it('多材质（4 个）对 hero-character 违规材质数；prop 档同理违规', async () => {
    const assetPath = await saveAsset('multi.glb', await buildMultiMaterialGlb(4));
    const hero = (await gen3dInspectAsset.execute({ asset: assetPath, budget: 'hero-character' }, EXEC)) as {
      stats: { materialCount: number };
      violations: string[];
      passed: boolean;
    };
    expect(hero.stats.materialCount).toBe(4);
    expect(hero.passed).toBe(false);
    expect(hero.violations.some((v) => v.includes('材质数 4'))).toBe(true);
  });

  it('占位字节 GLB → asset_unreadable；缺失资产 → asset_not_found；非法 budget → invalid_args', async () => {
    writeWorkspaceFile(tmp.root, 'assets/3d/characters/legacy.glb', glbBytes('old'));
    const unreadable = (await gen3dInspectAsset.execute(
      { asset: 'assets/3d/characters/legacy.glb' },
      EXEC,
    )) as { ok: boolean; code?: string };
    expect(unreadable.ok).toBe(false);
    expect(unreadable.code).toBe('asset_unreadable');

    const missing = (await gen3dInspectAsset.execute({ asset: 'nope' }, EXEC)) as { ok: boolean; code?: string };
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('asset_not_found');

    const badBudget = (await gen3dInspectAsset.execute(
      { asset: 'assets/3d/characters/legacy.glb', budget: 'boss' },
      EXEC,
    )) as { ok: boolean; code?: string };
    expect(badBudget.ok).toBe(false);
    expect(badBudget.code).toBe('invalid_args');
  });

  it('render 摘要自足：含统计数字与违规条目（text-only 模型可读）', async () => {
    const assetPath = await saveAsset('big.glb', await buildGridGlb(125, 125));
    const value = (await gen3dInspectAsset.execute({ asset: assetPath, budget: 'prop' }, EXEC)) as Record<string, unknown>;
    const [block] = gen3dInspectAsset.output.render({ asset: assetPath, budget: 'prop' }, value) as {
      type: string;
      text: string;
    }[];
    expect(block.type).toBe('text');
    expect(block.text).toContain('big.glb');
    expect(block.text).toContain('31250'); // 三角形数
    expect(block.text).toContain('预算判定：不通过');
    expect(block.text).toContain('超出「道具/小物件」预算上限 5000');
  });

  it('inspectDocument 对 rigged base（有骨架）识别 hasSkeleton/skinnedMeshCount', async () => {
    const { buildRiggedBase } = await import('./test-helpers.js');
    const assetPath = await saveAsset('rigged.glb', await buildRiggedBase());
    const out = (await gen3dInspectAsset.execute({ asset: 'rigged' }, EXEC)) as {
      ok: boolean;
      stats: { hasSkeleton: boolean; skinnedMeshCount: number; triangles: number };
    };
    expect(out.stats.hasSkeleton).toBe(true);
    expect(out.stats.skinnedMeshCount).toBeGreaterThanOrEqual(1);
    expect(out.stats.triangles).toBe(1);
  });
});
