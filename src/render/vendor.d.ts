// 无内置类型的依赖模块声明 —— 仅覆盖本插件用到的 API 面。
// - pngjs（CJS，无 types 字段）：PNG 同步编码。
// - gifenc（无 types 字段；Node ESM 只能 default 导入 CJS main）：量化 + 调色板 + 多帧写入。
// - draco3dgltf（CJS）：Draco 解码器模块工厂（KHR_draco_mesh_compression
//   解码依赖，NodeIO.registerDependencies 注入）。

declare module 'pngjs' {
  export interface PngOptions {
    width: number;
    height: number;
    inputColorType?: number;
  }
  export class PNG {
    constructor(options: PngOptions);
    width: number;
    height: number;
    data: Buffer;
    static sync: {
      write(png: PNG, options?: { deflateLevel?: number }): Buffer;
      read(buffer: Buffer, options?: { skipRescale?: boolean }): PNG;
    };
  }
}

declare module 'gifenc' {
  export type GifPalette = number[][];
  export interface GifWriteOptions {
    palette?: GifPalette;
    first?: boolean;
    transparent?: boolean;
    delay?: number;
    repeat?: number;
  }
  export interface GifEncoderStream {
    writeFrame(index: Uint8Array, width: number, height: number, options?: GifWriteOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GifEncoderStream;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: boolean | number },
  ): GifPalette;
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: GifPalette,
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;
}

declare module 'draco3dgltf' {
  export interface DracoModule {
    decode?: unknown;
  }
  const draco3d: {
    createDecoderModule(options?: { wasmBinary?: Uint8Array; wasmBinaryPath?: string }): Promise<DracoModule>;
    createEncoderModule(options?: object): Promise<unknown>;
  };
  export default draco3d;
}
