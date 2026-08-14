// 工具层测试共享辅助 —— FakeProvider（可注入的 Gen3dProvider 假实现）、
// 临时目录 store、mock fetch、最小 GLB 构造。仅测试用，不参与构建产物语义。

import { Document, NodeIO } from '@gltf-transform/core';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  AnimationRequest,
  FetchLike,
  GenerationRequest,
  Gen3dProvider,
  MotionItem,
  MotionQuery,
  ProviderId,
  RigRequest,
  SubmitOptions,
  TaskHandle,
  TaskResult,
} from '../providers/types.js';
import { Gen3dStore } from '../storage.js';

// ── 临时目录 store ───────────────────────────────────────────────────────────

export interface TempStore {
  store: Gen3dStore;
  root: string;
  cleanup: () => void;
}

export function makeStore(): TempStore {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gen3d-tools-test-'));
  return { store: new Gen3dStore({ workspaceRoot: root }), root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 写入工作区文件（绝对路径；自动建目录）。 */
export function writeWorkspaceFile(root: string, rel: string, data: Uint8Array | string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data, { flag: 'w' });
}

// ── FakeProvider ─────────────────────────────────────────────────────────────

export type PollHandler = (handle: TaskHandle) => Promise<TaskResult>;

export interface FakeProviderHandlers {
  submitGeneration?: (req: GenerationRequest) => Promise<TaskHandle>;
  pollTask?: PollHandler;
  submitRig?: (req: RigRequest) => Promise<TaskHandle>;
  submitAnimation?: (req: AnimationRequest) => Promise<TaskHandle>;
  listMotions?: (query?: MotionQuery) => Promise<MotionItem[]>;
  getBalance?: () => Promise<{ balance: number }>;
  uploadImage?: (data: Uint8Array, filename?: string) => Promise<string>;
}

export interface FakeCall {
  method: string;
  args: unknown[];
}

/** 可配置的 Gen3dProvider 假实现：记录调用、按 handler 返回结果。 */
export class FakeProvider implements Gen3dProvider {
  readonly id: ProviderId;
  configured: boolean;
  readonly calls: FakeCall[] = [];
  handlers: FakeProviderHandlers = {};

  constructor(id: ProviderId, configured = true) {
    this.id = id;
    this.configured = configured;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async submitGeneration(req: GenerationRequest, opts?: SubmitOptions): Promise<TaskHandle> {
    this.calls.push({ method: 'submitGeneration', args: [req, opts] });
    if (!this.handlers.submitGeneration) throw new Error(`FakeProvider(${this.id}).submitGeneration 未 stub`);
    return this.handlers.submitGeneration(req);
  }

  async pollTask(handle: TaskHandle, opts?: SubmitOptions): Promise<TaskResult> {
    this.calls.push({ method: 'pollTask', args: [handle, opts] });
    if (!this.handlers.pollTask) throw new Error(`FakeProvider(${this.id}).pollTask 未 stub`);
    return this.handlers.pollTask(handle);
  }

  async submitRig(req: RigRequest, opts?: SubmitOptions): Promise<TaskHandle> {
    this.calls.push({ method: 'submitRig', args: [req, opts] });
    if (!this.handlers.submitRig) throw new Error(`FakeProvider(${this.id}).submitRig 未 stub`);
    return this.handlers.submitRig(req);
  }

  async submitAnimation(req: AnimationRequest, opts?: SubmitOptions): Promise<TaskHandle> {
    this.calls.push({ method: 'submitAnimation', args: [req, opts] });
    if (!this.handlers.submitAnimation) throw new Error(`FakeProvider(${this.id}).submitAnimation 未 stub`);
    return this.handlers.submitAnimation(req);
  }

  async listMotions(query?: MotionQuery): Promise<MotionItem[]> {
    this.calls.push({ method: 'listMotions', args: [query] });
    if (!this.handlers.listMotions) throw new Error(`FakeProvider(${this.id}).listMotions 未 stub`);
    return this.handlers.listMotions(query);
  }

  async getBalance(): Promise<{ balance: number }> {
    this.calls.push({ method: 'getBalance', args: [] });
    if (!this.handlers.getBalance) throw new Error(`FakeProvider(${this.id}).getBalance 未 stub`);
    return this.handlers.getBalance();
  }

  async uploadImage(data: Uint8Array, filename?: string): Promise<string> {
    this.calls.push({ method: 'uploadImage', args: [data, filename] });
    if (!this.handlers.uploadImage) throw new Error(`FakeProvider(${this.id}).uploadImage 未 stub`);
    return this.handlers.uploadImage(data, filename);
  }
}

// ── 结果构造辅助 ─────────────────────────────────────────────────────────────

/** 确定性 mock GLB 字节（GLB magic + seed）。 */
export function glbBytes(seed: string): Uint8Array {
  const header = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);
  const tail = new TextEncoder().encode(`mock-glb:${seed}`);
  const out = new Uint8Array(header.length + tail.length);
  out.set(header, 0);
  out.set(tail, header.length);
  return out;
}

/** 契约形状的 succeeded 结果（downloads URL；providerResultFromTask 会经 fetchImpl 下载）。 */
export function succeededResult(taskId: string, downloads: NonNullable<TaskResult['downloads']>): TaskResult {
  return { status: 'succeeded', downloads, raw: { taskId } };
}

/** Meshy 形状的 succeeded 结果（files 自带字节，工具层直接使用）。 */
export function meshyResult(
  taskId: string,
  files: { role: string; format: string; url: string; buffer: Uint8Array }[],
  extra: { basicAnimations?: { category: 'walking' | 'running'; files: { role: string; format: string; url: string; buffer: Uint8Array }[] }[]; expiresAtMs?: number } = {},
): TaskResult {
  const downloads: NonNullable<TaskResult['downloads']> = {};
  const glb = files.find((f) => f.role === 'glb');
  if (glb) downloads.glb = glb.url;
  const fbx = files.find((f) => f.role === 'fbx');
  if (fbx) downloads.fbx = fbx.url;
  const thumb = files.find((f) => f.role === 'thumbnail');
  if (thumb) downloads.previewImage = thumb.url;
  return {
    status: 'succeeded',
    downloads,
    ...extra,
    // 携带 meshy 专属字段（工具层经 as MeshyTaskResult 读取）
    provider: 'meshy',
    taskId,
    kind: 'text-to-3d-preview',
    files,
    modelUrls: Object.fromEntries(files.map((f) => [f.role, f.url])),
  } as TaskResult & Record<string, unknown>;
}

// ── mock fetch（providerResultFromTask 下载用） ──────────────────────────────

export function mockFetch(urls: Record<string, Uint8Array>): FetchLike {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const bytes = urls[url];
    if (!bytes) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    } as Response;
  };
}

// ── 最小 GLB 构造（真实合并 / 采纳候选用） ────────────────────────────────────

/** 最小 rigged base GLB（mesh + skin + Hips 关节 + 一个 bind 动画）。 */
export async function buildRiggedBase(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const jointsAcc = doc.createAccessor().setType('VEC4').setArray(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).setBuffer(buffer);
  const weights = doc.createAccessor().setType('VEC4').setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])).setBuffer(buffer);
  const ibm = doc.createAccessor().setType('MAT4').setArray(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setAttribute('JOINTS_0', jointsAcc).setAttribute('WEIGHTS_0', weights);
  const mesh = doc.createMesh('body').addPrimitive(prim);
  const hips = doc.createNode('Hips');
  const skin = doc.createSkin('skin').addJoint(hips).setInverseBindMatrices(ibm);
  const skinned = doc.createNode('skinned').setMesh(mesh).setSkin(skin);
  scene.addChild(hips);
  scene.addChild(skinned);
  const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0, 1])).setBuffer(buffer);
  const output = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 0, 0, 0])).setBuffer(buffer);
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
  const channel = doc.createAnimationChannel().setTargetNode(hips).setTargetPath('translation').setSampler(sampler);
  doc.createAnimation('bind').addSampler(sampler).addChannel(channel);
  return new NodeIO().writeBinary(doc);
}

/** 单 clip 动作 GLB（一个 Hips 平移动画）。 */
export async function buildMotionGlb(name = 'clip'): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  const hips = doc.createNode('Hips');
  scene.addChild(hips);
  const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0, 1])).setBuffer(buffer);
  const output = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0])).setBuffer(buffer);
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
  const channel = doc.createAnimationChannel().setTargetNode(hips).setTargetPath('translation').setSampler(sampler);
  doc.createAnimation(name).addSampler(sampler).addChannel(channel);
  return new NodeIO().writeBinary(doc);
}

/** 多 clip 孤儿 merged GLB（采纳候选：只读动画名）。 */
export async function buildOrphanMerged(clipNames: string[]): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  const hips = doc.createNode('Hips');
  scene.addChild(hips);
  for (const [i, name] of clipNames.entries()) {
    const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0, 1])).setBuffer(buffer);
    const output = doc.createAccessor().setType('VEC3').setArray(new Float32Array([i, 0, 0, i + 1, 0, 0])).setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
    const channel = doc.createAnimationChannel().setTargetNode(hips).setTargetPath('translation').setSampler(sampler);
    doc.createAnimation(name).addSampler(sampler).addChannel(channel);
  }
  return new NodeIO().writeBinary(doc);
}
