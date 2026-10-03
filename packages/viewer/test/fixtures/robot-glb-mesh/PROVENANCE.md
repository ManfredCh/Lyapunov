# 真件来源：机器人文档里的 `.glb` 网格（banana）

本目录两个文件是**未改一个字节**的真件拷贝（`sha256` 与原件相同，见下），不是合成夹具。

| 文件 | sha256 | 字节数 | 来源（原件的绝对路径） |
| --- | --- | --- | --- |
| `banana.xml` | `8c279e975def17bef5b1681706dfe9128519e34d7d4a37bd05286c5870a9d77f` | 708 | `<Dev>/.runtime/desktop/developer/runtime/developer/cache/cas/8c/8c279e975def17bef5b1681706dfe9128519e34d7d4a37bd05286c5870a9d77f-banana.xml_deps/banana.xml` |
| `banana.glb` | `15ed7207a485b8c696a20ae5547f4cb023c552819cac4dfa5f91408bef50c3b0` | 264,012 | 同目录 `banana.glb` |

（原件所在目录是产品的 CAS 依赖目录：目录名 `8c279e97…-banana.xml_deps` 的 `8c279e97…` 正是 `banana.xml`
的内容寻址前缀 —— 依赖是按「主文档的 sha256」归档的，这一对文件就是"某次真实导入"的产物。）

## 为什么是它

全工作区（`.runtime` + `materials` + `packages` + `output`，排除 `node_modules`）扫描"机器人文档引用 `.glb` 网格"
的真实用例，**只命中这一处**（连同它的两条历史修订）：

```
.runtime/desktop/developer/runtime/developer/worlds/scenes/banana-p2.json                     ← 真落盘场景
.runtime/desktop/developer/runtime/developer/worlds/scenes/.history/banana-p2/revision-1.json
.runtime/desktop/developer/runtime/developer/worlds/scenes/.history/banana-p2/revision-2.json
```

扫描判据：JSON 里同时有 `"kind": "robot"` 与 `"file": "…​.glb"`；XML/URDF/MJCF 里 `<mesh file="…​.glb">`／
`<mesh filename="…​.glb">`。场景 `banana-p2` 的实体 `banana` 的 `components.visual` 是
`{kind:"robot", format:"mjcf"}`，文档里就是 `<mesh name="banana_mesh" file="banana.glb"/>`。

## 真件的几何事实（读 GLB 容器 chunk 得到，不是猜）

```
magic=glTF version=2 total=264012（与文件长度相同）
JSON chunk 1360 B
extensionsUsed     = ["KHR_materials_specular"]      ← 没有 KHR_texture_basisu（KTX2）
extensionsRequired = 无                              ← 没有 EXT_meshopt_compression / KHR_draco_mesh_compression
meshes=1 primitives=1 mode=4(TRIANGLES)  nodes=1  materials=1  images=0  accessors=4
attributes = POSITION,NORMAL,TEXCOORD_0
POSITION count = 5993   indices count = 35424   generator = "Khronos glTF Blender I/O v5.2.40"
```

MuJoCo 侧（物理读法，`.runtime/sim-python` 的 `mujoco 3.13.0`，**真读数**）：

```
>>> mujoco.MjModel.from_xml_path("…/banana.xml")
ValueError: Error: no decoder found for mesh file '…/banana.glb'
            Element name 'banana_mesh', id 0, line 5
```

⇒ 这份真件是**视觉专用**：Viewer 的 `GLTFLoader` 读得了，MuJoCo 读不了（物理编译由 MuJoCo 自己报错）。
`packages/scene-kit/src/formats.ts` 的登记闭包因此把 `.glb` 收进来（不假装 MuJoCo 支持它），
详见回执 `bugfixHistory/ROBOT-GLB-MESH-20260927.md`。

## 使用它的用例

`packages/viewer/test/robot-glb-mesh.test.ts`：真件 sha256 与上表逐字核对（拷错/被改会当场红），
`parseAsset` 的依赖闭包含 `banana.glb`，`robotVisual` + `buildRobotVisual` 用**真字节**建出 GLB 网格
（几何读数与上面 `POSITION count`／`indices count` 一致）。
