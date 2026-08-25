// 3D 资产 WebGL 视口 —— 纯 three.js 命令式场景（React 只做挂载容器与状态回调）。
//
// 职责：/plugins/dsh-gen3d/files/<path> 拉 GLB → GLTFLoader 解析 → 场景搭建
// （深色背景 + 网格地面 + IBL 环境光照 + 方向光阴影 + ACES 色调映射）→ 自动 fit
// 相机（OrbitControls 轨道/缩放）→ 面数/动画统计上报；GLB 带动画 clips 时建立
// AnimationMixer 自动播放第一条，左下角控制条支持 播放/暂停/切 clip。
// GLB 不可解析（如 mock 占位字节）时显示错误态，可点「重新加载」。组件卸载时释放
// renderer / 几何 / 材质 / controls / mixer / 环境贴图。
//
// 要点：
// - 场景建立只跑一次（挂载 effect），资产切换只换模型节点，不重建场景；
// - 加载是异步竞态：资产切换后旧响应作废（generation 令牌守卫）；
// - 阴影贴图打开（2048²）；模型遍历统一 castShadow/receiveShadow；
// - 渲染观感（2026-08-25 用户实证「渲染效果不足」）：RoomEnvironment PMREM 提供
//   IBL——metallic=1 的 PBR 材质（Meshy 烘焙导出常态）不再死黑，有反射层次。

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { pluginsFileUrl } from './viewer-models.js';

export interface AssetViewportStats {
  /** 主网格三角形数（加载成功后才上报；对象无网格语义时为 0）。 */
  triangles: number;
  /** 场景中可见网格节点数。 */
  meshes: number;
  /** GLB 动画 clip 数（无动画为 0）。 */
  clips: number;
}

export interface AssetViewportProps {
  /** 当前要预览的工作区相对路径（null = 无选择，视口保持空场景）。 */
  assetPath: string | null;
  /** 资产名（加载失败提示用）。 */
  assetName: string;
  onStats?(stats: AssetViewportStats): void;
}

const SCENE_BG = 0x14171c;

function disposeScene(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry !== undefined) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) {
      for (const m of material) m.dispose();
    } else if (material !== undefined) {
      material.dispose();
    }
  });
}

/** 统计模型面数：优先索引条数 / 3，否则顶点数 / 3（三角化假设）。 */
function countTriangles(root: THREE.Object3D): { triangles: number; meshes: number } {
  let triangles = 0;
  let meshes = 0;
  root.traverse((object) => {
    const geometry = (object as THREE.Mesh).geometry;
    if (geometry === undefined) return;
    meshes += 1;
    const index = geometry.getIndex();
    if (index !== null) {
      triangles += index.count / 3;
    } else {
      const position = geometry.getAttribute('position');
      if (position !== undefined) triangles += position.count / 3;
    }
  });
  return { triangles: Math.round(triangles), meshes };
}

export function AssetViewport({ assetPath, assetName, onStats }: AssetViewportProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    assetPath === null ? 'idle' : 'loading',
  );
  const [errorText, setErrorText] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // 加载代际：切资产 / 重试时 +1，旧回调凭代际作废（防迟到旧响应覆盖新模型）。
  const generationRef = useRef(0);

  // 动画：clips 由加载成功回调装配；actions 放 ref（React 状态只驱动 播放/暂停/切换）。
  const [clips, setClips] = useState<readonly { name: string; duration: number }[]>([]);
  const [activeClip, setActiveClip] = useState(0);
  const [playing, setPlaying] = useState(true);
  const animRef = useRef<{ mixer: THREE.AnimationMixer | null; actions: THREE.AnimationAction[] }>({
    mixer: null,
    actions: [],
  });

  // 场景本体（跨渲染常驻；卸载时整体销毁）。
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    modelHost: THREE.Group;
    light: THREE.DirectionalLight;
    clock: THREE.Clock;
  } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 现代视窗观感：sRGB 输出 + ACES 色调映射（r152+ 前者本为默认，显式声明）
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(SCENE_BG);
    // IBL 环境光：RoomEnvironment → PMREM。metallic=1 的 PBR 材质（Meshy 烘焙导出
    // 常态）有反射底色不再死黑；半球光相应降档（环境光已由 IBL 承担大半）。
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = environment;

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    camera.position.set(2.4, 2, 2.8);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxDistance = 400;
    controls.minDistance = 0.01;

    // 网格地面（比模型大一圈，纯装饰，不接收阴影——阴影落在地面接收片上）。
    const grid = new THREE.GridHelper(20, 20, 0x4a5568, 0x2a3038);
    grid.position.y = -0.001;
    scene.add(grid);

    // 阴影接收片：半透明平面，只吃阴影不挡视线。
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ opacity: 0.22 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.002;
    ground.receiveShadow = true;
    scene.add(ground);

    const hemisphere = new THREE.HemisphereLight(0xf2f5f9, 0x3b3f47, 0.55);
    scene.add(hemisphere);

    const light = new THREE.DirectionalLight(0xffffff, 2.4);
    light.position.set(4, 7, 3);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.bias = -0.0004;
    scene.add(light);
    scene.add(light.target);

    // 模型统一挂在 modelHost 下：切资产 = 换 modelHost 的子节点。
    const modelHost = new THREE.Group();
    scene.add(modelHost);

    // 动画时钟：渲染循环取 delta 驱动 mixer（无动画时 mixer 为 null，开销为零）。
    const clock = new THREE.Clock();

    const updateSize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    updateSize();
    const resizeObserver = new ResizeObserver(() => { updateSize() });
    resizeObserver.observe(host);

    const renderLoop = () => {
      const delta = clock.getDelta();
      animRef.current.mixer?.update(delta);
      controls.update();
      renderer.render(scene, camera);
    };
    renderer.setAnimationLoop(renderLoop);

    sceneRef.current = { renderer, scene, camera, controls, modelHost, light, clock };

    return () => {
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      animRef.current.mixer?.stopAllAction();
      disposeScene(modelHost);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      environment.dispose();
      pmrem.dispose();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, []);

  // 资产加载：assetPath / reloadToken 变化即重载；竞态用代际令牌守卫。
  useEffect(() => {
    const ctx = sceneRef.current;
    if (ctx === null) return;
    const generation = ++generationRef.current;
    ctx.modelHost.clear();
    setLoadState(assetPath === null ? 'idle' : 'loading');
    setErrorText(null);
    setClips([]);
    setActiveClip(0);
    if (assetPath === null) return;

    const url = pluginsFileUrl(assetPath);
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        if (generationRef.current !== generation) return;
        const model = gltf.scene;
        ctx.modelHost.add(model);
        // 模型整体阴影开关（isMesh 覆盖 Mesh/SkinnedMesh/InstancedMesh）。
        model.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.isMesh !== true) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        });
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 1);
        // 相机沿 (1, 0.55, 1) 方向、距离 2.4 × 最大边长；fov 45°，略留前后。
        const dir = new THREE.Vector3(1, 0.55, 1).normalize();
        const distance = maxDim * 2.4;
        ctx.camera.position.copy(center).addScaledVector(dir, distance);
        ctx.camera.near = Math.max(distance / 1000, 0.001);
        ctx.camera.far = distance * 100;
        ctx.camera.updateProjectionMatrix();
        ctx.controls.target.copy(center);
        ctx.controls.maxDistance = distance * 10;
        ctx.controls.update();
        // 灯光跟到模型：位置/影窗按模型包络取，保证阴影覆盖。
        ctx.light.position.copy(center).add(new THREE.Vector3(maxDim * 1.6, maxDim * 2.6, maxDim * 1.2));
        ctx.light.target.position.copy(center);
        const shadowHalf = maxDim * 2.4;
        ctx.light.shadow.camera.left = -shadowHalf;
        ctx.light.shadow.camera.right = shadowHalf;
        ctx.light.shadow.camera.top = shadowHalf;
        ctx.light.shadow.camera.bottom = -shadowHalf;
        ctx.light.shadow.camera.near = 0.1;
        ctx.light.shadow.camera.far = maxDim * 12;
        ctx.light.shadow.camera.updateProjectionMatrix();
        // 动画：GLB 带 clips 时建立 mixer 并自动播放第一条（蒙皮资产 three 原生支持；
        // 用户交互由 [activeClip, playing, clips] effect 接管）。
        const animations = gltf.animations ?? [];
        if (animations.length > 0) {
          const mixer = new THREE.AnimationMixer(model);
          const actions = animations.map((clip) => mixer.clipAction(clip));
          animRef.current = { mixer, actions };
          actions[0]!.reset().play();
          setClips(animations.map((clip, index) => ({
            name: clip.name !== '' ? clip.name : `clip-${index + 1}`,
            duration: clip.duration,
          })));
          setActiveClip(0);
          setPlaying(true);
        } else {
          animRef.current = { mixer: null, actions: [] };
        }
        setLoadState('ready');
        const stats = countTriangles(model);
        onStats?.({ triangles: stats.triangles, meshes: stats.meshes, clips: animations.length });
      },
      undefined,
      (error) => {
        if (generationRef.current !== generation) return;
        const reason = error instanceof Error ? error.message : String(error);
        setErrorText(reason);
        setLoadState('error');
      },
    );
    return () => {
      // 依赖变化：清理旧模型（下一次 effect 会重建加载状态）。
      if (sceneRef.current === ctx) {
        animRef.current.mixer?.stopAllAction();
        animRef.current = { mixer: null, actions: [] };
        disposeScene(ctx.modelHost);
        ctx.modelHost.clear();
      }
    };
  }, [assetPath, reloadToken, onStats]);

  // 动画控制：切 clip / 播放暂停。actions 由加载成功回调装配；clips 入依赖使装配后
  // 即便 activeClip/playing 未变也会同步一次（覆盖「上个资产也停在第 0 条」的情形）。
  useEffect(() => {
    animRef.current.actions.forEach((action, index) => {
      if (index !== activeClip) {
        action.stop();
        return;
      }
      if (!action.isRunning()) action.reset().play();
      action.paused = !playing;
    });
  }, [activeClip, playing, clips]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {loadState === 'idle' && (
        <div style={overlayStyle}>选择左侧资产开始预览</div>
      )}
      {loadState === 'loading' && (
        <div style={overlayStyle}>正在加载 {assetName} …</div>
      )}
      {loadState === 'error' && (
        <div style={{ ...overlayStyle, cursor: 'pointer' }} onClick={() => setReloadToken((n) => n + 1)}>
          <div style={{ fontWeight: 600 }}>{assetName} 无法解析</div>
          <div style={{ marginTop: 6, maxWidth: 420, wordBreak: 'break-all' }}>
            该文件不是可解析的 glTF（可能是 mock 占位字节或仍在上传）；点击重试。
          </div>
          {errorText !== null && (
            <div style={{ marginTop: 6, maxWidth: 420, wordBreak: 'break-all', color: '#8a93a0', fontSize: 12 }}>
              {errorText}
            </div>
          )}
        </div>
      )}
      {clips.length > 0 && (
        <div style={animBarStyle}>
          <button type="button" style={animButtonStyle} onClick={() => setPlaying((p) => !p)}>
            {playing ? '⏸ 暂停' : '▶ 播放'}
          </button>
          <select
            value={activeClip}
            onChange={(event) => { setActiveClip(Number(event.target.value)); setPlaying(true); }}
            style={animSelectStyle}
            aria-label="动画片段"
          >
            {clips.map((clip, index) => (
              <option key={`${clip.name}-${index}`} value={index}>
                {clip.name}（{clip.duration.toFixed(1)}s）
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#8a93a0',
  fontSize: 13,
  textAlign: 'center',
  pointerEvents: 'none',
};

const animBarStyle: CSSProperties = {
  position: 'absolute',
  left: 12,
  top: 12, // 顶左：底部会被会话视图悬浮输入框遮住（2026-08-25 用户实证控制条不可见）
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  padding: '6px 8px',
  background: 'rgba(20, 23, 28, 0.85)',
  border: '1px solid #2a3038',
  borderRadius: 8,
  backdropFilter: 'blur(4px)',
};

const animButtonStyle: CSSProperties = {
  padding: '3px 10px',
  fontSize: 12,
  cursor: 'pointer',
  background: '#242931',
  color: '#d7dce2',
  border: '1px solid #3a414b',
  borderRadius: 6,
};

const animSelectStyle: CSSProperties = {
  fontSize: 12,
  background: '#242931',
  color: '#d7dce2',
  border: '1px solid #3a414b',
  borderRadius: 6,
  padding: '3px 6px',
  maxWidth: 260,
};
