// GLB 读取辅助 —— NodeIO 读字节为 Document，带 Draco 解码支持。
//
// draco3dgltf 的 createDecoderModule 是异步 wasm 实例化（一次 ~50ms，
// 进程内缓存），且只有 KHR_draco_mesh_compression 资产才需要；普通资产
// 走无扩展 NodeIO 快速路径。读失败抛 ToolError 语义由调用方包装。

import { NodeIO, type Document } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

/** GLB 字节里是否要求 Draco 扩展（粗查 JSON chunk 文本）。 */
function usesDraco(bytes: Uint8Array): boolean {
  // GLB 头 12 字节后是 JSON chunk：len(4) + type(4) + 数据；len 仅为 chunk 长度
  if (bytes.byteLength < 20) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = Math.min(view.getUint32(12, true), bytes.byteLength - 20);
  let text = '';
  // 只扫描 JSON chunk（draco 声明在 extensionsUsed / extensionsRequired）
  const enc = new TextDecoder('utf-8', { fatal: false });
  text = enc.decode(bytes.subarray(20, 20 + jsonLen));
  return text.includes('KHR_draco_mesh_compression');
}

let decoderPromise: ReturnType<typeof draco3d.createDecoderModule> | null = null;

/** 惰性创建并缓存 Draco 解码器模块（进程内单例）。 */
async function dracoDecoder(): Promise<unknown> {
  decoderPromise ??= draco3d.createDecoderModule();
  return decoderPromise;
}

/** GLB 字节 → Document（Draco 资产自动注册解码器；普通资产无额外开销）。 */
export async function readGlb(bytes: Uint8Array): Promise<Document> {
  const io = new NodeIO();
  if (usesDraco(bytes)) {
    io.registerExtensions([KHRDracoMeshCompression]);
    io.registerDependencies({
      'draco3d.decoder': await dracoDecoder(),
    });
  }
  return io.readBinary(bytes);
}
