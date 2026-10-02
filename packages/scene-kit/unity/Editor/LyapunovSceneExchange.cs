#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Lyapunov.SceneExchange
{
    // ────────────────────────────────────────────────────────────────────────────
    // 数据合同（JsonUtility 只认具体类 + 数组；所有字符串默认 ""，不用 null）
    //
    // 传输文档里的**变换一律是 Unity 原生空间**（米、左手、Y-up、四元数 xyzw）。
    // 与产品（右手 Z-up）的换算只有一处 owner：产品侧 packages/scene-kit/src/unity-exchange.ts。
    // 全部网格字节（file 字段指向的 GLB）例外：为了产品能不经包装直接使用，写入前已按
    // fileSpace 声明的空间烘焙（见 GlbWriter）。
    // ────────────────────────────────────────────────────────────────────────────

    [Serializable]
    public class ExchangeRequest
    {
        public string requestId = "";
        public string op = "";                 // status | export | import
        public string resultPath = "";         // 省略时写 <scratch>/result.json
        /**
         * 调用方声明的目标工程根。非空时必须与本编辑器一致，否则**直接拒绝、不做任何导入**
         * ——菜单项本身没有实例参数（execute_menu_item 只认 menu_path），请求可能落到另一台编辑器上。
         */
        public string expectProjectRoot = "";
        /** 认领截止（毫秒时间戳，0 = 不过期）：取消/崩溃留下的孤儿请求不会在很久以后突然被执行。 */
        public long deadlineUnixMs;
        public ExportRequest export;
        public ImportRequest import;
    }

    [Serializable]
    public class ExportRequest
    {
        public string scenePath = "";          // "" = 当前激活场景；否则必须已加载或可从 Assets 打开
        public bool includeInactive = true;
        public bool exportMeshes = true;
        public bool hashAssets = false;
        public int maxNodes = 20000;
        public string documentPath = "";       // "" = <scratch>/unity-scene.json
    }

    [Serializable]
    public class ImportRequest
    {
        public string documentPath = "";       // 绝对路径或项目相对路径
        public string mode = "current";        // current | additive | new
        public string scenePath = "";          // mode=new 必填（Assets/ 下的场景路径）；additive 可选（已存在则打开）
        public bool saveScene = true;
        public bool dryRun = false;
        public string assetFolder = "";        // "" = Assets/LyapunovSceneExchange/Imported
        public float metersPerUnit = 1f;       // 文档单位到 Unity 米的换算（1 = 文档已是米）
    }

    [Serializable]
    public class ExchangeResult
    {
        public string requestId = "";
        public string op = "";
        public bool ok;
        public long startedAtUnixMs;
        public long finishedAtUnixMs;
        public string[] errors = new string[0];
        public string[] warnings = new string[0];
        // ── 执行回执：到底哪台编辑器、哪个工程、哪个场景、动了什么 ──────────────────
        public string projectRoot = "";
        public int processId;
        public string instanceName = "";
        public string scenePath = "";
        public string sceneName = "";
        public string sceneGuid = "";
        /** 本次执行新建/更新的对象（`action:entityId:name`），导入时非空；导出为空（Unity 侧没改东西）。 */
        public string[] changed = new string[0];
        public StatusPayload status;
        public ExportPayload export;
        public ImportPayload import;
    }

    [Serializable]
    public class StatusPayload
    {
        public string unityVersion = "";
        public string platform = "";
        public string projectPath = "";
        public string dataPath = "";
        public string scratchDirectory = "";
        public string menuPath = "";
        public int processId;
        public bool isPlaying;
        public bool isCompiling;
        public bool isUpdating;
        public bool identityComponentAvailable;
        public SceneRecord activeScene;
        public SceneRecord[] loadedScenes = new SceneRecord[0];
        public int totalRootObjects;
        public int totalObjects;
        public string[] editorSelection = new string[0];
        /** 还没被认领的请求文件（调用方取消/超时后可以据此确认"到底有没有在跑"）。 */
        public string[] pendingRequests = new string[0];
        /** 最近写出的回执（新的在前）：取消/超时之后唯一的结果来源，不另存一份状态。 */
        public RequestRecord[] recentResults = new RequestRecord[0];
    }

    [Serializable]
    public class RequestRecord
    {
        public string requestId = "";
        public string op = "";
        public bool ok;
        public long finishedAtUnixMs;
        public string resultPath = "";
        public string[] errors = new string[0];
    }

    [Serializable]
    public class SceneRecord
    {
        public string name = "";
        public string path = "";
        public string guid = "";
        public bool isLoaded;
        public bool isDirty;
        public bool isActive;
        public int rootCount;
        public int buildIndex = -1;
    }

    [Serializable]
    public class ExportPayload
    {
        public string scenePath = "";
        public string documentPath = "";
        public int nodeCount;
        public int rootCount;
        public int assetCount;
        public int meshFileCount;
        public long documentBytes;
        public string[] losses = new string[0];
    }

    [Serializable]
    public class ImportPayload
    {
        public string scenePath = "";
        public string mode = "";
        public bool dryRun;
        public int created;
        public int updated;
        public int skipped;
        public int assetFilesCopied;
        public ImportNodeResult[] nodes = new ImportNodeResult[0];
        public string[] losses = new string[0];
    }

    [Serializable]
    public class ImportNodeResult
    {
        public int index;
        public string entityId = "";
        public string globalId = "";
        public string name = "";
        public string action = "";             // created | updated | skipped | planned
        public string[] losses = new string[0];
    }

    [Serializable]
    public class SceneDocument
    {
        public string kind = "lyapunov.unity-scene";
        public int version = 1;
        public string generator = "";
        public long generatedAtUnixMs;
        public string scenePath = "";
        public string sceneName = "";
        public string sceneGuid = "";
        public string transformSpace = "unity-left-handed-y-up-meters";
        public string meshSpace = "product-right-handed-z-up-meters";
        public EnvironmentRecord environment = new EnvironmentRecord();   // 场景级环境读数；present=false 表示这次没采到
        public NodeRecord[] nodes = new NodeRecord[0];
        public AssetRecord[] assets = new AssetRecord[0];
        public string[] losses = new string[0];
    }

    [Serializable]
    public class NodeRecord
    {
        public int index;
        public int parentIndex = -1;
        public string name = "";
        public string entityId = "";           // 来自 LyapunovEntityIdentity；导出时没有就留空（产品按 globalId 派生）
        public string globalId = "";
        public float[] position = new float[3];
        public float[] rotation = new float[4];  // xyzw
        public float[] scale = new float[3];
        public bool active = true;
        public string tag = "";
        public int layer;
        public string[] componentTypes = new string[0];
        public MeshRecord mesh;
        public MaterialRecord[] materials = new MaterialRecord[0];
        public LightRecord light;
        public CameraRecord camera;
        public PrefabRecord prefab;
        public TerrainRecord terrain;
        public string[] losses = new string[0];
    }

    [Serializable]
    public class MeshRecord
    {
        public string name = "";
        public string primitive = "";          // Cube | Sphere | Capsule | Cylinder | Plane | Quad | ""
        public string assetPath = "";
        public string assetGuid = "";
        public int vertexCount;
        public int triangleCount;
        public int subMeshCount;
        public int uvCount;                    // 与顶点数一致才算有 UV（GLB 写 TEXCOORD_0）
        public string contentDigest = "";      // 顶点/法线/UV/索引/子网格按 1e-6 量化后的内容摘要（导入侧据此判"资产还是不是这份内容"）
        public float[] boundsCenter = new float[3];
        public float[] boundsSize = new float[3];
        public string file = "";               // 写出的 GLB（项目相对路径）
        public string fileSpace = "";          // 该 GLB 的空间：product-right-handed-z-up-meters
        public long fileBytes;
    }

    [Serializable]
    public class TextureRecord
    {
        // 与 CameraRecord 同理：不设默认值，"没有贴图"必须和"贴图恰好是这些值"分得开。
        public string property;                // 材质上的贴图属性（_MainTex / _BumpMap …）
        public string assetPath;
        public string assetGuid;
        public string file;                    // 落到 scratch 的图片文件（相对工程根）
        public string mimeType;                // image/png | image/jpeg
        public long bytes;
        public int width;
        public int height;
        public string wrapMode;                // Repeat | Clamp | Mirror | MirrorOnce
        public string contentDigest;           // 图片字节摘要（同一张图只落一次）
        public bool reencoded;                 // 源资产不是 png/jpeg，按 PNG 重编码
    }

    [Serializable]
    public class MaterialRecord
    {
        public string name = "";
        public string assetPath = "";
        public string assetGuid = "";
        public string shader = "";
        public float[] baseColor = new float[4];   // rgba
        public float metallic;
        public float smoothness;
        public string[] textures = new string[0];  // 材质上真实存在的贴图属性名 + 资产路径
        public TextureRecord[] textureFiles = new TextureRecord[0];  // 真的把图片字节落到产品（GLB 内嵌 + 此处的可寻址副本）
    }

    /// <summary>
    /// 场景级环境读数（导出）与写回（导入）。字段是**产品 `components.environment` 的子集**
    /// （见 45_environment_lighting 的 SceneEnvironment）：只交换两边都真有对应物的字段，
    /// 拿不到的（色调映射曝光、烘焙 GI/光照贴图、雾、反射探针、天空盒 shader）逐条记损失。
    /// 与 CameraRecord 同理：不设默认值，`present` 才是"这份记录真的存在"的判据
    /// （JsonUtility 会把缺失的嵌套记录写成字段默认值实例）。
    /// </summary>
    [Serializable]
    public class EnvironmentRecord
    {
        public bool present;
        public float environmentIntensity;     // ↔ RenderSettings.reflectionIntensity（IBL 强度）
        public float hemisphereIntensity;      // ↔ RenderSettings.ambientIntensity（环境补光）
        public string ambientMode;             // Skybox | Trilight | Flat | Custom（Unity 侧的环境光来源）
        public string background;              // environment | color（取相机 clearFlags）
        public string backgroundColor;         // #rrggbb（相机 backgroundColor）
        public bool shadows;                   // 太阳灯是否投影
        public float sunAzimuthDeg;
        public float sunElevationDeg;
        public float sunIntensity;
        public string sunName;                 // 被当成太阳的那盏方向光的对象名（回写时按名字认领）
        public bool dayNightEnabled;
        public float dayNightHours;
        public float dayNightCycleSeconds;
        public string skyboxPath;              // 天空盒材质资产路径（参考；产品侧没有材质概念）
        public string skyboxShader;
        public string hdriFile;                // 天空盒主贴图是 .hdr/.exr 时落到 scratch 的副本（相对工程根）
        public string hdriAssetPath;
        public long hdriBytes;
        public string[] losses;
    }

    [Serializable]
    public class LightRecord
    {
        public string type = "";               // Directional | Point | Spot | Rectangle | Disc | Pyramid | Box | Tube
        public float[] color = new float[4];
        public float intensity;
        public float range;
        public float spotAngleDeg;
        public float[] areaSize = new float[2];
        public string shadows = "";
        public float bounceIntensity;
        public bool enabled = true;
    }

    [Serializable]
    public class CameraRecord
    {
        // 这里**故意不给默认值**：JsonUtility 会把"没有的嵌套记录"写成一份字段默认值实例（不是 null），
        // 留了默认值就没法把"没有相机"和"相机恰好是这个值"分开（见 HasCamera 的判据）。
        public float fieldOfViewDeg;
        public float nearClip;
        public float farClip;
        public bool orthographic;
        public float orthographicSize;
        public float depth;
        public string clearFlags = "";
        public float[] background = new float[4];
        public bool enabled = true;
    }

    [Serializable]
    public class PrefabRecord
    {
        public string status = "";             // NotAPrefab | MissingAsset | NotConnected | Connected | Disconnected | PrefabInstance
        public string assetPath = "";
        public string assetGuid = "";
        public bool isOutermost;
    }

    [Serializable]
    public class TerrainRecord
    {
        public float widthM;
        public float heightM;
        public float lengthM;
        public int heightmapResolution;
        public float minHeight;
        public float maxHeight;
        public string heightsFile = "";        // 原始 little-endian float32，行主序，resolution×resolution（侧车，调试/兜底用）
        public long heightsBytes;
        public int alphamapLayers;
        public int treeInstanceCount;
        public string treesFile = "";          // TreeInstance 数组的 JSON（侧车；同一份数据也内联在 instances 里）
        public TreePrototypeRecord[] treePrototypes = new TreePrototypeRecord[0];
        // ── 交付闭包（v2）：高度图与植被几何真的落成产品资源，不依赖 Unity Library 绝对路径 ──
        public int meshResolution;             // 交付网格的格点数（每边顶点数；与 heightmapResolution 相同，未降采样）
        public string meshFile = "";           // 交付的地形网格 GLB（项目相对路径；产品导入后进自己的资源库）
        public string meshFileSpace = "";      // product-right-handed-z-up-meters（与网格节点同一约定）
        public long meshBytes;
        public int meshVertexCount;
        public int meshTriangleCount;
        public int holeCellCount;              // 源地形挖掉的可通行格数（孔洞）；0 = 无孔
        public string textureFile = "";        // 层混合烘焙出的等价漫反射贴图（项目相对路径，同时内嵌在 meshFile 的 GLB 里）
        public string textureDigest = "";
        public int textureWidth;
        public int textureHeight;
        public TreeInstanceRecord[] instances = new TreeInstanceRecord[0];   // 植被实例内联（侧车之外的第二份，产品读的是这一份）
        public bool treeInstancesAuthoritative;                                // true = instances 就是全部（空数组 = 真的没有树），写回才允许改动 treeInstances
    }

    [Serializable]
    public class TreePrototypeRecord
    {
        public string prefabPath = "";
        public string prefabGuid = "";
        // TreePrototype.bendFactor：Unity 用它算树的弯曲量。**不带走就等于写回时把它改成 0**（静默改用户资产参数），
        // 所以它属于"必须原样往返"的原型参数（109 真机实测：写回前 0.25 → 写回后 0）。
        public float bendFactor;
        // ── 交付闭包（v2）：该原型 prefab 的几何作为**一份共享 GLB** 交付（逐树不复制素材） ──
        public string meshFile = "";
        public long meshBytes;
        public int vertexCount;
        public int triangleCount;
        public int subMeshCount;
        public int materialCount;
        public string meshError = "";          // 非空 = 这份原型的几何没能交付（真实原因）；树实例仍按数据交换
    }

    [Serializable]
    public class TreeInstanceRecord
    {
        public float[] position = new float[3];   // Unity TreeInstance.position 原样：x/z 是相对地形原点的归一化 0..1，y 也是归一化高度 0..1（× size.y = 米）
        public float widthScale = 1f;
        public float heightScale = 1f;
        public float rotationRad;
        public float[] color = new float[4];
        public int prototypeIndex;
    }

    [Serializable]
    public class TreeInstanceFile
    {
        public TreeInstanceRecord[] instances = new TreeInstanceRecord[0];
    }

    [Serializable]
    public class AssetRecord
    {
        public int index;
        public string path = "";
        public string guid = "";
        public string type = "";
        public long fileSize;
        public string sha256 = "";
    }

    // ────────────────────────────────────────────────────────────────────────────
    // 工具本体：菜单项 + 请求/结果文件协议
    // ────────────────────────────────────────────────────────────────────────────

    public static class LyapunovSceneExchange
    {
        public const string MenuPath = "Tools/Lyapunov Scene Exchange/Run Request";
        public const string StatusMenuPath = "Tools/Lyapunov Scene Exchange/Status";
        public const string ExportMenuPath = "Tools/Lyapunov Scene Exchange/Export Active Scene";
        public const string ResultFileName = "result.json";
        public const string DocumentFileName = "unity-scene.json";
        /** 请求/结果目录（各一个文件一条请求，文件名 = requestId）。 */
        public const string RequestsDirectoryName = "requests";
        public const string ResultsDirectoryName = "results";
        public const string ClaimedDirectoryName = "claimed";
        public const string DefaultAssetFolder = "Assets/LyapunovSceneExchange/Imported";
        public const string Kind = "lyapunov.unity-scene";
        public const int Version = 1;

        /// <summary>项目根的绝对路径（Application.dataPath 的父目录）。</summary>
        public static string ProjectRoot
        {
            get { return Path.GetFullPath(Path.Combine(Application.dataPath, "..")); }
        }

        /// <summary>交换暂存目录：项目 Library 下，不进版本控制、不污染 Assets。</summary>
        public static string ScratchDirectory
        {
            get { return Path.Combine(ProjectRoot, "Library", "LyapunovSceneExchange"); }
        }

        /**
         * 交付文件（网格 GLB / 侧车高度 / 树 JSON / 贴图）一律"暂存 + 原子改名"落盘，**不就地截断**。
         * 原因不是并发，而是**产品资源库把源文件硬链进库**（resources.ts 的 link 快路径）：
         * 就地写会把已经交付出去的那份资产在脚下改掉。109 真机实测过：同一个 inode（st_nlink=3）
         * 被第二次导出就地覆盖，产品 catalog 里记的 sha256 d7500ea1… 与磁盘上的 127286b3… 对不上。
         * 改名换的是目录项，旧 inode 留在库里，已交付的字节不会被后来的导出改写。
         */
        public static string StagingPath(string path) { return path + ".staging-" + Guid.NewGuid().ToString("N"); }

        /**
         * 把暂存文件替到目标路径上：**同目录的原子替换**，不是"先删再移"。
         * 目标已存在走 `File.Replace`（同一目录=同一文件系统，换的是目录项，路径上不存在
         * "已删除、还没移入"的窗口，失败也仍指向旧文件）；目标不存在只能 `File.Move`
         * （`File.Replace` 要求目标存在）。两条路径都**不截断旧 inode**：旧字节留在别处持有的硬链里
         * （产品库那一份），这才是一直要保住的东西。
         */
        public static void CommitStagedFile(string staging, string path)
        {
            if (File.Exists(path))
            {
                try { File.Replace(staging, path, null); return; }
                catch (FileNotFoundException) { } // 检查与替换之间目标消失（并发认领/清理）：退到 Move
            }
            File.Move(staging, path);
        }

        /** 直接把一段字节交付到 path（内部走暂存 + 原子改名）。 */
        public static void WriteDeliverable(string path, byte[] bytes)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
            string staging = StagingPath(path);
            File.WriteAllBytes(staging, bytes);
            CommitStagedFile(staging, path);
        }

        public static string DefaultResultPath { get { return Path.Combine(ScratchDirectory, ResultFileName); } }
        public static string DefaultDocumentPath { get { return Path.Combine(ScratchDirectory, DocumentFileName); } }
        public static string RequestsDirectory { get { return Path.Combine(ScratchDirectory, RequestsDirectoryName); } }
        public static string ResultsDirectory { get { return Path.Combine(ScratchDirectory, ResultsDirectoryName); } }
        public static string ClaimedDirectory { get { return Path.Combine(ScratchDirectory, ClaimedDirectoryName); } }

        /** 当前编辑器实例的身份：工程根 + 进程号（多实例时 pid 是真正的"哪一台"）。 */
        public static int ProcessId
        {
            get { return System.Diagnostics.Process.GetCurrentProcess().Id; }
        }

        // ── 菜单项：唯一执行入口。MCP 侧经 execute_menu_item 调用它，人类也可直接用。──

        [MenuItem(MenuPath, false, 1000)]
        public static void RunRequestFromFile()
        {
            int drained = DrainPendingRequests();
            // 菜单项**只**认领 `requests/` 里的请求文件：不会顺带消费别处残留的旧请求（旧协议已不在生产里用）。
            Debug.Log(string.Format(CultureInfo.InvariantCulture,
                "[LyapunovSceneExchange] drained {0} pending request(s) in {1}", drained, RequestsDirectory));
        }

        /**
         * 把 `requests/` 里每份请求**恰好执行一次**，回执写到各自唯一的 resultPath。
         *
         * 并行安全靠两件事（都不是新调度器）：
         *   1. 文件名 = requestId，一份请求一个文件，调用方之间互不覆盖；
         *   2. 认领用 `File.Move`（同一卷上原子）：并发的菜单调用或多个编辑器进程都只会有一个把文件移走，
         *      另一个 File.Move 失败即跳过 —— 不会重复执行。
         * 过期（deadlineUnixMs 已过）的请求同样认领，但只回一份 REQUEST_EXPIRED 回执、不执行：
         * 取消后遗留的孤儿请求不会在很久以后才突然跑起来。
         */
        public static int DrainPendingRequests()
        {
            if (!Directory.Exists(RequestsDirectory)) return 0;
            string[] paths = Directory.GetFiles(RequestsDirectory, "*.json");
            Array.Sort(paths, StringComparer.Ordinal);
            Directory.CreateDirectory(ClaimedDirectory);
            int drained = 0;
            foreach (string path in paths)
            {
                string claimed = Path.Combine(ClaimedDirectory, Path.GetFileName(path));
                try { File.Move(path, claimed); }
                catch (IOException) { continue; }                  // 已被并发的另一次运行认领
                catch (UnauthorizedAccessException) { continue; }   // 同上（Windows 下的等价失败）
                drained++;
                ExchangeRequest request = null;
                try
                {
                    request = JsonUtility.FromJson<ExchangeRequest>(File.ReadAllText(claimed));
                    if (request == null) throw new InvalidOperationException("REQUEST_UNPARSABLE");
                    string resultPath = string.IsNullOrEmpty(request.resultPath) ? DefaultResultPath : request.resultPath;
                    ExchangeResult result;
                    if (request.deadlineUnixMs > 0 && UnixMs() > request.deadlineUnixMs)
                    {
                        result = new ExchangeResult { requestId = request.requestId ?? "", op = request.op ?? "", ok = false, startedAtUnixMs = UnixMs(), finishedAtUnixMs = UnixMs() };
                        result.errors = new[] { "REQUEST_EXPIRED: 请求已过期（认领截止 " + request.deadlineUnixMs + "），本次不执行" };
                        result.projectRoot = ProjectRoot;
                        result.processId = ProcessId;
                        WriteResult(resultPath, result);
                    }
                    else
                    {
                        ExecuteRequestToFile(request, resultPath, claimed);
                    }
                }
                catch (Exception error)
                {
                    ExchangeResult failure = new ExchangeResult { requestId = request != null ? request.requestId : "", op = request != null ? request.op : "", ok = false, startedAtUnixMs = UnixMs(), finishedAtUnixMs = UnixMs() };
                    failure.projectRoot = ProjectRoot;
                    failure.processId = ProcessId;
                    failure.errors = new[] { "REQUEST_FAILED: " + error.GetType().Name + ": " + error.Message };
                    WriteResult(request != null && !string.IsNullOrEmpty(request.resultPath) ? request.resultPath : DefaultResultPath, failure);
                }
                finally { try { File.Delete(claimed); } catch (IOException) { } }
            }
            return drained;
        }

        [MenuItem(StatusMenuPath, false, 1001)]
        public static void WriteStatusFromMenu()
        {
            var request = new ExchangeRequest();
            request.requestId = "menu-" + DateTime.UtcNow.Ticks.ToString(CultureInfo.InvariantCulture);
            request.op = "status";
            ExchangeResult result = Execute(request);
            WriteResult(DefaultResultPath, result);
            Debug.Log("[LyapunovSceneExchange] status → " + DefaultResultPath);
        }

        [MenuItem(ExportMenuPath, false, 1002)]
        public static void ExportActiveSceneFromMenu()
        {
            var request = new ExchangeRequest();
            request.requestId = "menu-" + DateTime.UtcNow.Ticks.ToString(CultureInfo.InvariantCulture);
            request.op = "export";
            request.export = new ExportRequest { scenePath = "", exportMeshes = true };
            ExchangeResult result = Execute(request);
            WriteResult(DefaultResultPath, result);
            Debug.Log("[LyapunovSceneExchange] export → " + (result.export != null ? result.export.documentPath : "(failed)"));
        }

        /** 执行 + 写回执（drain 认领一条就执行一条）。 */
        private static ExchangeResult ExecuteRequestToFile(ExchangeRequest request, string resultPath, string claimedPath)
        {
            ExchangeResult result = ExecuteAndWrite(request, resultPath);
            Debug.Log(string.Format(CultureInfo.InvariantCulture,
                "[LyapunovSceneExchange] {0} ok={1} errors={2} claim={3} pid={4} → {5}",
                result.op, result.ok, result.errors.Length, claimedPath, result.processId, resultPath));
            return result;
        }

        private static ExchangeResult ExecuteAndWrite(ExchangeRequest request, string resultPath)
        {
            ExchangeResult result = Execute(request);
            WriteResult(resultPath, result);
            return result;
        }

        /// <summary>执行一条已解析请求。不读文件系统里的请求，也不写结果文件（调用方负责）。</summary>
        public static ExchangeResult Execute(ExchangeRequest request)
        {
            var result = new ExchangeResult
            {
                requestId = request.requestId ?? "",
                op = request.op ?? "",
                startedAtUnixMs = UnixMs(),
            };
            var errors = new List<string>();
            var warnings = new List<string>();
            Scene active = SceneManager.GetActiveScene();
            result.projectRoot = ProjectRoot;
            result.processId = ProcessId;
            result.instanceName = Application.productName;
            result.scenePath = active.path ?? "";
            result.sceneName = active.name ?? "";
            result.sceneGuid = string.IsNullOrEmpty(active.path) ? "" : (AssetDatabase.AssetPathToGUID(active.path) ?? "");
            // 目标核对：请求声明的工程与本编辑器不一致就**什么都不做**（菜单项没有实例参数，
            // 请求可能被派到了另一台编辑器；宁可不做，也不要把场景导进别的项目）。
            if (!string.IsNullOrEmpty(request.expectProjectRoot) && !SamePath(request.expectProjectRoot, ProjectRoot))
            {
                result.ok = false;
                result.errors = new[] { "PROJECT_MISMATCH: 请求指定工程 " + request.expectProjectRoot + "，本编辑器是 " + ProjectRoot + "（不执行任何导入/导出）" };
                result.finishedAtUnixMs = UnixMs();
                return result;
            }
            try
            {
                switch (result.op)
                {
                    case "status":
                        result.status = BuildStatus();
                        break;
                    case "export":
                        result.export = ExecuteExport(request.export ?? new ExportRequest(), warnings);
                        break;
                    case "import":
                        if (request.import == null) throw new InvalidOperationException("IMPORT_OPTIONS_REQUIRED");
                        result.import = ExecuteImport(request.import, warnings);
                        break;
                    default:
                        throw new InvalidOperationException("UNKNOWN_OP: " + result.op);
                }
                result.ok = true;
            }
            catch (Exception error)
            {
                errors.Add(error.GetType().Name + ": " + error.Message);
                result.ok = false;
            }
            result.errors = errors.ToArray();
            result.warnings = warnings.ToArray();
            // 修改回执：这次到底动了哪些对象（action:entityId:globalId:name），调用方不必回头猜。
            if (result.import != null && result.import.nodes != null)
            {
                var changed = new List<string>();
                foreach (ImportNodeResult node in result.import.nodes)
                {
                    if (node.action == "created" || node.action == "updated")
                        changed.Add(node.action + ":" + node.entityId + ":" + node.globalId + ":" + node.name);
                }
                result.changed = changed.ToArray();
            }
            result.finishedAtUnixMs = UnixMs();
            return result;
        }

        private static long UnixMs()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        private static void WriteResult(string path, ExchangeResult result)
        {
            string full = Path.GetFullPath(path);
            Directory.CreateDirectory(Path.GetDirectoryName(full));
            // 回执也要原子出现：调用方按存在即读解析，半份 JSON 会被判成坏回执。
            string temporary = full + ".tmp";
            File.WriteAllText(temporary, JsonUtility.ToJson(result, true));
            if (File.Exists(full)) File.Delete(full);
            File.Move(temporary, full);
        }

        /** 路径等价：绝对化 + 去掉结尾分隔符（Unity 报的路径与调用方给的可能差一个尾斜杠）。 */
        public static bool SamePath(string left, string right)
        {
            if (string.IsNullOrEmpty(left) || string.IsNullOrEmpty(right)) return false;
            string a = Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string b = Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return string.Equals(a, b, StringComparison.Ordinal) || string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
        }

        /** 还没被认领的请求文件（status 用：取消/超时后确认"还有没有在跑"）。 */
        public static string[] PendingRequestPaths()
        {
            if (!Directory.Exists(RequestsDirectory)) return new string[0];
            string[] paths = Directory.GetFiles(RequestsDirectory, "*.json");
            Array.Sort(paths, StringComparer.Ordinal);
            return paths;
        }

        /** 最近写出的回执（新的在前）。这是取消/超时之后**唯一**的结果来源，不另存一份状态。 */
        public static RequestRecord[] RecentResults(int limit)
        {
            if (!Directory.Exists(ResultsDirectory)) return new RequestRecord[0];
            var records = new List<RequestRecord>();
            string[] paths = Directory.GetFiles(ResultsDirectory, "*.json");
            Array.Sort(paths, (left, right) => File.GetLastWriteTimeUtc(right).CompareTo(File.GetLastWriteTimeUtc(left)));
            for (int index = 0; index < paths.Length && records.Count < limit; index++)
            {
                try
                {
                    ExchangeResult parsed = JsonUtility.FromJson<ExchangeResult>(File.ReadAllText(paths[index]));
                    if (parsed == null) continue;
                    records.Add(new RequestRecord
                    {
                        requestId = parsed.requestId ?? "",
                        op = parsed.op ?? "",
                        ok = parsed.ok,
                        finishedAtUnixMs = parsed.finishedAtUnixMs,
                        resultPath = paths[index],
                        errors = parsed.errors ?? new string[0],
                    });
                }
                catch (Exception) { /* 正在写一半的回执：跳过，下次再看 */ }
            }
            return records.ToArray();
        }

        // ── status：只读读数 ────────────────────────────────────────────────────

        public static StatusPayload BuildStatus()
        {
            var payload = new StatusPayload
            {
                unityVersion = Application.unityVersion,
                platform = Application.platform.ToString(),
                projectPath = ProjectRoot,
                dataPath = Application.dataPath,
                scratchDirectory = ScratchDirectory,
                menuPath = MenuPath,
                isPlaying = EditorApplication.isPlaying,
                isCompiling = EditorApplication.isCompiling,
                isUpdating = EditorApplication.isUpdating,
                identityComponentAvailable = true,
                processId = ProcessId,
                pendingRequests = PendingRequestPaths(),
                recentResults = RecentResults(20),
            };
            var loaded = new List<SceneRecord>();
            for (int index = 0; index < SceneManager.sceneCount; index++)
            {
                Scene scene = SceneManager.GetSceneAt(index);
                loaded.Add(SceneRecordOf(scene, scene == SceneManager.GetActiveScene()));
            }
            payload.loadedScenes = loaded.ToArray();
            payload.activeScene = SceneRecordOf(SceneManager.GetActiveScene(), true);
            int roots = 0, total = 0;
            for (int index = 0; index < SceneManager.sceneCount; index++)
            {
                Scene scene = SceneManager.GetSceneAt(index);
                if (!scene.isLoaded) continue;
                GameObject[] sceneRoots = scene.GetRootGameObjects();
                roots += sceneRoots.Length;
                foreach (GameObject root in sceneRoots) total += root.GetComponentsInChildren<Transform>(true).Length;
            }
            payload.totalRootObjects = roots;
            payload.totalObjects = total;
            payload.editorSelection = Selection.gameObjects.Select(go => go.name).ToArray();
            return payload;
        }

        private static SceneRecord SceneRecordOf(Scene scene, bool isActive)
        {
            var record = new SceneRecord
            {
                name = scene.name ?? "",
                path = scene.path ?? "",
                guid = string.IsNullOrEmpty(scene.path) ? "" : AssetDatabase.AssetPathToGUID(scene.path),
                isLoaded = scene.isLoaded,
                isDirty = scene.isDirty,
                isActive = isActive,
            };
            if (scene.IsValid() && scene.isLoaded)
            {
                record.rootCount = scene.rootCount;
                record.buildIndex = scene.buildIndex;
            }
            return record;
        }

        // ── export：Unity 场景 → 交换文档 ───────────────────────────────────────

        public static ExportPayload ExecuteExport(ExportRequest options, List<string> warnings)
        {
            Scene scene = ResolveScene(options.scenePath);
            if (!scene.IsValid() || !scene.isLoaded) throw new InvalidOperationException("SCENE_NOT_LOADED: " + options.scenePath);
            string documentPath = string.IsNullOrEmpty(options.documentPath) ? DefaultDocumentPath : Path.GetFullPath(options.documentPath);
            string meshDirectory = Path.Combine(Path.GetDirectoryName(documentPath), "meshes");
            // 贴图字节落在这里（与 mesh 同级）：同一张图只落一次，文档里给可寻址副本，
            // GLB 里同时内嵌一份（Viewer 直接按 GLB 渲染，不需要再找文件）。
            string textureDirectory = Path.Combine(Path.GetDirectoryName(documentPath), "textures");
            var textureFiles = new Dictionary<string, string>(StringComparer.Ordinal);   // 资产 GUID/路径 → 落盘相对路径
            var losses = new List<string>();
            var document = new SceneDocument
            {
                generator = "LyapunovSceneExchange/" + Application.unityVersion,
                generatedAtUnixMs = UnixMs(),
                scenePath = scene.path ?? "",
                sceneName = scene.name ?? "",
                sceneGuid = string.IsNullOrEmpty(scene.path) ? "" : AssetDatabase.AssetPathToGUID(scene.path),
            };

            var nodes = new List<NodeRecord>();
            var assetTypes = new Dictionary<string, string>(StringComparer.Ordinal);   // 资产路径 → 类型（去重靠字典）
            int meshFiles = 0;

            Action<string, string> noteLoss = (code, message) =>
            {
                string line = code + ": " + message;
                if (!losses.Contains(line)) losses.Add(line);
            };

            Action<Transform, int> walk = null;
            walk = (transform, parentIndex) =>
            {
                if (nodes.Count >= options.maxNodes)
                {
                    noteLoss("NODE_LIMIT_REACHED", "超过 maxNodes=" + options.maxNodes.ToString(CultureInfo.InvariantCulture) + "，后续节点未导出");
                    return;
                }
                GameObject go = transform.gameObject;
                if (!options.includeInactive && !go.activeInHierarchy) return;
                var node = new NodeRecord
                {
                    index = nodes.Count,
                    parentIndex = parentIndex,
                    name = go.name,
                    globalId = GlobalObjectId.GetGlobalObjectIdSlow(go).ToString(),
                    position = new[] { transform.localPosition.x, transform.localPosition.y, transform.localPosition.z },
                    rotation = new[] { transform.localRotation.x, transform.localRotation.y, transform.localRotation.z, transform.localRotation.w },
                    scale = new[] { transform.localScale.x, transform.localScale.y, transform.localScale.z },
                    active = go.activeSelf,
                    tag = go.tag ?? "",
                    layer = go.layer,
                };
                LyapunovEntityIdentity identity = go.GetComponent<LyapunovEntityIdentity>();
                if (identity != null && !string.IsNullOrEmpty(identity.entityId)) node.entityId = identity.entityId;
                nodes.Add(node);
                int nodeIndex = node.index;
                var nodeLosses = new List<string>();

                string[] componentTypes = go.GetComponents<Component>()
                    .Where(component => component != null)
                    .Select(component => component.GetType().Name)
                    .Distinct()
                    .ToArray();
                node.componentTypes = componentTypes;

                // 网格（含蒙皮）：蒙皮只导出静态网格，权重/骨骼不传。
                MeshFilter filter = go.GetComponent<MeshFilter>();
                SkinnedMeshRenderer skinned = go.GetComponent<SkinnedMeshRenderer>();
                Renderer renderer = skinned != null ? (Renderer)skinned : go.GetComponent<MeshRenderer>();
                Mesh mesh = skinned != null ? skinned.sharedMesh : (filter != null ? filter.sharedMesh : null);
                if (skinned != null) nodeLosses.Add("SKINNED_MESH_EXPORTED_STATIC: 蒙皮/骨骼未交换，只写绑定姿态网格");
                if (mesh != null)
                {
                    node.mesh = DescribeMesh(mesh, assetTypes, out nodeLosses);
                    if (options.exportMeshes && mesh.vertexCount > 0)
                    {
                        Material[] sourceMaterials = renderer != null ? renderer.sharedMaterials : new Material[0];
                        string fileName = string.Format(CultureInfo.InvariantCulture, "node-{0:D4}.glb", nodeIndex);
                        string target = Path.Combine(meshDirectory, fileName);
                        try
                        {
                            long bytes = GlbWriter.Write(target, mesh, sourceMaterials, mesh.name);
                            node.mesh.file = ProjectRelative(target);
                            node.mesh.fileSpace = "product-right-handed-z-up-meters";
                            node.mesh.fileBytes = bytes;
                            meshFiles++;
                        }
                        catch (Exception error)
                        {
                            nodeLosses.Add("MESH_EXPORT_FAILED: " + error.Message);
                        }
                    }
                }
                else if (go.GetComponent<Renderer>() != null)
                {
                    nodeLosses.Add("RENDERER_WITHOUT_MESH_SKIPPED: " + go.GetComponent<Renderer>().GetType().Name + " 没有可交换的网格");
                }

                if (renderer != null)
                {
                    var materials = new List<MaterialRecord>();
                    foreach (Material material in renderer.sharedMaterials)
                    {
                        if (material == null) { materials.Add(new MaterialRecord { name = "(missing)" }); continue; }
                        materials.Add(DescribeMaterial(material, nodeLosses, noteLoss, assetTypes, textureDirectory, textureFiles));
                    }
                    node.materials = materials.ToArray();
                }

                Light light = go.GetComponent<Light>();
                if (light != null) node.light = DescribeLight(light);
                Camera camera = go.GetComponent<Camera>();
                if (camera != null) node.camera = DescribeCamera(camera);
                Terrain terrain = go.GetComponent<Terrain>();
                if (terrain != null)
                {
                    node.terrain = DescribeTerrain(terrain, nodeIndex, documentPath, out nodeLosses);
                    // 地形与植被几何也走交付闭包（GLB，与网格节点同一约定）：产品的场景/Viewer 才真的看得见
                    // 地形起伏、贴图与树；只写侧车路径的话产品侧只有空组（63 的 §5 缺口）。
                    if (node.terrain != null && options.exportMeshes)
                    {
                        string terrainGlb = Path.Combine(meshDirectory, string.Format(CultureInfo.InvariantCulture, "node-{0:D4}-terrain.glb", nodeIndex));
                        ExportTerrain(terrain, node, terrainGlb, Path.GetDirectoryName(documentPath), textureDirectory, nodeLosses, ref meshFiles);
                    }
                }

                PrefabRecord prefab = DescribePrefab(go, assetTypes, nodeLosses);
                if (prefab != null) node.prefab = prefab;

                // 明确列出"没有交换"的东西：宁可写清楚，也不让调用方以为拿到的是完整场景。
                if (go.GetComponent<ParticleSystem>() != null) nodeLosses.Add("PARTICLES_NOT_TRANSFERRED: ParticleSystem 未交换");
                if (go.GetComponent<Animator>() != null || go.GetComponent<Animation>() != null) nodeLosses.Add("ANIMATION_NOT_TRANSFERRED: Animator/Animation 未交换");
                if (go.GetComponents<Collider>().Length > 0) nodeLosses.Add("COLLIDERS_NOT_TRANSFERRED: 碰撞体未交换（ENV-35 另行派生）");
                Rigidbody body = go.GetComponent<Rigidbody>();
                if (body != null) nodeLosses.Add("RIGIDBODY_NOT_TRANSFERRED: 刚体未交换");
                if (go.GetComponent<AudioSource>() != null) nodeLosses.Add("AUDIO_NOT_TRANSFERRED: AudioSource 未交换");
                foreach (Component component in go.GetComponents<Component>())
                {
                    if (component == null) continue;
                    string type = component.GetType().Name;
                    if (type == "LineRenderer" || type == "TrailRenderer" || type == "SpriteRenderer" || type == "CanvasRenderer" || type == "TextMesh")
                        nodeLosses.Add("RENDERER_TYPE_NOT_TRANSFERRED: " + type + " 未交换");
                }
                foreach (MonoBehaviour behaviour in go.GetComponents<MonoBehaviour>())
                {
                    if (behaviour == null || behaviour is LyapunovEntityIdentity) continue;
                    string script = behaviour.GetType().Name;
                    string asset = AssetDatabase.GetAssetPath(MonoScript.FromMonoBehaviour(behaviour));
                    nodeLosses.Add("SCRIPT_NOT_TRANSFERRED: " + script + (string.IsNullOrEmpty(asset) ? "" : " (" + asset + ")") + " 只保留在 Unity 侧，行为不进产品");
                }

                node.losses = nodeLosses.ToArray();
                // 写回（node 是引用类型：上面只改了 nodeLosses 的局部集合）
                nodes[nodeIndex] = node;

                foreach (Transform child in transform) walk(child, nodeIndex);
            };

            foreach (GameObject root in scene.GetRootGameObjects()) walk(root.transform, -1);

            // 资产清单在遍历后一次性成表：路径去重、可选哈希（hashAssets 打开时才算，避免无谓读全文件）。
            var assets = new List<AssetRecord>();
            foreach (KeyValuePair<string, string> entry in assetTypes.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            {
                string full = Path.GetFullPath(Path.Combine(ProjectRoot, entry.Key));
                bool exists = File.Exists(full);
                var asset = new AssetRecord
                {
                    index = assets.Count,
                    path = entry.Key,
                    guid = AssetDatabase.AssetPathToGUID(entry.Key),
                    type = entry.Value,
                    fileSize = exists ? new FileInfo(full).Length : 0,
                };
                if (options.hashAssets && exists) asset.sha256 = Sha256Of(full);
                assets.Add(asset);
            }

            document.nodes = nodes.ToArray();
            document.assets = assets.ToArray();
            document.environment = CaptureEnvironment(scene, textureDirectory, textureFiles, noteLoss);
            document.losses = losses.ToArray();
            Directory.CreateDirectory(Path.GetDirectoryName(documentPath));
            File.WriteAllText(documentPath, JsonUtility.ToJson(document, true));

            var payload = new ExportPayload
            {
                scenePath = document.scenePath,
                documentPath = documentPath,
                nodeCount = document.nodes.Length,
                rootCount = scene.GetRootGameObjects().Length,
                assetCount = document.assets.Length,
                meshFileCount = meshFiles,
                documentBytes = new FileInfo(documentPath).Length,
                losses = losses.ToArray(),
            };
            if (EditorApplication.isCompiling || EditorApplication.isUpdating)
                warnings.Add("EDITOR_BUSY: 导出期间编辑器在编译/刷新，读数可能落后一帧");
            return payload;
        }

        // ── 场景级环境：只换两边都有对应物的字段，其余逐条记损失 ────────────────────────────
        //
        // 对应关系（产品字段来自 45_environment_lighting 的 SceneEnvironment 合同）：
        //   environmentIntensity ↔ RenderSettings.reflectionIntensity（天空盒/IBL 反射强度）
        //   hemisphereIntensity  ↔ RenderSettings.ambientIntensity（环境补光强度）
        //   background/backgroundColor ↔ 场景相机的 clearFlags + backgroundColor
        //   sun (方位/仰角/强度) ↔ 场景里最亮的那盏方向光（按名字认领回写）
        //   shadows ↔ 该方向光的 Light.shadows（None↔false，其余↔true）
        // 产品有、Unity RenderSettings 没有对应物的（色调映射曝光、昼夜播放），以及 Unity 有、
        // 产品没有的（烘焙 GI/光照贴图、雾、反射探针、天空盒 shader、环境光探针模式），一律记损失。

        private static EnvironmentRecord CaptureEnvironment(Scene scene, string textureDirectory, Dictionary<string, string> textureFiles, Action<string, string> noteLoss)
        {
            var record = new EnvironmentRecord { present = true, losses = new string[0] };
            var losses = new List<string>();
            record.environmentIntensity = RenderSettings.reflectionIntensity;
            record.hemisphereIntensity = RenderSettings.ambientIntensity;
            record.ambientMode = RenderSettings.ambientMode.ToString();

            string cameraNote;
            Camera target = PrimaryCameraOf(scene, out cameraNote);
            if (!string.IsNullOrEmpty(cameraNote)) losses.Add(cameraNote);
            if (target != null)
            {
                Color background = target.backgroundColor;
                record.background = target.clearFlags == CameraClearFlags.SolidColor ? "color" : "environment";
                record.backgroundColor = "#" + ColorUtility.ToHtmlStringRGB(background);
                if (target.clearFlags != CameraClearFlags.SolidColor && target.clearFlags != CameraClearFlags.Skybox)
                    losses.Add("ENVIRONMENT_BACKGROUND_NOT_MAPPED: 相机 clearFlags=" + target.clearFlags + " 既不是纯色也不是天空盒，产品侧只表达 environment/color 两种");
            }
            else losses.Add("ENVIRONMENT_BACKGROUND_NOT_MAPPED: 场景里没有相机，背景没处取");

            // 太阳：同名方向光（文档带名字时）优先，否则**最亮**的方向光。
            // 没有方向光就明说（产品侧 sun 是必填字段，导入侧会按"没有对应灯"处理）。
            Light sun = PrimaryDirectionalLightOf(scene, "");
            if (sun != null)
            {
                Vector3 forward = sun.transform.forward;
                // 与 Viewer 的太阳几何同一约定：产品空间右手 Z-up，方位角自 +X 轴起绕 +Z，仰角自 XY 平面起
                // （方向＝光从太阳射向场景）。Unity 的 forward 先取反得到""光射向场景"的 Unity 方向，
                // 再过 **Unity→产品的轴交换**（(x,y,z) → (x,z,y)）才落回产品空间；这一步正是 ApplyEnvironment 的逆，
                // 少了它 Unity → 产品 → Unity 的方位角会被镜像成 180-az（真实踩过）。
                Vector3 unityDirection = new Vector3(-forward.x, -forward.y, -forward.z);
                var direction = new Vector3(unityDirection.x, unityDirection.z, unityDirection.y);
                record.sunAzimuthDeg = Mathf.Atan2(direction.y, direction.x) * Mathf.Rad2Deg;
                if (record.sunAzimuthDeg < 0f) record.sunAzimuthDeg += 360f;
                record.sunElevationDeg = Mathf.Asin(Mathf.Clamp(direction.z, -1f, 1f)) * Mathf.Rad2Deg;
                record.sunIntensity = sun.intensity;
                record.sunName = sun.gameObject.name;
                record.shadows = sun.shadows != LightShadows.None;
                if (sun.type == LightType.Directional && sun.transform.lossyScale != Vector3.one)
                    losses.Add("ENVIRONMENT_SUN_SCALE_IGNORED: 方向光 '" + sun.gameObject.name + "' 的缩放不参与太阳方向");
            }
            else losses.Add("ENVIRONMENT_SUN_NO_DIRECTIONAL_LIGHT: 场景里没有方向光，产品侧的 sun（方位/仰角/强度）没有对应物");

            // 天空盒：材质与主贴图。主贴图是真 HDRI（.hdr/.exr）时把字节也落一份（产品侧能当 HDRI 资源用）。
            Material skybox = RenderSettings.skybox;
            if (skybox != null)
            {
                record.skyboxPath = AssetDatabase.GetAssetPath(skybox) ?? "";
                record.skyboxShader = skybox.shader != null ? skybox.shader.name : "";
                Texture main = skybox.HasProperty("_MainTex") ? skybox.GetTexture("_MainTex") : null;
                if (main != null)
                {
                    string mainPath = AssetDatabase.GetAssetPath(main) ?? "";
                    string lower = mainPath.ToLowerInvariant();
                    if (lower.EndsWith(".hdr") || lower.EndsWith(".exr"))
                    {
                        string relative;
                        if (!textureFiles.TryGetValue("hdri:" + mainPath, out relative))
                        {
                            string full = Path.GetFullPath(Path.Combine(ProjectRoot, mainPath));
                            try
                            {
                                Directory.CreateDirectory(textureDirectory);
                                string hdriTarget = Path.Combine(textureDirectory, "hdri-" + Sha256Of(full).Substring(0, 8) + Path.GetExtension(mainPath));
                                File.Copy(full, hdriTarget, true);
                                relative = ProjectRelative(hdriTarget);
                                textureFiles["hdri:" + mainPath] = relative;
                            }
                            catch (Exception exception) { relative = ""; losses.Add("ENVIRONMENT_HDRI_COPY_FAILED: " + exception.Message); }
                        }
                        if (!string.IsNullOrEmpty(relative))
                        {
                            record.hdriFile = relative;
                            record.hdriAssetPath = mainPath;
                            record.hdriBytes = File.Exists(Path.GetFullPath(Path.Combine(ProjectRoot, relative))) ? new FileInfo(Path.GetFullPath(Path.Combine(ProjectRoot, relative))).Length : 0;
                        }
                    }
                    else if (!string.IsNullOrEmpty(mainPath))
                        losses.Add("ENVIRONMENT_SKYBOX_TEXTURE_NOT_HDRI: 天空盒主贴图 " + mainPath + " 不是 .hdr/.exr，产品侧的 HDRI 资源只接受这两种");
                }
            }
            else losses.Add("ENVIRONMENT_NO_SKYBOX: 场景没有天空盒材质，只有环境光强度可交换");

            if (RenderSettings.ambientMode == UnityEngine.Rendering.AmbientMode.Flat && RenderSettings.ambientLight == Color.black)
                losses.Add("ENVIRONMENT_AMBIENT_BLACK: 环境光是纯黑 Flat 模式，产品侧的环境强度/半球光表达不了这种组合");
            if (RenderSettings.fog) losses.Add("ENVIRONMENT_FOG_NOT_TRANSFERRED: 场景开了雾，产品侧没有雾字段");
            if (RenderSettings.defaultReflectionMode == UnityEngine.Rendering.DefaultReflectionMode.Custom)
                losses.Add("ENVIRONMENT_REFLECTION_PROBE_NOT_TRANSFERRED: 自定义反射（探针/自定义 cubemap）未交换");
            if (Lightmapping.lightingDataAsset != null || LightmapSettings.lightmaps != null && LightmapSettings.lightmaps.Length > 0)
                losses.Add("ENVIRONMENT_BAKED_LIGHTING_NOT_TRANSFERRED: 烘焙光照贴图/GI 未交换（产品侧没有烘焙数据）");
            losses.Add("ENVIRONMENT_EXPOSURE_NOT_TRANSFERRED: Unity 的色调映射曝光不在 RenderSettings（后处理 Volume 另说），产品侧 exposure 字段导入时不改 Unity 任何读数");
            losses.Add("ENVIRONMENT_DAYNIGHT_VIEWER_ONLY: 昼夜播放只存在于产品 Viewer 的渲染时钟，Unity 侧不跟着动（静态配置值会原样交换回来）");

            record.losses = losses.ToArray();
            foreach (string loss in losses) noteLoss(loss.Split(':')[0], loss.Substring(loss.IndexOf(':') + 1).Trim());
            return record;
        }

        /// <summary>场景主相机：depth 最大的那台（与 Viewer 的取景口径一致——背景/取景看的是它）。</summary>
        /// <summary>
        /// 场景级背景该写哪台相机：先认 Unity 自己的"主相机"（tag=MainCamera），没有就取 depth 最大的那台
        /// （并列时按层级顺序）。**多台相机时必须在回执里点名挑了哪台**：一个场景里两台相机（例如产品自己
        /// 带一台取景相机）时，"background 没生效"的真实原因往往只是改到了另一台上。
        /// </summary>
        private static Camera PrimaryCameraOf(Scene scene, out string note)
        {
            note = "";
            Camera tagged = null;
            var all = new List<Camera>();
            foreach (GameObject root in scene.GetRootGameObjects())
                foreach (Camera camera in root.GetComponentsInChildren<Camera>(true)) all.Add(camera);
            foreach (Camera camera in all)
            {
                if (camera.CompareTag("MainCamera")) { tagged = camera; break; }
            }
            Camera target = tagged;
            if (target == null) foreach (Camera camera in all)
            {
                if (target == null || camera.depth > target.depth) target = camera;
            }
            if (target != null && all.Count > 1)
                note = "ENVIRONMENT_CAMERA_CHOICE: 场景里有 " + all.Count.ToString(CultureInfo.InvariantCulture) + " 台相机，背景写在 '"
                    + target.gameObject.name + "'（" + (tagged != null ? "tag=MainCamera" : "depth 最大") + "），其余相机背景没动";
            return target;
        }

        private static Camera PrimaryCameraOf(Scene scene) { string ignored; return PrimaryCameraOf(scene, out ignored); }

        /// <summary>
        /// 场景里的"太阳"：给了名字就认这一盏（同一场景读→写往返时名字能对上），否则取**最亮的方向光**
        /// ——产品文档里的 sunName 常常是空的（产品不知道 Unity 灯叫什么），导入侧必须自己认领一盏并在
        /// 回执里写明给了哪一盏，用户才能核对。没有方向光返回 null（调用方负责说明）。
        /// </summary>
        private static Light PrimaryDirectionalLightOf(Scene scene, string preferName)
        {
            Light named = null, brightest = null;
            foreach (GameObject root in scene.GetRootGameObjects())
                foreach (Light light in root.GetComponentsInChildren<Light>(true))
                {
                    if (light.type != LightType.Directional) continue;
                    if (!string.IsNullOrEmpty(preferName) && light.gameObject.name == preferName) named = light;
                    if (brightest == null || light.intensity > brightest.intensity) brightest = light;
                }
            return named != null ? named : brightest;
        }

        /// <summary>
        /// 场景级环境回写（产品 → Unity）。映射与 CaptureEnvironment 是同一对、只有这几条：
        ///   environmentIntensity → RenderSettings.reflectionIntensity（IBL 强度）
        ///   hemisphereIntensity  → RenderSettings.ambientIntensity（环境补光）
        ///   background/backgroundColor → 主相机 clearFlags（color→SolidColor / environment→Skybox）+ backgroundColor
        ///   sun 方位/仰角/强度/阴影 → 方向光（同名优先，没名字按**最亮**认领并在回执里写明是哪一盏；都没有就新建一盏）
        /// 未交换的（曝光、昼夜播放、烘焙 GI、雾、反射探针、天空盒 shader/材质）只记损失；
        /// 不猜、不造通用渲染框架。
        /// </summary>
        private static void ApplyEnvironment(Scene scene, EnvironmentRecord environment, List<string> losses)
        {
            Action<string> note = line => { if (!losses.Contains(line)) losses.Add(line); };
            if (environment == null || !environment.present)
            {
                note("ENVIRONMENT_ABSENT_IN_DOCUMENT: 文档没有场景级环境读数，目标场景的 RenderSettings/相机背景保持原样");
                return;
            }
            RenderSettings.reflectionIntensity = Mathf.Clamp(environment.environmentIntensity, 0f, 8f);
            RenderSettings.ambientIntensity = Mathf.Clamp(environment.hemisphereIntensity, 0f, 8f);

            string background = "未动";
            string cameraNote;
            Camera camera = PrimaryCameraOf(scene, out cameraNote);
            if (!string.IsNullOrEmpty(cameraNote)) note(cameraNote);
            if (camera != null)
            {
                if (environment.background == "color")
                {
                    camera.clearFlags = CameraClearFlags.SolidColor;
                    Color color;
                    if (!string.IsNullOrEmpty(environment.backgroundColor) && ColorUtility.TryParseHtmlString(environment.backgroundColor, out color)) camera.backgroundColor = color;
                    background = camera.gameObject.name + " clearFlags=SolidColor backgroundColor=" + environment.backgroundColor;
                    if (string.IsNullOrEmpty(environment.backgroundColor)) note("ENVIRONMENT_BACKGROUND_COLOR_ABSENT: 文档说背景是纯色但没给颜色，只改了 clearFlags，颜色沿用相机现值");
                }
                else
                {
                    camera.clearFlags = CameraClearFlags.Skybox;
                    background = "clearFlags=Skybox";
                }
                EditorUtility.SetDirty(camera);
            }
            else note("ENVIRONMENT_CAMERA_MISSING: 目标场景里没有相机，背景没处写（环境强度照写）");

            Light sun = PrimaryDirectionalLightOf(scene, environment.sunName);
            string sunNote;
            bool createdSun = false;
            if (sun == null && environment.sunIntensity > 0f)
            {
                var host = new GameObject("Sun (Lyapunov Environment)");
                SceneManager.MoveGameObjectToScene(host, scene);
                sun = host.AddComponent<Light>();
                sun.type = LightType.Directional;
                createdSun = true;
            }
            if (sun != null)
            {
                float azimuth = environment.sunAzimuthDeg * Mathf.Deg2Rad;
                float elevation = Mathf.Clamp(environment.sunElevationDeg, -90f, 90f) * Mathf.Deg2Rad;
                // 产品空间是右手 Z-up：(cos el·cos az, cos el·sin az, sin el)，方向 = 光从太阳射向场景。
                // 写进 Unity 必须先过**产品→Unity 的轴交换**（(x,y,z) → (x,z,y)），否则"仰角"会落在 Unity 的
                // 水平轴上（真实症状：太阳从地底下往上照，Unity 场景只剩环境光）。
                // CaptureEnvironment 用同一个交换的逆读回来 —— 两处改一个就必须改另一个。
                var productDirection = new Vector3(Mathf.Cos(elevation) * Mathf.Cos(azimuth), Mathf.Cos(elevation) * Mathf.Sin(azimuth), Mathf.Sin(elevation));
                var unityDirection = new Vector3(productDirection.x, productDirection.z, productDirection.y);
                sun.transform.rotation = Quaternion.LookRotation(new Vector3(-unityDirection.x, -unityDirection.y, -unityDirection.z), Vector3.up);
                sun.intensity = Mathf.Clamp(environment.sunIntensity, 0f, 100f);
                sun.shadows = environment.shadows ? LightShadows.Soft : LightShadows.None;
                sunNote = "sun=" + sun.gameObject.name + "（" + (string.IsNullOrEmpty(environment.sunName) ? "文档没给灯名，按最亮的方向光认领" : "文档指定的同名方向光")
                    + "）方位 " + environment.sunAzimuthDeg.ToString("F2", CultureInfo.InvariantCulture)
                    + "° 仰角 " + environment.sunElevationDeg.ToString("F2", CultureInfo.InvariantCulture)
                    + "° 强度 " + environment.sunIntensity.ToString("F2", CultureInfo.InvariantCulture) + " 阴影=" + (environment.shadows ? "Soft" : "None");
                if (createdSun) note("ENVIRONMENT_SUN_CREATED: 场景里没有方向光，按文档新建 'Sun (Lyapunov Environment)'");
            }
            else sunNote = "sun=未动（文档 sunIntensity=" + environment.sunIntensity.ToString("F2", CultureInfo.InvariantCulture) + "，不改已有灯）";

            if (environment.sunIntensity > 0f && sun == null) sunNote = "sun=未应用";
            note("ENVIRONMENT_APPLIED: reflectionIntensity=" + RenderSettings.reflectionIntensity.ToString("F2", CultureInfo.InvariantCulture)
                + " ambientIntensity=" + RenderSettings.ambientIntensity.ToString("F2", CultureInfo.InvariantCulture)
                + " 背景(" + background + ") " + sunNote + "（来自文档环境读数，场景原值被覆盖）");
            // 文档自己列过的损失照样带回来：Unity 侧也没法表达它们。
            foreach (string loss in environment.losses ?? new string[0]) note("ENVIRONMENT_DOCUMENT_LOSS: " + loss);
        }

        private static MeshRecord DescribeMesh(Mesh mesh, Dictionary<string, string> assetTypes, out List<string> losses)
        {
            losses = new List<string>();
            string assetPath = AssetDatabase.GetAssetPath(mesh);
            if (!string.IsNullOrEmpty(assetPath)) assetTypes[assetPath] = "Mesh";
            Bounds bounds = mesh.bounds;
            bool hasUv = mesh.uv.Length == mesh.vertexCount && mesh.vertexCount > 0;
            var record = new MeshRecord
            {
                name = mesh.name,
                assetPath = assetPath ?? "",
                assetGuid = string.IsNullOrEmpty(assetPath) ? "" : AssetDatabase.AssetPathToGUID(assetPath),
                vertexCount = mesh.vertexCount,
                triangleCount = mesh.triangles.Length / 3,
                subMeshCount = mesh.subMeshCount,
                uvCount = hasUv ? mesh.uv.Length : 0,
                contentDigest = MeshContentDigest(mesh),
                boundsCenter = new[] { bounds.center.x, bounds.center.y, bounds.center.z },
                boundsSize = new[] { bounds.size.x, bounds.size.y, bounds.size.z },
                primitive = PrimitiveNameOf(mesh),
            };
            if (mesh.subMeshCount > 1)
                losses.Add("MULTI_SUBMESH: " + mesh.subMeshCount.ToString(CultureInfo.InvariantCulture) + " 个子网格按材质分别写成同一个 GLB 的多个 primitive（各自带材质）");
            if (!hasUv)
                losses.Add("UV_MISSING: 网格没有与顶点数一致的 UV，GLB 未写 TEXCOORD_0");
            if (mesh.blendShapeCount > 0)
                losses.Add("BLEND_SHAPES_NOT_TRANSFERRED: " + mesh.blendShapeCount.ToString(CultureInfo.InvariantCulture) + " 个混合形状未交换");
            return record;
        }

        // ── 内容摘要：网格"是不是同一份内容"的唯一判据（资产复用与派生都看它） ──────────────
        //
        // 为什么不用资产路径/GUID 之外的判据：GUID 只能回答"这个资产还在不在"，回答不了
        // "它还是不是这份几何"。导入侧拿产品交付的几何算同一个摘要，和候选资产算出来的比：
        // 相等才复用（MESH_ASSET_REUSED），不等就派生新资产并把两个摘要都写进回执
        // （MESH_ASSET_CONTENT_CHANGED），跨工程找不到资产同样派生（MESH_ASSET_MISSING）。
        // 数值按 1e-6 量化：轴交换是置换（逐位精确），但 UV 的 v=1-v 往返会差 1 ulp，
        // 量化阈值远低于任何可见的几何/贴图差异，且不放松"内容真变了就派生"。

        private const double DigestQuantum = 1e-6;

        /// <summary>把 double 量化成可跨语言复现的整数（四舍五入、远离零；不用银行家舍入）。</summary>
        internal static long Quantize(double value)
        {
            double scaled = value / DigestQuantum;
            return (long)Math.Truncate(scaled + (scaled >= 0 ? 0.5 : -0.5));
        }

        /// <summary>FNV-1a 64：跨语言实现简单、无外部依赖，只用来比对内容是否相同。</summary>
        internal static string DigestOf(IEnumerable<long> values)
        {
            ulong hash = 14695981039346656037UL;
            foreach (long value in values)
            {
                ulong bits = unchecked((ulong)value);
                for (int shift = 0; shift < 64; shift += 8)
                {
                    hash ^= (bits >> shift) & 0xFFUL;
                    hash = unchecked(hash * 1099511628211UL);
                }
            }
            return hash.ToString("x16", CultureInfo.InvariantCulture);
        }

        internal static string MeshContentDigest(Mesh mesh)
        {
            var values = new List<long> { mesh.vertexCount, mesh.subMeshCount, mesh.uv.Length };
            foreach (Vector3 vertex in mesh.vertices) { values.Add(Quantize(vertex.x)); values.Add(Quantize(vertex.y)); values.Add(Quantize(vertex.z)); }
            Vector3[] normals = mesh.normals;
            values.Add(normals.Length);
            foreach (Vector3 normal in normals) { values.Add(Quantize(normal.x)); values.Add(Quantize(normal.y)); values.Add(Quantize(normal.z)); }
            Vector2[] uvs = mesh.uv;
            foreach (Vector2 uv in uvs) { values.Add(Quantize(uv.x)); values.Add(Quantize(uv.y)); }
            for (int subMesh = 0; subMesh < Mathf.Max(1, mesh.subMeshCount); subMesh++)
            {
                int[] triangles = mesh.GetTriangles(subMesh);
                values.Add(triangles.Length);
                foreach (int triangle in triangles) values.Add(triangle);
            }
            return DigestOf(values);
        }

        /// <summary>Unity 内置基础网格识别（仅按名字，写错也不影响几何，只是提示调用方用原始体重建）。</summary>
        private static string PrimitiveNameOf(Mesh mesh)
        {
            if (mesh == null) return "";
            if (!string.IsNullOrEmpty(AssetDatabase.GetAssetPath(mesh))) return "";
            switch (mesh.name)
            {
                case "Cube": return "Cube";
                case "Sphere": return "Sphere";
                case "Capsule": return "Capsule";
                case "Cylinder": return "Cylinder";
                case "Plane": return "Plane";
                case "Quad": return "Quad";
                default: return "";
            }
        }

        /// <summary>一张贴图可以真的交付的字节（PNG/JPEG）+ 采样设置；拿不到字节就返回 false 并说明原因。</summary>
        internal sealed class TexturePayload
        {
            public byte[] bytes;
            public string mimeType = "";
            public bool reencoded;
            public int width;
            public int height;
            public string wrapMode = "";
            public string assetPath = "";
            public string assetGuid = "";
            public string contentDigest = "";
        }

        /// <summary>
        /// 取贴图字节：源资产本身就是 png/jpeg 时**原样复制**（不重编码、颜色逐位一致）；
        /// 其它格式（tga/psd/压缩纹理/程序化贴图）走一次 GPU 读取后编码成 PNG，并在回执里写明重编码。
        /// 两条路都拿不到（没有资产路径又没有可读像素）时返回 false —— 宁可报缺件，不写一张假图。
        /// </summary>
        internal static bool TryTexturePayload(Texture texture, out TexturePayload payload, out string error)
        {
            payload = null; error = "";
            if (texture == null) { error = "TEXTURE_NULL"; return false; }
            string assetPath = AssetDatabase.GetAssetPath(texture);
            byte[] bytes = null; string mime = ""; bool reencoded = false;
            string lower = (assetPath ?? "").ToLowerInvariant();
            if (lower.EndsWith(".png") || lower.EndsWith(".jpg") || lower.EndsWith(".jpeg"))
            {
                string full = Path.GetFullPath(Path.Combine(ProjectRoot, assetPath));
                try { bytes = File.ReadAllBytes(full); }
                catch (Exception exception) { error = "TEXTURE_READ_FAILED: " + exception.Message; return false; }
                mime = lower.EndsWith(".png") ? "image/png" : "image/jpeg";
            }
            else
            {
                Texture2D readable = ReadTexturePixels(texture);
                if (readable == null) { error = string.IsNullOrEmpty(assetPath) ? "TEXTURE_NOT_AN_ASSET" : "TEXTURE_UNREADABLE: " + assetPath; return false; }
                try { bytes = readable.EncodeToPNG(); } finally { UnityEngine.Object.DestroyImmediate(readable); }
                mime = "image/png"; reencoded = true;
            }
            payload = new TexturePayload
            {
                bytes = bytes, mimeType = mime, reencoded = reencoded,
                width = texture.width, height = texture.height,
                wrapMode = texture.wrapMode.ToString(),
                assetPath = assetPath ?? "", assetGuid = string.IsNullOrEmpty(assetPath) ? "" : AssetDatabase.AssetPathToGUID(assetPath),
                // 产品侧 encodeLpmesh 写的贴图摘要用的是同一个 ByteDigest（长度 + 每 97 字节一个样本），
                // 两边必须逐字一致：导入侧就是拿它判"资产里的贴图还是不是交付的这张"。
                contentDigest = ByteDigest(bytes),
            };
            return true;
        }

        /// <summary>把任意贴图读成可编码的 Texture2D（GPU 读取路径；失败返回 null）。</summary>
        private static Texture2D ReadTexturePixels(Texture texture)
        {
            try
            {
                int width = Mathf.Max(1, texture.width), height = Mathf.Max(1, texture.height);
                RenderTexture temporary = RenderTexture.GetTemporary(width, height, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
                RenderTexture previous = RenderTexture.active;
                try
                {
                    Graphics.Blit(texture, temporary);
                    RenderTexture.active = temporary;
                    var readable = new Texture2D(width, height, TextureFormat.RGBA32, false);
                    readable.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                    readable.Apply();
                    return readable;
                }
                finally { RenderTexture.active = previous; RenderTexture.ReleaseTemporary(temporary); }
            }
            catch { return null; }
        }

        private static MaterialRecord DescribeMaterial(Material material, List<string> nodeLosses, Action<string, string> noteLoss, Dictionary<string, string> assetTypes, string textureDirectory, Dictionary<string, string> textureFiles)
        {
            string assetPath = AssetDatabase.GetAssetPath(material);
            if (!string.IsNullOrEmpty(assetPath)) assetTypes[assetPath] = "Material";
            var record = new MaterialRecord
            {
                name = material.name,
                assetPath = assetPath ?? "",
                assetGuid = string.IsNullOrEmpty(assetPath) ? "" : AssetDatabase.AssetPathToGUID(assetPath),
                shader = material.shader != null ? material.shader.name : "",
            };
            Color color = material.HasProperty("_BaseColor") ? material.GetColor("_BaseColor")
                : material.HasProperty("_Color") ? material.GetColor("_Color")
                : Color.white;
            record.baseColor = new[] { color.r, color.g, color.b, color.a };
            if (material.HasProperty("_Metallic")) record.metallic = material.GetFloat("_Metallic");
            if (material.HasProperty("_Smoothness")) record.smoothness = material.GetFloat("_Smoothness");
            else if (material.HasProperty("_Glossiness")) record.smoothness = material.GetFloat("_Glossiness");

            var textures = new List<string>();
            var textureRecords = new List<TextureRecord>();
            foreach (string property in material.GetTexturePropertyNames())
            {
                Texture texture = material.GetTexture(property);
                if (texture == null) continue;
                string path = AssetDatabase.GetAssetPath(texture);
                textures.Add(property + "=" + (string.IsNullOrEmpty(path) ? texture.name : path));
                TexturePayload payload;
                string error;
                if (!TryTexturePayload(texture, out payload, out error))
                {
                    nodeLosses.Add("MATERIAL_TEXTURE_NOT_EMBEDDED: " + material.name + "." + property + " → " + (string.IsNullOrEmpty(path) ? texture.name : path) + "（" + error + "，只留引用不复制字节）");
                    continue;
                }
                if (!string.IsNullOrEmpty(payload.assetPath)) assetTypes[payload.assetPath] = "Texture";
                string relative;
                if (!textureFiles.TryGetValue(payload.contentDigest, out relative))
                {
                    string extension = payload.mimeType == "image/png" ? ".png" : ".jpg";
                    string target = Path.Combine(textureDirectory, Sanitize(material.name) + "-" + property.TrimStart('_') + "-" + payload.contentDigest.Substring(0, 8) + extension);
                    WriteDeliverable(target, payload.bytes);
                    relative = ProjectRelative(target);
                    textureFiles[payload.contentDigest] = relative;
                }
                textureRecords.Add(new TextureRecord
                {
                    property = property, assetPath = payload.assetPath, assetGuid = payload.assetGuid,
                    file = relative, mimeType = payload.mimeType, bytes = payload.bytes.Length,
                    width = payload.width, height = payload.height, wrapMode = payload.wrapMode,
                    contentDigest = payload.contentDigest, reencoded = payload.reencoded,
                });
                nodeLosses.Add("MATERIAL_TEXTURE_EMBEDDED: " + material.name + "." + property + " → " + relative + "（" + payload.bytes.Length.ToString(CultureInfo.InvariantCulture) + " 字节 " + payload.mimeType + (payload.reencoded ? "，源格式重编码为 PNG" : "，原字节复制") + "）");
            }
            record.textures = textures.ToArray();
            record.textureFiles = textureRecords.ToArray();
            if (material.mainTexture != null && (material.mainTextureScale != Vector2.one || material.mainTextureOffset != Vector2.zero))
                nodeLosses.Add("MATERIAL_TEXTURE_TILING_NOT_TRANSFERRED: " + material.name + " 的贴图缩放/偏移 " + material.mainTextureScale.ToString("F2") + "/" + material.mainTextureOffset.ToString("F2") + " 未交换（glTF 侧没有对应的最小子集）");
            if (!string.IsNullOrEmpty(assetPath)) noteLoss("MATERIAL_ASSET_REFERENCE", material.name + " 只交换资产引用（" + assetPath + "），材质字节不复制");
            return record;
        }

        private static LightRecord DescribeLight(Light light)
        {
            Vector2 area = Vector2.zero;
            try { area = light.areaSize; } catch { /* 旧版本没有该属性 */ }
            return new LightRecord
            {
                type = light.type.ToString(),
                color = new[] { light.color.r, light.color.g, light.color.b, light.color.a },
                intensity = light.intensity,
                range = light.range,
                spotAngleDeg = light.spotAngle,
                areaSize = new[] { area.x, area.y },
                shadows = light.shadows.ToString(),
                bounceIntensity = light.bounceIntensity,
                enabled = light.enabled,
            };
        }

        private static CameraRecord DescribeCamera(Camera camera)
        {
            return new CameraRecord
            {
                fieldOfViewDeg = camera.fieldOfView,
                nearClip = camera.nearClipPlane,
                farClip = camera.farClipPlane,
                orthographic = camera.orthographic,
                orthographicSize = camera.orthographicSize,
                depth = camera.depth,
                clearFlags = camera.clearFlags.ToString(),
                background = new[] { camera.backgroundColor.r, camera.backgroundColor.g, camera.backgroundColor.b, camera.backgroundColor.a },
                enabled = camera.enabled,
            };
        }

        private static PrefabRecord DescribePrefab(GameObject go, Dictionary<string, string> assetTypes, List<string> nodeLosses)
        {
            PrefabInstanceStatus status = PrefabUtility.GetPrefabInstanceStatus(go);
            if (status == PrefabInstanceStatus.NotAPrefab) return null;
            GameObject source = PrefabUtility.GetCorrespondingObjectFromSource(go);
            string path = source != null ? AssetDatabase.GetAssetPath(source) : "";
            var record = new PrefabRecord
            {
                status = status.ToString(),
                assetPath = path ?? "",
                assetGuid = string.IsNullOrEmpty(path) ? "" : AssetDatabase.AssetPathToGUID(path),
                isOutermost = PrefabUtility.IsOutermostPrefabInstanceRoot(go),
            };
            if (!string.IsNullOrEmpty(path))
            {
                assetTypes[path] = "Prefab";
                nodeLosses.Add("PREFAB_FLATTENED: " + go.name + " 是 Prefab 实例（" + path + "），交换保留资产引用与展开后的节点树，不保留实例链接/覆盖关系");
            }
            return record;
        }

        private static TerrainRecord DescribeTerrain(Terrain terrain, int nodeIndex, string documentPath, out List<string> nodeLosses)
        {
            nodeLosses = new List<string>();
            TerrainData data = terrain.terrainData;
            if (data == null) { nodeLosses.Add("TERRAIN_DATA_MISSING: Terrain 没有 TerrainData"); return null; }
            var record = new TerrainRecord
            {
                widthM = data.size.x,
                heightM = data.size.y,
                lengthM = data.size.z,
                heightmapResolution = data.heightmapResolution,
                alphamapLayers = data.alphamapLayers,
                treeInstanceCount = data.treeInstanceCount,
            };
            string sidecarDirectory = Path.Combine(Path.GetDirectoryName(documentPath), "terrain");
            Directory.CreateDirectory(sidecarDirectory);
            float[,] heights = data.GetHeights(0, 0, data.heightmapResolution, data.heightmapResolution);
            string heightsPath = Path.Combine(sidecarDirectory, string.Format(CultureInfo.InvariantCulture, "heights-{0:D4}.f32", nodeIndex));
            float min = float.MaxValue, max = float.MinValue;
            string heightsStaging = StagingPath(heightsPath);
            using (FileStream stream = File.Create(heightsStaging))
            using (BinaryWriter writer = new BinaryWriter(stream))
            {
                for (int y = 0; y < data.heightmapResolution; y++)
                    for (int x = 0; x < data.heightmapResolution; x++)
                    {
                        float value = heights[y, x];
                        if (value < min) min = value;
                        if (value > max) max = value;
                        writer.Write(value);   // 归一化高度（0..1）× size.y = 米
                    }
            }
            CommitStagedFile(heightsStaging, heightsPath);
            record.heightsFile = ProjectRelative(heightsPath);
            record.heightsBytes = new FileInfo(heightsPath).Length;
            record.minHeight = min;
            record.maxHeight = max;

            var prototypes = new List<TreePrototypeRecord>();
            foreach (TreePrototype prototype in data.treePrototypes)
            {
                string path = prototype != null && prototype.prefab != null ? AssetDatabase.GetAssetPath(prototype.prefab) : "";
                prototypes.Add(new TreePrototypeRecord
                {
                    prefabPath = path ?? "",
                    prefabGuid = string.IsNullOrEmpty(path) ? "" : AssetDatabase.AssetPathToGUID(path),
                    bendFactor = prototype == null ? 0f : prototype.bendFactor,
                });
            }
            record.treePrototypes = prototypes.ToArray();
            var list = new List<TreeInstanceRecord>();
            if (data.treeInstanceCount > 0)
            {
                var file = new TreeInstanceFile();
                for (int index = 0; index < data.treeInstanceCount; index++)
                {
                    TreeInstance instance = data.GetTreeInstance(index);
                    Color32 treeColor = instance.color;   // TreeInstance.color 是 Color32：按 0..1 归一化后再交换
                    list.Add(new TreeInstanceRecord
                    {
                        position = new[] { instance.position.x, instance.position.y, instance.position.z },
                        widthScale = instance.widthScale,
                        heightScale = instance.heightScale,
                        rotationRad = instance.rotation,
                        color = new[] { treeColor.r / 255f, treeColor.g / 255f, treeColor.b / 255f, treeColor.a / 255f },
                        prototypeIndex = instance.prototypeIndex,
                    });
                }
                file.instances = list.ToArray();
                string treesPath = Path.Combine(sidecarDirectory, string.Format(CultureInfo.InvariantCulture, "trees-{0:D4}.json", nodeIndex));
                WriteDeliverable(treesPath, Encoding.UTF8.GetBytes(JsonUtility.ToJson(file, true)));
                record.treesFile = ProjectRelative(treesPath);
            }
            // 内联一份进记录：产品读的是这一份（侧车文件在 Unity 工程里，搬家后就没了）。
            // **总是**写（空数组 = 真的没有树），并置"权威"位：写回侧只在这位置位时才动 treeInstances。
            record.instances = list.ToArray();
            record.treeInstancesAuthoritative = true;
            // 侧车只是调试副本：真交付见 ExportTerrain（GLB 网格 + 内嵌烘焙贴图 + 逐原型共享植被几何）。
            nodeLosses.Add("TERRAIN_HEIGHTS_SIDECAR: 高度图另存了一份原始 float32 在 " + record.heightsFile + "（工程内，调试用；产品侧的交付是网格顶点）");
            if (data.alphamapLayers > 0) nodeLosses.Add("TERRAIN_LAYERS_NOT_TRANSFERRED: " + data.alphamapLayers.ToString(CultureInfo.InvariantCulture) + " 个地形层的层列表本身不交换（看到的是按 alphamap 烘焙的等价漫反射；法线/遮罩/逐层 smoothness 不交付，见 TERRAIN_LAYER_* 损失）");
            return record;
        }

        // ── 地形交付闭包：网格 + 层混合烘焙贴图 + 逐原型共享植被几何 ──────────────────
        //
        // 63 的实测缺口是"Unity 里看得见、产品里只有空组"：高度图只落在工程内的侧车文件里，
        // 产品文档只有尺寸/分辨率与树实例**计数**。这里把高度真的变成**网格顶点**（float32 原值，
        // 不经任何模型导入器），把 alphamap × 层贴图烘成一张等价漫反射贴图内嵌进 GLB，把每个被用到的
        // 树原型 prefab 的几何写成**一份共享** GLB（实例只写位置/旋转/缩放，不逐树复制素材）。
        // 全部落在交换 scratch 目录（相对工程根）：产品导入后进它自己的资源库，搬走产品数据目录仍可用，
        // 不依赖 Unity Library 的绝对路径。
        private static void ExportTerrain(Terrain terrain, NodeRecord node, string glbPath, string documentDirectory, string textureDirectory, List<string> nodeLosses, ref int meshFiles)
        {
            TerrainData data = terrain.terrainData;
            TerrainRecord record = node.terrain;
            if (data == null || record == null) return;
            int resolution = Mathf.Max(2, data.heightmapResolution);
            float[,] heights = data.GetHeights(0, 0, resolution, resolution);
            // 孔洞（挖掉的格子）：这些格子**不生成三角形**，产品看到的是同一块缺口（不是补上的面）。
            // 真机实测（109 probe-holes-api.ts，Unity 6000.3.24f1）：GetHoles 的布尔值是"**有地面**"，
            // 不是"是孔洞"——从没调过 SetHoles 的新 TerrainData 读回来是整张 true；SetHoles 里给 false
            // 的格子才是孔，且索引是 [x=column, z=row]。按"true 即孔"写会把整块地形当成孔（网格空）。
            bool[,] coverage = null;
            try { coverage = data.GetHoles(0, 0, resolution - 1, resolution - 1); }
            catch (Exception error) { nodeLosses.Add("TERRAIN_HOLES_UNREADABLE: " + error.Message + "（本次按无孔交付）"); }
            int holeCells = 0;
            if (coverage != null) foreach (bool solid in coverage) if (!solid) holeCells++;
            record.holeCellCount = holeCells;

            float sizeX = data.size.x, sizeY = data.size.y, sizeZ = data.size.z;
            var vertices = new Vector3[resolution * resolution];
            var normals = new Vector3[resolution * resolution];
            var uvs = new Vector2[resolution * resolution];
            for (int row = 0; row < resolution; row++)
                for (int column = 0; column < resolution; column++)
                {
                    int index = row * resolution + column;
                    float u = (float)column / (resolution - 1);
                    float v = (float)row / (resolution - 1);
                    vertices[index] = new Vector3(u * sizeX, heights[row, column] * sizeY, v * sizeZ);
                    // 法线用 Unity 自己的插值法线（与地形渲染一致），不是自己差分出来的近似。
                    Vector3 normal = data.GetInterpolatedNormal(u, v);
                    normals[index] = normal.sqrMagnitude > 1e-12f ? normal.normalized : Vector3.up;
                    uvs[index] = new Vector2(u, v);
                }
            var triangles = new List<int>();
            int holeCellsSkipped = 0;
            for (int row = 0; row + 1 < resolution; row++)
                for (int column = 0; column + 1 < resolution; column++)
                {
                    // 孔洞图的索引是 [x=column, z=row]（与高度图的 [row=z, column=x] 转置）；false = 孔。
                    if (coverage != null && column < coverage.GetLength(0) && row < coverage.GetLength(1) && !coverage[column, row]) { holeCellsSkipped++; continue; }
                    int a = row * resolution + column;
                    int b = a + 1;
                    int c = a + resolution + 1;
                    int d = a + resolution;
                    // 绕序：GlbWriter 把顶点 (x,y,z) 写成产品空间 (x,z,y)（一次镜像）并**反转每个三角形的绕序**来抵消镜像，
                    // 所以这里给的是 Unity 自己的三角形顺序，落盘后就是产品侧的正面。
                    // 真机实测（109 的 audit-turn.ts 量交付 GLB）：按 (a,b,c)/(a,c,d) 发时 32768/32768 个三角形的几何法线
                    // 与顶点法线**反向**——产品侧是 glTF 右手系、CCW 为正面、默认背面剔除，看过去整块地形被剔掉，
                    // 画面里只剩悬空的树和参考网格。正确的是 (a,c,b)/(a,d,c)：GlbWriter 反转后落成 (a,b,c)/(a,c,d)，
                    // 几何法线指向高度轴正向（产品 z 朝上），与 GetInterpolatedNormal 的顶点法线同向。
                    triangles.Add(a); triangles.Add(c); triangles.Add(b);
                    triangles.Add(a); triangles.Add(d); triangles.Add(c);
                }
            if (triangles.Count == 0) { nodeLosses.Add("TERRAIN_MESH_EMPTY: 地形的格子全是孔洞，没有网格可交付"); return; }
            var mesh = new Mesh { name = (string.IsNullOrEmpty(node.name) ? "Terrain" : node.name) + " 地形网格" };
            mesh.indexFormat = vertices.Length > 65000 ? UnityEngine.Rendering.IndexFormat.UInt32 : UnityEngine.Rendering.IndexFormat.UInt16;
            mesh.vertices = vertices;
            mesh.normals = normals;
            mesh.uv = uvs;
            mesh.subMeshCount = 1;
            mesh.SetTriangles(triangles, 0);
            mesh.RecalculateBounds();

            Texture2D baked = BakeTerrainBlend(data, nodeLosses, out string bakeLoss);
            Material temporary = null;
            try
            {
                Material[] materials = new Material[0];
                if (baked != null)
                {
                    Shader shader = Shader.Find("Unlit/Texture");
                    if (shader == null) shader = Shader.Find("Standard");
                    temporary = new Material(shader);
                    temporary.name = (string.IsNullOrEmpty(node.name) ? "Terrain" : node.name) + " 层混合";
                    temporary.mainTexture = baked;   // 基色白 × 贴图 = 等价漫反射（颜色已经在烘焙里乘过）
                    materials = new[] { temporary };
                }
                long bytes = GlbWriter.Write(glbPath, mesh, materials, mesh.name);
                meshFiles++;
                string relative = ProjectRelative(glbPath);
                record.meshResolution = resolution;
                record.meshFile = relative;
                record.meshFileSpace = "product-right-handed-z-up-meters";
                record.meshBytes = bytes;
                record.meshVertexCount = vertices.Length;
                record.meshTriangleCount = triangles.Count / 3;
                node.mesh = new MeshRecord
                {
                    name = mesh.name,
                    primitive = "",
                    assetPath = "",
                    assetGuid = "",
                    vertexCount = vertices.Length,
                    triangleCount = triangles.Count / 3,
                    subMeshCount = 1,
                    uvCount = vertices.Length,
                    contentDigest = "",   // 交付网格是生成的，不参与"资产身份复用"（写回走 ApplyTerrain，不建网格资产）
                    boundsCenter = new[] { mesh.bounds.center.x, mesh.bounds.center.y, mesh.bounds.center.z },
                    boundsSize = new[] { mesh.bounds.size.x, mesh.bounds.size.y, mesh.bounds.size.z },
                    file = relative,
                    fileSpace = record.meshFileSpace,
                    fileBytes = bytes,
                };
                nodeLosses.Add("TERRAIN_MESH_DELIVERED: " + resolution.ToString(CultureInfo.InvariantCulture) + "×" + resolution.ToString(CultureInfo.InvariantCulture)
                    + " 格点、" + (triangles.Count / 3).ToString(CultureInfo.InvariantCulture) + " 个三角形、" + vertices.Length.ToString(CultureInfo.InvariantCulture)
                    + " 个顶点（顶点 y = 归一化高度 × " + sizeY.ToString("R", CultureInfo.InvariantCulture) + " 米，float32 原值）→ " + relative
                    + "（" + bytes.ToString(CultureInfo.InvariantCulture) + " 字节，" + record.meshFileSpace + "，产品导入后进自己的资源库）");
                if (holeCells > 0) nodeLosses.Add("TERRAIN_HOLES_PRESERVED: " + holeCells.ToString(CultureInfo.InvariantCulture) + " 个格子是孔洞（" + holeCellsSkipped.ToString(CultureInfo.InvariantCulture) + " 格未生成三角形），产品侧看到的是同一块缺口");

                // 烘焙贴图的可寻址副本（GLB 里已内嵌同一份字节）：产品把图片登记成自己的资源，
                // 材质记录里给出这一份的路径/摘要/尺寸，产品侧要单独用图（例如另建材质）时有东西可用。
                if (baked != null)
                {
                    TexturePayload payload;
                    string payloadError;
                    if (!TryTexturePayload(baked, out payload, out payloadError))
                        nodeLosses.Add("TERRAIN_TEXTURE_PAYLOAD_FAILED: " + payloadError + "（GLB 内仍可能带图，产品侧只有内嵌那份）");
                    else
                    {
                        string textureTarget = Path.Combine(textureDirectory, Sanitize(string.IsNullOrEmpty(node.name) ? "Terrain" : node.name) + "-blend-" + payload.contentDigest.Substring(0, 8) + ".png");
                        WriteDeliverable(textureTarget, payload.bytes);
                        string textureRelative = ProjectRelative(textureTarget);
                        record.textureFile = textureRelative;
                        record.textureDigest = payload.contentDigest;
                        record.textureWidth = payload.width;
                        record.textureHeight = payload.height;
                        node.materials = new[]
                        {
                            new MaterialRecord
                            {
                                name = (string.IsNullOrEmpty(node.name) ? "Terrain" : node.name) + " 层混合（烘焙）",
                                assetPath = "", assetGuid = "",
                                shader = "Terrain/LayerBlend(baked)",
                                baseColor = new[] { 1f, 1f, 1f, 1f }, metallic = 0f, smoothness = 0.5f,
                                textures = new[] { "_MainTex=alphamap × " + data.alphamapLayers.ToString(CultureInfo.InvariantCulture) + " 层漫反射的等价烘焙" },
                                textureFiles = new[]
                                {
                                    new TextureRecord
                                    {
                                        property = "_MainTex", assetPath = "", assetGuid = "", file = textureRelative,
                                        mimeType = payload.mimeType, bytes = payload.bytes.Length, width = payload.width, height = payload.height,
                                        wrapMode = payload.wrapMode, contentDigest = payload.contentDigest, reencoded = payload.reencoded,
                                    },
                                },
                            },
                        };
                        nodeLosses.Add("TERRAIN_TEXTURE_DELIVERED: 等价漫反射贴图 " + payload.width.ToString(CultureInfo.InvariantCulture) + "×"
                            + payload.height.ToString(CultureInfo.InvariantCulture) + "（" + payload.bytes.Length.ToString(CultureInfo.InvariantCulture) + " 字节 "
                            + payload.mimeType + "，摘要 " + payload.contentDigest + "）→ " + textureRelative + "，同一份字节内嵌在 " + relative + " 里");
                    }
                }
            }
            finally
            {
                if (temporary != null) UnityEngine.Object.DestroyImmediate(temporary);
                if (baked != null) UnityEngine.Object.DestroyImmediate(baked);
                UnityEngine.Object.DestroyImmediate(mesh);
            }

            // 烘焙贴图的可寻址副本（GLB 里已内嵌一份；这一份给产品当资源登记，摘要是同一份字节）。
            if (!string.IsNullOrEmpty(bakeLoss)) nodeLosses.Add(bakeLoss);
            ExportTreePrototypes(data, record, documentDirectory, nodeLosses, ref meshFiles);
        }

        /** 层混合 → 一张等价漫反射贴图：逐纹素 Σ(alphamap 权重 × 层贴图按 tiling/offset 采样)，再归一化。 */
        private static Texture2D BakeTerrainBlend(TerrainData data, List<string> nodeLosses, out string note)
        {
            note = "";
            TerrainLayer[] layers = data.terrainLayers;
            if (layers == null || layers.Length == 0)
            {
                note = "TERRAIN_NO_LAYERS: 源地形没有 TerrainLayer（本来就没贴图），交付的是带法线的网格 + 纯白基色，没有伪造贴图";
                return null;
            }
            const int size = 256;
            int alphaWidth = Mathf.Max(1, data.alphamapWidth), alphaHeight = Mathf.Max(1, data.alphamapHeight);
            float[,,] alpha = data.GetAlphamaps(0, 0, alphaWidth, alphaHeight);
            var sources = new Texture2D[layers.Length];
            var created = new List<Texture2D>();
            for (int index = 0; index < layers.Length; index++)
            {
                TerrainLayer layer = layers[index];
                if (layer == null) { note = AppendNote(note, "TERRAIN_LAYER_MISSING: 第 " + index.ToString(CultureInfo.InvariantCulture) + " 层是空引用（按白色记）"); continue; }
                if (layer.diffuseTexture == null)
                {
                    note = AppendNote(note, "TERRAIN_LAYER_NO_DIFFUSE_TEXTURE: 第 " + index.ToString(CultureInfo.InvariantCulture) + " 层没有漫反射贴图（按白色记）");
                }
                else
                {
                    sources[index] = ReadTexturePixels(layer.diffuseTexture);
                    if (sources[index] == null)
                        note = AppendNote(note, "TERRAIN_LAYER_TEXTURE_UNREADABLE: 第 " + index.ToString(CultureInfo.InvariantCulture) + " 层的漫反射贴图读不出来（按白色记）");
                    else created.Add(sources[index]);
                    if (layer.diffuseTexture.wrapMode != TextureWrapMode.Repeat)
                        note = AppendNote(note, "TERRAIN_LAYER_WRAP_NOT_REPEAT: 第 " + index.ToString(CultureInfo.InvariantCulture) + " 层的贴图 wrap=" + layer.diffuseTexture.wrapMode + "，烘焙按重复采样");
                }
                if (layer.normalMapTexture != null) note = AppendNote(note, "TERRAIN_LAYER_NORMALS_NOT_TRANSFERRED: 第 " + index.ToString(CultureInfo.InvariantCulture) + " 层的法线贴图未交付（烘焙只有漫反射）");
                if (layer.maskMapTexture != null) note = AppendNote(note, "TERRAIN_LAYER_MASK_NOT_TRANSFERRED: 第 " + index.ToString(CultureInfo.InvariantCulture) + " 层的遮罩贴图未交付");
                if (layer.metallic > 0.001f || Mathf.Abs(layer.smoothness - 0.5f) > 0.001f)
                    note = AppendNote(note, "TERRAIN_LAYER_METALLIC_SMOOTHNESS_NOT_TRANSFERRED: 第 " + index.ToString(CultureInfo.InvariantCulture)
                        + " 层的 metallic=" + layer.metallic.ToString("R", CultureInfo.InvariantCulture) + "/smoothness=" + layer.smoothness.ToString("R", CultureInfo.InvariantCulture) + " 未交付（产品侧是漫反射基色+固定粗糙度）");
            }
            try
            {
                var texture = new Texture2D(size, size, TextureFormat.RGBA32, false);
                var pixels = new Color[size * size];
                for (int y = 0; y < size; y++)
                    for (int x = 0; x < size; x++)
                    {
                        float u = (x + 0.5f) / size, v = (y + 0.5f) / size;
                        int alphaX = Mathf.Clamp((int)(u * alphaWidth), 0, alphaWidth - 1);
                        int alphaY = Mathf.Clamp((int)(v * alphaHeight), 0, alphaHeight - 1);
                        Color sum = Color.black;
                        float weightTotal = 0f;
                        for (int index = 0; index < layers.Length; index++)
                        {
                            float weight = alpha[alphaY, alphaX, index];
                            if (weight <= 0.0005f) continue;
                            weightTotal += weight;
                            TerrainLayer layer = layers[index];
                            Color value = Color.white;
                            if (sources[index] != null && layer != null)
                            {
                                float tileX = layer.tileSize.x > 0.01f ? layer.tileSize.x : Mathf.Max(0.01f, data.size.x);
                                float tileZ = layer.tileSize.y > 0.01f ? layer.tileSize.y : Mathf.Max(0.01f, data.size.z);
                                value = sources[index].GetPixelBilinear(u * data.size.x / tileX + layer.tileOffset.x, v * data.size.z / tileZ + layer.tileOffset.y);
                            }
                            sum += value * weight;
                        }
                        if (weightTotal > 0f) sum /= weightTotal;
                        sum.a = 1f;
                        pixels[y * size + x] = sum;
                    }
                texture.SetPixels(pixels);
                texture.Apply(false, false);
                note = AppendNote(note, "TERRAIN_LAYER_BLEND_BAKED: " + layers.Length.ToString(CultureInfo.InvariantCulture) + " 个层的漫反射按 "
                    + alphaWidth.ToString(CultureInfo.InvariantCulture) + "×" + alphaHeight.ToString(CultureInfo.InvariantCulture) + " alphamap 烘成一张 "
                    + size.ToString(CultureInfo.InvariantCulture) + "×" + size.ToString(CultureInfo.InvariantCulture)
                    + " 等价贴图（tiling/offset 已烘进去；混合在 sRGB 编码值上做，不是线性光空间）");
                return texture;
            }
            finally
            {
                foreach (Texture2D source in created) UnityEngine.Object.DestroyImmediate(source);
            }
        }

        private static string AppendNote(string existing, string line)
        {
            return string.IsNullOrEmpty(existing) ? line : existing + " | " + line;
        }

        /**
         * 逐原型交付植被几何：**一个原型一份 GLB**（不是逐树复制素材）。
         * 几何在 prefab 根对象的局部空间里合并（子对象变换折进去），子网格与材质槽保持一一对应；
         * 实例只交付位置/旋转/缩放（TreeInstance 记录），产品侧共享同一份资源。
         */
        private static void ExportTreePrototypes(TerrainData data, TerrainRecord record, string documentDirectory, List<string> nodeLosses, ref int meshFiles)
        {
            TreeInstanceRecord[] instances = record.instances ?? new TreeInstanceRecord[0];
            if (instances.Length == 0) return;
            var used = new HashSet<int>();
            foreach (TreeInstanceRecord instance in instances) used.Add(instance.prototypeIndex);
            string directory = Path.Combine(documentDirectory, "vegetation");
            foreach (int prototypeIndex in used)
            {
                if (prototypeIndex < 0 || prototypeIndex >= record.treePrototypes.Length) { nodeLosses.Add("TREE_PROTOTYPE_INDEX_OUT_OF_RANGE: " + prototypeIndex.ToString(CultureInfo.InvariantCulture)); continue; }
                TreePrototypeRecord prototype = record.treePrototypes[prototypeIndex];
                if (string.IsNullOrEmpty(prototype.prefabPath)) { prototype.meshError = "原型没有 prefab 资产路径（实例仍按数据交换）"; continue; }
                GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prototype.prefabPath);
                if (prefab == null) { prototype.meshError = "PREFAB_ASSET_MISSING: " + prototype.prefabPath; continue; }
                string note;
                Material[] materials;
                try
                {
                    Mesh merged = MergePrefabMesh(prefab, out materials, out note);
                    try
                    {
                        Directory.CreateDirectory(directory);
                        string target = Path.Combine(directory, string.Format(CultureInfo.InvariantCulture, "prototype-{0:D2}.glb", prototypeIndex));
                        long bytes = GlbWriter.Write(target, merged, materials, merged.name);
                        meshFiles++;
                        prototype.meshFile = ProjectRelative(target);
                        prototype.meshBytes = bytes;
                        prototype.vertexCount = merged.vertexCount;
                        prototype.triangleCount = merged.GetTriangles(0).Length / 3;   // 占位，下面按子网格累加
                        int triangles = 0;
                        for (int subMesh = 0; subMesh < merged.subMeshCount; subMesh++) triangles += merged.GetTriangles(subMesh).Length / 3;
                        prototype.triangleCount = triangles;
                        prototype.subMeshCount = merged.subMeshCount;
                        prototype.materialCount = materials.Length;
                        prototype.meshError = "";
                        nodeLosses.Add("TERRAIN_TREE_PROTOTYPE_DELIVERED: 原型 " + prototypeIndex.ToString(CultureInfo.InvariantCulture) + "（" + prototype.prefabPath
                            + "）几何交付为 " + prototype.meshFile + "（" + merged.vertexCount.ToString(CultureInfo.InvariantCulture) + " 顶点、"
                            + triangles.ToString(CultureInfo.InvariantCulture) + " 三角形、" + merged.subMeshCount.ToString(CultureInfo.InvariantCulture) + " 子网格、"
                            + materials.Length.ToString(CultureInfo.InvariantCulture) + " 材质，一份几何给 "
                            + CountInstances(instances, prototypeIndex).ToString(CultureInfo.InvariantCulture) + " 个实例共用）");
                        if (!string.IsNullOrEmpty(note)) nodeLosses.Add(note);
                    }
                    finally { UnityEngine.Object.DestroyImmediate(merged); }
                }
                catch (Exception error) { prototype.meshError = error.Message; nodeLosses.Add("TERRAIN_TREE_PROTOTYPE_EXPORT_FAILED: 原型 " + prototypeIndex.ToString(CultureInfo.InvariantCulture) + "（" + prototype.prefabPath + "）：" + error.Message); }
            }
        }

        private static int CountInstances(TreeInstanceRecord[] instances, int prototypeIndex)
        {
            int count = 0;
            foreach (TreeInstanceRecord instance in instances) if (instance.prototypeIndex == prototypeIndex) count++;
            return count;
        }

        /** prefab 的网格（含子对象）合并成一份网格：几何折进 prefab 根局部空间，子网格顺序 = 材质槽顺序。 */
        private static Mesh MergePrefabMesh(GameObject prefab, out Material[] materials, out string note)
        {
            note = "";
            var vertices = new List<Vector3>();
            var normals = new List<Vector3>();
            var uvs = new List<Vector2>();
            var subMeshes = new List<List<int>>();
            var slots = new List<Material>();
            Matrix4x4 rootInverse = prefab.transform.worldToLocalMatrix;
            foreach (MeshFilter filter in prefab.GetComponentsInChildren<MeshFilter>(true))
            {
                Mesh source = filter.sharedMesh;
                if (source == null || source.vertexCount == 0) continue;
                MeshRenderer renderer = filter.GetComponent<MeshRenderer>();
                Material[] rendererMaterials = renderer != null ? renderer.sharedMaterials : new Material[0];
                Matrix4x4 matrix = rootInverse * filter.transform.localToWorldMatrix;
                Matrix4x4 normalMatrix = matrix.inverse.transpose;
                int baseIndex = vertices.Count;
                Vector3[] sourceVertices = source.vertices;
                Vector3[] sourceNormals = source.normals;
                Vector2[] sourceUvs = source.uv;
                bool hasNormals = sourceNormals.Length == sourceVertices.Length;
                bool hasUvs = sourceUvs.Length == sourceVertices.Length;
                for (int index = 0; index < sourceVertices.Length; index++)
                {
                    vertices.Add(matrix.MultiplyPoint3x4(sourceVertices[index]));
                    Vector3 normal = hasNormals ? normalMatrix.MultiplyVector(sourceNormals[index]) : Vector3.up;
                    normals.Add(normal.sqrMagnitude > 1e-12f ? normal.normalized : Vector3.zero);
                    uvs.Add(hasUvs ? sourceUvs[index] : Vector2.zero);
                }
                for (int subMesh = 0; subMesh < Mathf.Max(1, source.subMeshCount); subMesh++)
                {
                    var indices = new List<int>();
                    foreach (int index in source.GetTriangles(Mathf.Min(subMesh, source.subMeshCount - 1))) indices.Add(baseIndex + index);
                    subMeshes.Add(indices);
                    Material slot = rendererMaterials.Length > 0 ? rendererMaterials[Mathf.Min(subMesh, rendererMaterials.Length - 1)] : null;
                    slots.Add(slot);
                }
            }
            if (vertices.Count == 0) throw new InvalidOperationException("PREFAB_HAS_NO_MESH: 原型 prefab 里没有可交付的网格（MeshFilter/SkinnedMeshRenderer）");
            if (prefab.GetComponentsInChildren<SkinnedMeshRenderer>(true).Length > 0) note = "PREFAB_SKINNED_NOT_TRANSFERRED: 原型里有 SkinnedMeshRenderer，只交付静态网格";
            var mesh = new Mesh { name = prefab.name + " 植被原型" };
            mesh.indexFormat = vertices.Count > 65000 ? UnityEngine.Rendering.IndexFormat.UInt32 : UnityEngine.Rendering.IndexFormat.UInt16;
            mesh.vertices = vertices.ToArray();
            mesh.normals = normals.ToArray();
            mesh.uv = uvs.ToArray();
            mesh.subMeshCount = subMeshes.Count;
            for (int subMesh = 0; subMesh < subMeshes.Count; subMesh++) mesh.SetTriangles(subMeshes[subMesh], subMesh);
            mesh.RecalculateBounds();
            materials = slots.ToArray();
            return mesh;
        }

        /** 交付网格字节（LPMESH）**自己读一遍**：高度与资产身份都以交付字节为准，不信文档声明。 */
        private static LpmeshPayload ReadDeliveredMesh(NodeRecord node, List<string> nodeLosses)
        {
            if (node.mesh == null || string.IsNullOrEmpty(node.mesh.file)) return null;
            string filePath = ResolveProjectPath(node.mesh.file);
            if (!File.Exists(filePath)) { nodeLosses.Add("MESH_FILE_MISSING: " + node.mesh.file); return null; }
            if (!filePath.ToLowerInvariant().EndsWith(".lpmesh")) { nodeLosses.Add("MESH_PAYLOAD_UNSUPPORTED: " + Path.GetFileName(filePath)); return null; }
            LpmeshPayload payload = ReadLpmesh(filePath, out string readError);
            if (payload == null || payload.mesh == null) { nodeLosses.Add("MESH_PAYLOAD_INVALID: " + readError); return null; }
            if (!string.IsNullOrEmpty(readError)) nodeLosses.Add("MESH_PAYLOAD_PARTIAL: " + readError);
            return payload;
        }

        private static string Sha256Of(string path)
        {
            using (FileStream stream = File.OpenRead(path))
            using (SHA256 sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        // ── import：交换文档 → Unity 场景 ───────────────────────────────────────

        public static ImportPayload ExecuteImport(ImportRequest options, List<string> warnings)
        {
            if (EditorApplication.isPlaying) throw new InvalidOperationException("EDITOR_IN_PLAY_MODE");
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) throw new InvalidOperationException("EDITOR_BUSY: 正在编译/刷新，稍后重试");

            string documentPath = ResolveProjectPath(options.documentPath);
            if (!File.Exists(documentPath)) throw new InvalidOperationException("DOCUMENT_MISSING: " + documentPath);
            SceneDocument document = JsonUtility.FromJson<SceneDocument>(File.ReadAllText(documentPath));
            if (document == null || document.nodes == null) throw new InvalidOperationException("DOCUMENT_UNPARSABLE: " + documentPath);
            if (document.kind != Kind) throw new InvalidOperationException("DOCUMENT_KIND_MISMATCH: " + document.kind);

            string assetFolder = string.IsNullOrEmpty(options.assetFolder) ? DefaultAssetFolder : options.assetFolder.TrimEnd('/');
            float scale = options.metersPerUnit <= 0f ? 1f : options.metersPerUnit;
            var losses = new List<string>();

            Scene scene = default(Scene);   // UnityEngine.SceneManagement.Scene 是结构体，没有 null
            if (options.mode == "new" || options.mode == "additive")
            {
                if (string.IsNullOrEmpty(options.scenePath)) throw new InvalidOperationException("SCENE_PATH_REQUIRED: mode=" + options.mode);
                if (options.mode == "additive" && !string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(options.scenePath)))
                {
                    scene = EditorSceneManager.OpenScene(options.scenePath, OpenSceneMode.Additive);
                }
                else if (options.mode == "new")
                {
                    // Unity 不允许在"有未保存的未命名场景"时再加开 additive 场景（会直接抛异常）。
                    // 这种场景只可能来自上一次保存失败的导入（保存失败时我们会关掉自己建的场景），
                    // 与其让调用方拿到一句 Unity 异常，不如明说原因。
                    for (int i = 0; i < SceneManager.sceneCount; i++)
                    {
                        Scene loaded = SceneManager.GetSceneAt(i);
                        if (string.IsNullOrEmpty(loaded.path))
                            throw new InvalidOperationException("UNTITLED_SCENE_BLOCKS_NEW: 编辑器里有未保存的未命名场景 '" + loaded.name + "'，先在编辑器里保存或关掉它再导入");
                    }
                    scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
                }
                else
                {
                    scene = EditorSceneManager.OpenScene(options.scenePath, OpenSceneMode.Additive);
                }
                if (options.mode == "new" && !options.dryRun)
                {
                    // 这里只是先给新场景落一个**文件名**（后面还要带内容再存一次）。
                    // 必须建"父目录"：把场景路径本身当目录建出来，SaveScene 移动文件时就会失败并弹模态框，
                    // 主线程被对话框卡住（实测：整个编辑器卡死、MCP 全部超时）。
                    try
                    {
                        string directory = Path.GetDirectoryName(Path.GetFullPath(Path.Combine(ProjectRoot, options.scenePath)));
                        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                        if (!EditorSceneManager.SaveScene(scene, options.scenePath))
                            throw new InvalidOperationException("SCENE_SAVE_FAILED: " + options.scenePath);
                    }
                    catch
                    {
                        EditorSceneManager.CloseScene(scene, true);   // 保存失败就别把未命名场景留在编辑器里
                        throw;
                    }
                }
            }
            else
            {
                scene = SceneManager.GetActiveScene();
                if (!scene.IsValid()) throw new InvalidOperationException("ACTIVE_SCENE_MISSING");
            }

            var payload = new ImportPayload
            {
                scenePath = scene.path ?? "",
                mode = options.mode,
                dryRun = options.dryRun,
                losses = losses.ToArray(),
            };
            var results = new List<ImportNodeResult>();
            var created = new Dictionary<int, GameObject>();
            var prefabInstances = new Dictionary<int, GameObject>();
            int createdCount = 0, updatedCount = 0, skippedCount = 0, copiedFiles = 0;
            var materialCache = new Dictionary<string, Material>(StringComparer.Ordinal);
            var modelCache = new Dictionary<string, GameObject>(StringComparer.Ordinal);
            Dictionary<string, GameObject> globalIdIndex = null;   // 场景对象 → GlobalObjectId（按需建一次）

            foreach (NodeRecord node in document.nodes)
            {
                var nodeResult = new ImportNodeResult
                {
                    index = node.index,
                    entityId = node.entityId ?? "",
                    globalId = node.globalId ?? "",
                    name = node.name ?? "",
                };
                var nodeLosses = new List<string>(node.losses ?? new string[0]);
                try
                {
                    GameObject parent = null;
                    if (node.parentIndex >= 0 && !created.TryGetValue(node.parentIndex, out parent))
                        throw new InvalidOperationException("PARENT_NOT_CREATED: parentIndex=" + node.parentIndex.ToString(CultureInfo.InvariantCulture));

                    GameObject target = FindByIdentity(scene, node.entityId);
                    if (target == null) target = FindByGlobalId(scene, node.globalId, ref globalIdIndex);
                    // Prefab 实例：父节点是本次新建的 Prefab 实例时，它的子节点由素材自己提供，
                    // 按名字在实例树里认领，不再新建同名子对象（否则一轮就复制出一棵重复树）。
                    if (target == null && node.parentIndex >= 0 && prefabInstances.TryGetValue(node.parentIndex, out GameObject instanceRoot))
                    {
                        Transform owned = FindDescendantByName(instanceRoot.transform, node.name);
                        if (owned != null) { target = owned.gameObject; nodeLosses.Add("PREFAB_CHILD_ADOPTED: 子节点由 Prefab 素材提供，按名字认领 " + node.name); }
                    }
                    bool isNew = target == null;
                    if (options.dryRun)
                    {
                        nodeResult.action = isNew ? "planned" : "planned-update";
                        if (!isNew) updatedCount++; else createdCount++;
                        results.Add(nodeResult);
                        continue;
                    }
                    if (isNew)
                    {
                        GameObject prefabAsset = null;
                        if (HasPrefab(node.prefab) && !string.IsNullOrEmpty(node.prefab.assetPath))
                        {
                            prefabAsset = AssetDatabase.LoadAssetAtPath<GameObject>(node.prefab.assetPath);
                            if (prefabAsset == null) nodeLosses.Add("PREFAB_ASSET_MISSING: " + node.prefab.assetPath + "（按普通对象重建）");
                        }
                        if (prefabAsset != null)
                        {
                            target = (GameObject)PrefabUtility.InstantiatePrefab(prefabAsset);
                            prefabInstances[node.index] = target;
                            nodeLosses.Add("PREFAB_INSTANTIATED: " + node.prefab.assetPath + "（保留 Prefab 链接；子节点按名字在实例里认领）");
                        }
                        else target = new GameObject(string.IsNullOrEmpty(node.name) ? "UnityNode" : node.name);
                        Undo.RegisterCreatedObjectUndo(target, "Lyapunov Scene Import");
                        createdCount++;
                        nodeResult.action = "created";
                    }
                    else
                    {
                        updatedCount++;
                        nodeResult.action = "updated";
                    }
                    SceneManager.MoveGameObjectToScene(target, scene);
                    if (parent != null) target.transform.SetParent(parent.transform, false);
                    target.transform.localPosition = ToVector3(node.position) * scale;
                    target.transform.localRotation = ToQuaternion(node.rotation);
                    target.transform.localScale = ToVector3(node.scale);
                    target.name = string.IsNullOrEmpty(node.name) ? target.name : node.name;
                    if (!string.IsNullOrEmpty(node.tag) && node.tag != "Untagged")
                    {
                        try { target.tag = node.tag; }
                        catch { nodeLosses.Add("TAG_NOT_APPLIED: 项目 TagManager 里没有 tag " + node.tag); }
                    }
                    target.SetActive(node.active);

                    LpmeshPayload lpmesh;
                    if (HasTerrain(node.terrain))
                    {
                        // 地形对象不建 MeshFilter/不改材质槽：交付的 LPMESH 是**高度来源**（顶点 y = 归一化高度 × heightM），
                        // 渲染交给 Terrain 组件（ApplyTerrain）。给它派生网格资产只会多一份与地形无关的网格。
                        lpmesh = options.dryRun ? null : ReadDeliveredMesh(node, nodeLosses);
                    }
                    else
                    {
                        ApplyMesh(target, node, assetFolder, modelCache, nodeLosses, ref copiedFiles, options.dryRun, out lpmesh);
                        // 材质要等网格先建好：LPMESH 里的子网格材质表决定每个子网格挂哪一份材质。
                        ApplyMaterials(target, node, assetFolder, materialCache, nodeLosses, lpmesh, ref copiedFiles);
                    }
                    ApplyLight(target, node);
                    ApplyCamera(target, node);
                    ApplyTerrain(target, node, assetFolder, nodeLosses, lpmesh, ref copiedFiles);
                    ApplyIdentity(target, node);

                    created[node.index] = target;
                }
                catch (Exception error)
                {
                    nodeResult.action = "skipped";
                    nodeLosses.Add("NODE_IMPORT_FAILED: " + error.Message);
                    skippedCount++;
                }
                nodeResult.losses = nodeLosses.ToArray();
                results.Add(nodeResult);
            }

            if (!options.dryRun && options.saveScene && scene.isLoaded && !string.IsNullOrEmpty(scene.path))
            {
                // 环境写回放在存盘之前：否则对象存下去了、RenderSettings 还留在内存里。
                ApplyEnvironment(scene, document.environment, losses);
                // 存盘失败必须让调用方看见：否则产品会以为对象已经落到磁盘上了。
                if (!EditorSceneManager.SaveScene(scene)) throw new InvalidOperationException("SCENE_SAVE_FAILED: " + scene.path);
            }

            payload.created = createdCount;
            payload.updated = updatedCount;
            payload.skipped = skippedCount;
            payload.assetFilesCopied = copiedFiles;
            payload.nodes = results.ToArray();
            payload.scenePath = scene.path ?? "";
            payload.losses = losses.ToArray();
            if (options.dryRun) warnings.Add("DRY_RUN: 只做了可达性检查，没有创建/修改任何对象");
            return payload;
        }

        /// <summary>在 Prefab 实例树里按名字认领子对象（只认第一个同名后代）。</summary>
        private static Transform FindDescendantByName(Transform root, string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            foreach (Transform child in root.GetComponentsInChildren<Transform>(true))
                if (child != root && child.name == name) return child;
            return null;
        }

        private static GameObject FindByIdentity(Scene scene, string entityId)
        {
            if (string.IsNullOrEmpty(entityId) || !scene.IsValid() || !scene.isLoaded) return null;
            foreach (GameObject root in scene.GetRootGameObjects())
                foreach (LyapunovEntityIdentity identity in root.GetComponentsInChildren<LyapunovEntityIdentity>(true))
                    if (identity.entityId == entityId) return identity.gameObject;
            return null;
        }

        /**
         * 身份匹配的第二条路：**场景里原生对象没有 identity 组件时按 GlobalObjectId 认**。
         *
         * 用户自己搭的场景对象不会带 LyapunovEntityIdentity，但它们有 Unity 自己的 GlobalObjectId，
         * 而文档里每个节点都带着同一个 GlobalObjectId（导出时采的）。没有这条兜底，写回就会把这些
         * 对象**再建一遍**——用户的场景里出现重名副本，正是"按 identity 稳定更新"要避免的。
         * 地图按需建一次（每个导入请求一份），不在每个节点上重扫场景。
         */
        private static GameObject FindByGlobalId(Scene scene, string globalId, ref Dictionary<string, GameObject> index)
        {
            if (string.IsNullOrEmpty(globalId) || !scene.IsValid() || !scene.isLoaded) return null;
            if (index == null)
            {
                index = new Dictionary<string, GameObject>(StringComparer.Ordinal);
                foreach (GameObject root in scene.GetRootGameObjects())
                    foreach (Transform item in root.GetComponentsInChildren<Transform>(true))
                    {
                        string id = GlobalObjectId.GetGlobalObjectIdSlow(item.gameObject).ToString();
                        if (!string.IsNullOrEmpty(id) && !index.ContainsKey(id)) index[id] = item.gameObject;
                    }
            }
            GameObject found;
            return index.TryGetValue(globalId, out found) ? found : null;
        }

        private static void ApplyIdentity(GameObject target, NodeRecord node)
        {
            if (string.IsNullOrEmpty(node.entityId)) return;
            LyapunovEntityIdentity identity = target.GetComponent<LyapunovEntityIdentity>();
            if (identity == null) identity = target.AddComponent<LyapunovEntityIdentity>();
            identity.entityId = node.entityId;
        }

        /// <summary>
        /// 网格落地：**先看能不能复用已有资产身份，复用与否由内容摘要说了算**。
        ///   0. 交付了 LPMESH 字节就先把字节读成网格、算出**字节自己的**摘要；它和文档声明的
        ///      `contentDigest` 不一致时记 `MESH_ASSET_DELIVERED_DIGEST_MISMATCH`，并且**不允许**
        ///      按声明的身份复用（只信声明的话，内容真的变了也会被安静地复用过去）。
        ///   1. 项目资产的 GUID 还在 → 拿资产算出内容摘要，与交付的 `contentDigest` 逐值比对：
        ///      · 相等（且交付字节也没异议）→ 沿用原资产（不新建、不改用户资产，回执 `MESH_ASSET_REUSED`）；
        ///      · 不等 → 交付了 LPMESH 字节就派生新资产（回执 `MESH_ASSET_CONTENT_CHANGED`），
        ///        没交付字节就只能沿用原资产并明说身份没验证过（`MESH_ASSET_IDENTITY_UNVERIFIED`）。
        ///   2. 内置原始体（Cube/Sphere/…）同样按摘要判：一致就用内置资产（`MESH_PRIMITIVE_REUSED`）。
        ///   3. 都没有可复用的身份时用 LPMESH 字节建 Mesh 资产（`MESH_ASSET_DERIVED`），不经模型导入器，
        ///      不发生第二次轴向/单位换算；子网格与 UV 原样落地。
        /// 判据绝不放松：摘要缺失（老文档）不当作"内容相同"，一律走派生并写明。
        /// 网格一律挂在**对象自身**而不是子对象上：子对象会在下次导出时变成一个新的 Unity 节点，
        /// 往返几轮就会长出多余实体。
        /// </summary>
        private static void ApplyMesh(GameObject target, NodeRecord node, string assetFolder, Dictionary<string, GameObject> modelCache, List<string> nodeLosses, ref int copiedFiles, bool dryRun, out LpmeshPayload payload)
        {
            payload = null;
            if (!HasMesh(node.mesh)) return;
            if (target.GetComponent<MeshFilter>() != null || target.GetComponent<SkinnedMeshRenderer>() != null) return;
            if (dryRun) return;

            string digest = node.mesh.contentDigest ?? "";
            // 交付的字节**先自己读出来**：资产身份能不能沿用，看的是交付字节算出的摘要，
            // 不是文档里写的那个声明值。只信声明的话，内容变了也能被"复用"过去（摘要对不上就没人发现）。
            payload = ReadDeliveredMesh(node, nodeLosses);
            string delivered = payload != null ? MeshContentDigest(payload.mesh) : "";
            if (payload != null && digest.Length > 0 && delivered != digest)
                nodeLosses.Add("MESH_ASSET_DELIVERED_DIGEST_MISMATCH: 交付的 " + node.mesh.file + " 字节摘要 " + delivered
                    + " 与文档声明 " + digest + " 不一致（以交付字节为准：不沿用声明的资产身份，按字节派生）");
            bool deliveredAgrees = payload == null || digest.Length == 0 || delivered == digest;

            Mesh candidate = null;
            string candidateSource = "";
            if (!string.IsNullOrEmpty(node.mesh.assetPath) && !string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(node.mesh.assetPath)))
            {
                candidate = LoadMeshFromAsset(node.mesh.assetPath, modelCache);
                candidateSource = "ASSET:" + node.mesh.assetPath + "@" + node.mesh.assetGuid;
                if (candidate == null) nodeLosses.Add("MESH_ASSET_NOT_A_MESH: " + node.mesh.assetPath);
            }
            else
            {
                PrimitiveType primitiveType;
                if (!string.IsNullOrEmpty(node.mesh.primitive) && TryPrimitiveType(node.mesh.primitive, out primitiveType))
                {
                    candidate = BuiltinPrimitiveMesh(primitiveType);
                    candidateSource = "BUILTIN:" + node.mesh.primitive;
                }
            }

            if (candidate != null)
            {
                string actual = MeshContentDigest(candidate);
                if (digest.Length > 0 && actual == digest && deliveredAgrees)
                {
                    AttachMesh(target, candidate, nodeLosses, candidateSource);
                    bool builtin = candidateSource.StartsWith("BUILTIN:", StringComparison.Ordinal);
                    nodeLosses.Add((builtin ? "MESH_PRIMITIVE_REUSED: " : "MESH_ASSET_REUSED: ") + candidateSource + "（内容摘要 " + actual
                        + " 与交付一致，沿用原资产身份，不新建网格资产）");
                    return;
                }
                if (string.IsNullOrEmpty(node.mesh.file))
                {
                    AttachMesh(target, candidate, nodeLosses, candidateSource);
                    nodeLosses.Add("MESH_ASSET_IDENTITY_UNVERIFIED: " + candidateSource + " 沿用原资产，但交付的 contentDigest"
                        + (digest.Length == 0 ? "缺失" : "=" + digest) + " 与实际 " + actual + " 对不上，且没有交付网格字节可派生，本次不新建资产（资产身份未验证）");
                    return;
                }
                nodeLosses.Add((digest.Length == 0 ? "MESH_ASSET_IDENTITY_UNVERIFIED" : "MESH_ASSET_CONTENT_CHANGED") + ": " + candidateSource + " 的几何与交付不同（实际摘要 "
                    + actual + "，文档声明摘要 " + (digest.Length == 0 ? "缺失" : digest) + "），改为派生新资产，原资产不动");
            }

            if (payload != null)
            {
                Mesh mesh = payload.mesh;
                string folder = assetFolder + "/Meshes";
                EnsureAssetFolder(folder);
                string assetPath = folder + "/" + Sanitize(node.mesh.name) + "-" + node.index.ToString(CultureInfo.InvariantCulture) + ".asset";
                Mesh existing = AssetDatabase.LoadAssetAtPath<Mesh>(assetPath);
                if (existing != null) AssetDatabase.DeleteAsset(assetPath);
                AssetDatabase.CreateAsset(mesh, assetPath);
                copiedFiles++;
                AttachMesh(target, mesh, nodeLosses, "LPMESH");
                nodeLosses.Add("MESH_ASSET_DERIVED: " + assetPath + "（来自 " + node.mesh.file + "，顶点 " + mesh.vertexCount.ToString(CultureInfo.InvariantCulture)
                    + "，子网格 " + mesh.subMeshCount.ToString(CultureInfo.InvariantCulture) + "，UV " + mesh.uv.Length.ToString(CultureInfo.InvariantCulture)
                    + "，派生摘要 " + delivered + "：这是**交付字节自己算出来的**摘要"
                    + (digest.Length > 0 && delivered == digest ? "，与文档声明一致" : "，文档声明为 " + (digest.Length == 0 ? "缺失" : digest)) + "）");
                return;
            }
            if (candidate != null)
            {
                AttachMesh(target, candidate, nodeLosses, candidateSource);
                nodeLosses.Add("MESH_FROM_BUILTIN_PRIMITIVE: " + node.mesh.primitive + "（没有交付网格字节，用 Unity 内置几何重建，几何可能与被改过的原网格不同）");
                return;
            }
            nodeLosses.Add("MESH_PAYLOAD_ABSENT: 既没有资产路径/网格文件，也没有可用的原始体");
        }

        /// <summary>从项目资产取网格：模型文件（.fbx/.glb/.obj）取里面的 MeshFilter，.asset 直接取 Mesh。</summary>
        private static Mesh LoadMeshFromAsset(string assetPath, Dictionary<string, GameObject> modelCache)
        {
            Mesh direct = AssetDatabase.LoadAssetAtPath<Mesh>(assetPath);
            if (direct != null) return direct;
            GameObject asset = LoadModelRoot(assetPath, modelCache);
            MeshFilter filter = asset != null ? asset.GetComponentInChildren<MeshFilter>() : null;
            return filter != null ? filter.sharedMesh : null;
        }

        /// <summary>Unity 内置原始体网格（用 CreatePrimitive 取，再立刻销毁那个临时对象）。</summary>
        private static Mesh BuiltinPrimitiveMesh(PrimitiveType primitiveType)
        {
            GameObject builtin = GameObject.CreatePrimitive(primitiveType);
            MeshFilter filter = builtin.GetComponent<MeshFilter>();
            Mesh mesh = filter != null ? filter.sharedMesh : null;
            UnityEngine.Object.DestroyImmediate(builtin);
            return mesh;
        }

        /// <summary>把网格挂到目标自身（已有 MeshRenderer 就复用它）。</summary>
        private static void AttachMesh(GameObject target, Mesh mesh, List<string> nodeLosses, string source)
        {
            if (mesh == null) { nodeLosses.Add("MESH_EMPTY_SOURCE: " + source); return; }
            MeshFilter filter = target.GetComponent<MeshFilter>();
            if (filter == null) filter = target.AddComponent<MeshFilter>();
            filter.sharedMesh = mesh;
            if (target.GetComponent<MeshRenderer>() == null) target.AddComponent<MeshRenderer>();
        }

        // ── LPMESH 载荷（v2 起带 UV、子网格与逐子网格材质，贴图字节内嵌在文件尾部） ──────────────
        //
        // 格式与产品侧 encodeLpmesh（packages/scene-kit/src/unity-exchange.ts）是同一份：
        //   magic "LPMESH02"(8) + flags(4) + vertexCount(4) + indexCount(4) + subMeshCount(4) + materialCount(4)
        //   float32 位置[vertexCount*3] + 可选法线[vertexCount*3] + 可选 UV[vertexCount*2]（Unity 约定：左下原点）
        //   uint32 索引[indexCount]（每子网格一段，段内是三角形列表）
        //   uint32 子网格起始[subMeshCount]（以索引个数为单位） + uint32 子网格长度[subMeshCount]
        //   uint32 材质表 JSON 字节数 + 材质表 JSON（UTF-8，偏移/长度指向后面的贴图字节块） + 贴图字节块
        // flags：bit0=有法线 bit1=有 UV bit2=有子网格与材质表。没有材质表时按单子网格、材料记录原样处理。
        // v1（"LPMESH01"，无 UV/子网格/材质）仍然能读：老文档的文件不至于读不了。

        [Serializable]
        internal sealed class LpmeshTextureTableEntry
        {
            public string property = "";
            public string mimeType = "";
            public string wrapMode = "";
            public string contentDigest = "";
            public int byteOffset;
            public int byteLength;
        }

        [Serializable]
        internal sealed class LpmeshMaterialTableEntry
        {
            public string name = "";
            public float[] baseColor = new float[4];
            public float metallic;
            public float smoothness;
            public LpmeshTextureTableEntry[] textures = new LpmeshTextureTableEntry[0];
        }

        [Serializable]
        internal sealed class LpmeshMaterialTable
        {
            public int textureBlobLength;
            public int[] submeshMaterials = new int[0];
            public LpmeshMaterialTableEntry[] materials = new LpmeshMaterialTableEntry[0];
        }

        internal sealed class LpmeshTexture
        {
            public string property = "";
            public string mimeType = "";
            public string wrapMode = "";
            public string contentDigest = "";
            public byte[] bytes;
        }

        internal sealed class LpmeshMaterial
        {
            public string name = "";
            public float[] baseColor = new float[4];
            public float metallic;
            public float smoothness;
            public readonly List<LpmeshTexture> textures = new List<LpmeshTexture>();
        }

        /// <summary>LPMESH 解出来的全部内容：网格本身 + 逐子网格材质（含内嵌贴图字节）。</summary>
        internal sealed class LpmeshPayload
        {
            public Mesh mesh;
            public int[] submeshMaterials = new int[0];
            public LpmeshMaterial[] materials = new LpmeshMaterial[0];
        }

        private static LpmeshPayload ReadLpmesh(string path, out string error)
        {
            error = "";
            byte[] bytes;
            try { bytes = File.ReadAllBytes(path); }
            catch (Exception exception) { error = exception.Message; return null; }
            if (bytes.Length < 28) { error = "LPMESH_TOO_SHORT: " + bytes.Length.ToString(CultureInfo.InvariantCulture); return null; }
            string magic = Encoding.ASCII.GetString(bytes, 0, 8);
            if (magic != "LPMESH01" && magic != "LPMESH02") { error = "LPMESH_MAGIC_MISMATCH: " + magic; return null; }
            bool extended = magic == "LPMESH02";
            uint flags = BitConverter.ToUInt32(bytes, 8);
            int vertexCount = (int)BitConverter.ToUInt32(bytes, 12);
            int indexCount = (int)BitConverter.ToUInt32(bytes, 16);
            bool hasNormals = (flags & 1u) != 0;
            bool hasUvs = extended && (flags & 2u) != 0;
            bool hasTable = extended && (flags & 4u) != 0;
            int subMeshCount = extended ? Math.Max(1, (int)BitConverter.ToUInt32(bytes, 20)) : 1;
            long attributeBytes = (long)vertexCount * 12L * (hasNormals ? 2L : 1L) + (long)vertexCount * (hasUvs ? 8L : 0L);
            long minimum = 28L + attributeBytes + (long)indexCount * 4L;
            if (!extended) minimum += 0;   // v1 的长度是精确值，下面单独核对
            if (vertexCount <= 0 || indexCount <= 0 || bytes.Length < minimum)
            {
                error = "LPMESH_LENGTH_MISMATCH: expected>=" + minimum.ToString(CultureInfo.InvariantCulture) + " actual=" + bytes.Length.ToString(CultureInfo.InvariantCulture);
                return null;
            }
            if (!extended && bytes.Length != minimum)
            {
                error = "LPMESH_LENGTH_MISMATCH: expected=" + minimum.ToString(CultureInfo.InvariantCulture) + " actual=" + bytes.Length.ToString(CultureInfo.InvariantCulture);
                return null;
            }

            var vertices = new Vector3[vertexCount];
            var normals = hasNormals ? new Vector3[vertexCount] : null;
            var uvs = hasUvs ? new Vector2[vertexCount] : null;
            int offset = 28;
            for (int index = 0; index < vertexCount; index++)
            {
                vertices[index] = new Vector3(BitConverter.ToSingle(bytes, offset), BitConverter.ToSingle(bytes, offset + 4), BitConverter.ToSingle(bytes, offset + 8));
                offset += 12;
            }
            if (hasNormals) for (int index = 0; index < vertexCount; index++)
            {
                normals[index] = new Vector3(BitConverter.ToSingle(bytes, offset), BitConverter.ToSingle(bytes, offset + 4), BitConverter.ToSingle(bytes, offset + 8));
                offset += 12;
            }
            if (hasUvs) for (int index = 0; index < vertexCount; index++)
            {
                uvs[index] = new Vector2(BitConverter.ToSingle(bytes, offset), BitConverter.ToSingle(bytes, offset + 4));
                offset += 8;
            }
            var triangles = new int[indexCount];
            for (int index = 0; index < indexCount; index++) { triangles[index] = (int)BitConverter.ToUInt32(bytes, offset); offset += 4; }
            // 索引越界会让 Unity 抛异常并留下半个网格；先核对，报明确错误。
            int limit = vertexCount - 1;
            for (int index = 0; index < triangles.Length; index++)
                if (triangles[index] < 0 || triangles[index] > limit) { error = "LPMESH_INDEX_OUT_OF_RANGE: " + triangles[index].ToString(CultureInfo.InvariantCulture); return null; }

            int[] submeshStarts = null;
            int[] submeshCounts = null;
            if (hasTable)
            {
                if (bytes.Length < offset + subMeshCount * 8L) { error = "LPMESH_SUBMESH_TABLE_TRUNCATED"; return null; }
                submeshStarts = new int[subMeshCount];
                submeshCounts = new int[subMeshCount];
                for (int subMesh = 0; subMesh < subMeshCount; subMesh++) { submeshStarts[subMesh] = (int)BitConverter.ToUInt32(bytes, offset); offset += 4; }
                for (int subMesh = 0; subMesh < subMeshCount; subMesh++) { submeshCounts[subMesh] = (int)BitConverter.ToUInt32(bytes, offset); offset += 4; }
                int sum = 0;
                for (int subMesh = 0; subMesh < subMeshCount; subMesh++)
                {
                    if (submeshStarts[subMesh] < 0 || submeshCounts[subMesh] < 0 || (long)submeshStarts[subMesh] + submeshCounts[subMesh] > indexCount)
                    { error = "LPMESH_SUBMESH_RANGE_INVALID: " + subMesh.ToString(CultureInfo.InvariantCulture); return null; }
                    sum += submeshCounts[subMesh];
                }
                if (sum != indexCount) { error = "LPMESH_SUBMESH_COVERAGE_MISMATCH: " + sum.ToString(CultureInfo.InvariantCulture) + " ≠ " + indexCount.ToString(CultureInfo.InvariantCulture); return null; }
            }

            LpmeshMaterialTable table = null;
            if (hasTable)
            {
                if (bytes.Length < offset + 4L) { error = "LPMESH_MATERIAL_TABLE_TRUNCATED"; return null; }
                int tableBytes = (int)BitConverter.ToUInt32(bytes, offset); offset += 4;
                if (tableBytes < 0 || bytes.Length < offset + (long)tableBytes) { error = "LPMESH_MATERIAL_TABLE_TRUNCATED: " + tableBytes.ToString(CultureInfo.InvariantCulture); return null; }
                try { table = JsonUtility.FromJson<LpmeshMaterialTable>(Encoding.UTF8.GetString(bytes, offset, tableBytes)); }
                catch (Exception exception) { error = "LPMESH_MATERIAL_TABLE_INVALID: " + exception.Message; return null; }
                offset += tableBytes;
                if (table == null) { error = "LPMESH_MATERIAL_TABLE_INVALID"; return null; }
            }

            var mesh = new Mesh();
            mesh.name = Path.GetFileNameWithoutExtension(path);
            mesh.indexFormat = vertexCount > 65535 ? UnityEngine.Rendering.IndexFormat.UInt32 : UnityEngine.Rendering.IndexFormat.UInt16;
            mesh.vertices = vertices;
            if (normals != null) mesh.normals = normals;
            if (uvs != null) mesh.uv = uvs;
            if (submeshStarts != null)
            {
                mesh.subMeshCount = submeshStarts.Length;
                for (int subMesh = 0; subMesh < submeshStarts.Length; subMesh++)
                {
                    var range = new int[submeshCounts[subMesh]];
                    Array.Copy(triangles, submeshStarts[subMesh], range, 0, submeshCounts[subMesh]);
                    mesh.SetTriangles(range, subMesh);
                }
            }
            else mesh.triangles = triangles;
            if (normals == null) mesh.RecalculateNormals();
            mesh.RecalculateBounds();

            var payload = new LpmeshPayload { mesh = mesh };
            if (table == null) return payload;

            if (table.submeshMaterials != null && table.submeshMaterials.Length > 0) payload.submeshMaterials = table.submeshMaterials;
            var materials = new List<LpmeshMaterial>();
            foreach (LpmeshMaterialTableEntry entry in table.materials ?? new LpmeshMaterialTableEntry[0])
            {
                if (entry == null) { materials.Add(new LpmeshMaterial()); continue; }
                var material = new LpmeshMaterial
                {
                    name = entry.name ?? "",
                    baseColor = entry.baseColor ?? new float[4],
                    metallic = entry.metallic,
                    smoothness = entry.smoothness,
                };
                foreach (LpmeshTextureTableEntry texture in entry.textures ?? new LpmeshTextureTableEntry[0])
                {
                    if (texture == null || string.IsNullOrEmpty(texture.property)) continue;
                    if (texture.byteLength <= 0 || texture.byteOffset < 0 || bytes.Length < offset + (long)texture.byteOffset + texture.byteLength)
                    {
                        materials.Add(material);
                        error = "LPMESH_TEXTURE_RANGE_INVALID: " + texture.property + " offset=" + texture.byteOffset.ToString(CultureInfo.InvariantCulture) + " length=" + texture.byteLength.ToString(CultureInfo.InvariantCulture);
                        payload.materials = materials.ToArray();
                        return payload;
                    }
                    var slice = new byte[texture.byteLength];
                    Array.Copy(bytes, offset + texture.byteOffset, slice, 0, texture.byteLength);
                    material.textures.Add(new LpmeshTexture
                    {
                        property = texture.property, mimeType = texture.mimeType ?? "", wrapMode = texture.wrapMode ?? "",
                        contentDigest = texture.contentDigest ?? "", bytes = slice,
                    });
                }
                materials.Add(material);
            }
            payload.materials = materials.ToArray();
            return payload;
        }

        private static GameObject LoadModelRoot(string assetPath, Dictionary<string, GameObject> cache)
        {
            if (cache.ContainsKey(assetPath)) return cache[assetPath];
            GameObject asset = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (asset != null) cache[assetPath] = asset;
            return asset;
        }

        private static bool TryPrimitiveType(string name, out PrimitiveType type)
        {
            switch (name)
            {
                case "Cube": type = PrimitiveType.Cube; return true;
                case "Sphere": type = PrimitiveType.Sphere; return true;
                case "Capsule": type = PrimitiveType.Capsule; return true;
                case "Cylinder": type = PrimitiveType.Cylinder; return true;
                case "Plane": type = PrimitiveType.Plane; return true;
                case "Quad": type = PrimitiveType.Quad; return true;
                default: type = PrimitiveType.Cube; return false;
            }
        }

        /// <summary>
        /// 材质落地：**逐子网格**挂材质，不把第一个材质铺到所有面上。
        ///   子网格数取自交付的 LPMESH 材质表（没有表时退回文档里的材质数），每个子网格的材质下标
        ///   取自 LPMESH 的 submeshMaterials；材质优先复用文档里的资产引用（同一工程往返就是原来那个材质，
        ///   贴图与颜色都在资产里），资产不在（跨工程）才按记录重建 —— 重建时把 LPMESH 内嵌的贴图字节
        ///   经 TextureImporter 落成项目贴图资产并接上材质。
        /// **已有材质资产永不被改写**：贴图只接在本次新建的材质上。
        /// </summary>
        private static void ApplyMaterials(GameObject target, NodeRecord node, string assetFolder, Dictionary<string, Material> cache, List<string> nodeLosses, LpmeshPayload payload, ref int copiedFiles)
        {
            Renderer renderer = target.GetComponent<Renderer>() ?? target.GetComponentInChildren<Renderer>();
            if (renderer == null) return;
            int subMeshCount = 0;
            if (payload != null && payload.submeshMaterials.Length > 0) subMeshCount = payload.submeshMaterials.Length;
            else if (node.materials != null && node.materials.Length > 0) subMeshCount = node.materials.Length;
            else if (payload != null && payload.materials.Length > 0) subMeshCount = payload.materials.Length;
            if (subMeshCount <= 0) return;

            var materials = new List<Material>();
            for (int subMesh = 0; subMesh < subMeshCount; subMesh++)
            {
                int materialIndex = payload != null && payload.submeshMaterials.Length > 0 ? payload.submeshMaterials[subMesh] : subMesh;
                MaterialRecord record = node.materials != null && materialIndex >= 0 && materialIndex < node.materials.Length ? node.materials[materialIndex] : null;
                LpmeshMaterial embedded = payload != null && materialIndex >= 0 && materialIndex < payload.materials.Length ? payload.materials[materialIndex] : null;
                Material material = ResolveMaterial(record, embedded, assetFolder, cache, nodeLosses, ref copiedFiles);
                if (material != null) materials.Add(material);
            }
            if (materials.Count > 0) renderer.sharedMaterials = materials.ToArray();
        }

        /// <summary>一条材质记录（文档）+ 一份 LPMESH 内嵌材质 → 项目里的材质对象。</summary>
        private static Material ResolveMaterial(MaterialRecord record, LpmeshMaterial embedded, string assetFolder, Dictionary<string, Material> cache, List<string> nodeLosses, ref int copiedFiles)
        {
            bool hasRecord = record != null && (!string.IsNullOrEmpty(record.name) || !string.IsNullOrEmpty(record.shader) || !string.IsNullOrEmpty(record.assetPath)
                || (record.textureFiles != null && record.textureFiles.Length > 0) || (record.textures != null && record.textures.Length > 0)
                || (record.baseColor != null && record.baseColor.Any(value => value != 0f)) || record.metallic != 0f || record.smoothness != 0f);
            string name = hasRecord && !string.IsNullOrEmpty(record.name) ? record.name : embedded != null && !string.IsNullOrEmpty(embedded.name) ? embedded.name : "Material";
            if (name == "(missing)") name = "Missing";

            string textureDigest = embedded != null && embedded.textures.Count > 0 ? embedded.textures[0].contentDigest : "";
            string cacheKey = name + "|" + (hasRecord ? record.assetPath : "") + "|" + textureDigest;
            Material cached;
            if (cache.TryGetValue(cacheKey, out cached)) return cached;

            if (hasRecord && !string.IsNullOrEmpty(record.assetPath) && !string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(record.assetPath)))
            {
                Material asset = AssetDatabase.LoadAssetAtPath<Material>(record.assetPath);
                if (asset != null)
                {
                    nodeLosses.Add("MATERIAL_ASSET_REUSED: " + record.assetPath + "@" + record.assetGuid + "（同一工程内的材质资产，沿用原身份，贴图与颜色在资产里）");
                    if (embedded != null) CompareMaterialTextures(asset, embedded, record.assetPath, nodeLosses);
                    cache[cacheKey] = asset;
                    return asset;
                }
                nodeLosses.Add("MATERIAL_ASSET_MISSING: " + record.assetPath + "（工程里没有这个材质资产，按记录重建）");
            }

            string folder = assetFolder + "/Materials";
            EnsureAssetFolder(folder);
            // 文件名带上贴图摘要：同名但贴图不同的两个材质不会互相顶替（同一场景里两张不同 checker 也不混）。
            string suffix = textureDigest.Length >= 8 ? "-" + textureDigest.Substring(0, 8) : "";
            string path = folder + "/" + Sanitize(name) + suffix + ".mat";
            Material material = AssetDatabase.LoadAssetAtPath<Material>(path);
            bool created = false;
            if (material == null)
            {
                Shader shader = FindShader(hasRecord ? record.shader : "");
                if (shader == null) { nodeLosses.Add("MATERIAL_SHADER_MISSING: 项目里没有 shader " + (hasRecord ? record.shader : "") + "，材质 " + name + " 未建立"); return null; }
                material = new Material(shader);
                material.name = name;
                AssetDatabase.CreateAsset(material, path);
                created = true;
                copiedFiles++;
            }
            float[] baseColor = hasRecord && record.baseColor != null && record.baseColor.Length >= 4 ? record.baseColor
                : embedded != null && embedded.baseColor != null && embedded.baseColor.Length >= 4 ? embedded.baseColor : new float[] { 1f, 1f, 1f, 1f };
            float metallic = hasRecord ? record.metallic : embedded != null ? embedded.metallic : 0f;
            float smoothness = hasRecord ? record.smoothness : embedded != null ? embedded.smoothness : 0.5f;
            if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", ToColor(baseColor));
            if (material.HasProperty("_Color")) material.SetColor("_Color", ToColor(baseColor));
            if (material.HasProperty("_Metallic")) material.SetFloat("_Metallic", metallic);
            if (material.HasProperty("_Smoothness")) material.SetFloat("_Smoothness", smoothness);
            if (material.HasProperty("_Glossiness")) material.SetFloat("_Glossiness", smoothness);

            var applied = new List<string>();
            if (embedded != null) foreach (LpmeshTexture texture in embedded.textures)
            {
                Texture imported = ImportTexture(assetFolder, name, texture.property, texture.bytes, texture.mimeType, texture.wrapMode, nodeLosses, ref copiedFiles);
                if (imported == null) continue;
                if (!AssignTexture(material, texture.property, imported)) { nodeLosses.Add("MATERIAL_TEXTURE_PROPERTY_MISSING: " + name + " 的 shader " + material.shader.name + " 没有贴图属性 " + texture.property); continue; }
                applied.Add(texture.property);
            }
            // 没有内嵌字节（比如老文档）时退回文档里的贴图文件：本工程内还在就接上，不在就明说缺件。
            if (hasRecord && record.textureFiles != null) foreach (TextureRecord file in record.textureFiles)
            {
                if (file == null || string.IsNullOrEmpty(file.file) || applied.Contains(file.property)) continue;
                string full = Path.GetFullPath(Path.Combine(ProjectRoot, file.file));
                if (!File.Exists(full)) { nodeLosses.Add("MATERIAL_TEXTURE_FILE_MISSING: " + name + "." + file.property + " 的贴图文件 " + file.file + " 在本工程里不存在（跨工程交付需要 LPMESH 内嵌字节）"); continue; }
                Texture imported = ImportTexture(assetFolder, name, file.property, File.ReadAllBytes(full), file.mimeType, file.wrapMode, nodeLosses, ref copiedFiles);
                if (imported == null) continue;
                if (!AssignTexture(material, file.property, imported)) { nodeLosses.Add("MATERIAL_TEXTURE_PROPERTY_MISSING: " + name + " 的 shader " + material.shader.name + " 没有贴图属性 " + file.property); continue; }
                applied.Add(file.property);
            }
            EditorUtility.SetDirty(material);
            cache[cacheKey] = material;
            nodeLosses.Add("MATERIAL_" + (created ? "CREATED" : "UPDATED") + ": " + path + "（颜色/金属度/光滑度来自 "
                + (hasRecord ? "文档记录" : "LPMESH 材质表") + (applied.Count > 0 ? "，贴图 " + string.Join("、", applied.ToArray()) : "，无贴图") + "）");
            return material;
        }

        /// <summary>复用的材质资产上已经有的贴图，与交付的 LPMESH 内嵌贴图比一比（**只报告，不改用户资产**）。</summary>
        private static void CompareMaterialTextures(Material material, LpmeshMaterial embedded, string assetPath, List<string> nodeLosses)
        {
            foreach (LpmeshTexture texture in embedded.textures)
            {
                Texture current = material.HasProperty(texture.property) ? material.GetTexture(texture.property) : null;
                if (current == null)
                {
                    nodeLosses.Add("MATERIAL_TEXTURE_NOT_ASSIGNED: " + assetPath + " 的 " + texture.property + " 没有贴图，但交付带了贴图（沿用资产现状，不改用户资产）");
                    continue;
                }
                TexturePayload payload;
                string error;
                if (!TryTexturePayload(current, out payload, out error)) continue;
                string digest = ByteDigest(payload.bytes);
                if (digest != texture.contentDigest)
                    nodeLosses.Add("MATERIAL_TEXTURE_DIVERGED: " + assetPath + " 的 " + texture.property + " 资产贴图摘要 " + digest + " ≠ 交付摘要 " + texture.contentDigest + "（沿用资产里的那张，不覆盖用户资产）");
            }
        }

        /// <summary>按 shader 支持的属性名接贴图：URP 的 _BaseMap ↔ 内置/旧管线的 _MainTex 互认。</summary>
        private static bool AssignTexture(Material material, string property, Texture texture)
        {
            if (material.HasProperty(property)) { material.SetTexture(property, texture); return true; }
            if (property == "_MainTex" && material.HasProperty("_BaseMap")) { material.SetTexture("_BaseMap", texture); return true; }
            if (property == "_BaseMap" && material.HasProperty("_MainTex")) { material.SetTexture("_MainTex", texture); return true; }
            return false;
        }

        /// <summary>把贴图字节落成项目贴图资产（PNG/JPEG），按 wrap/法线贴图设好导入设置。</summary>
        private static Texture ImportTexture(string assetFolder, string materialName, string property, byte[] bytes, string mimeType, string wrapMode, List<string> nodeLosses, ref int copiedFiles)
        {
            if (bytes == null || bytes.Length == 0) return null;
            string digest = ByteDigest(bytes);
            string extension = mimeType == "image/jpeg" ? ".jpg" : ".png";
            string folder = assetFolder + "/Textures";
            EnsureAssetFolder(folder);
            string path = folder + "/" + Sanitize(materialName) + "-" + property.TrimStart('_') + "-" + digest.Substring(0, 8) + extension;
            string full = Path.GetFullPath(Path.Combine(ProjectRoot, path));
            if (!File.Exists(full))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(full));
                File.WriteAllBytes(full, bytes);
                AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport);
                copiedFiles++;
            }
            var importer = AssetImporter.GetAtPath(path) as TextureImporter;
            if (importer != null)
            {
                bool normalMap = property == "_BumpMap" || property == "_NormalMap";
                TextureImporterType wantedType = normalMap ? TextureImporterType.NormalMap : TextureImporterType.Default;
                TextureWrapMode wantedWrap = wrapMode == "Clamp" ? TextureWrapMode.Clamp
                    : wrapMode == "Mirror" || wrapMode == "MirrorOnce" ? TextureWrapMode.Mirror : TextureWrapMode.Repeat;
                bool dirty = false;
                if (importer.textureType != wantedType) { importer.textureType = wantedType; dirty = true; }
                if (importer.wrapMode != wantedWrap) { importer.wrapMode = wantedWrap; dirty = true; }
                if (!normalMap && !importer.sRGBTexture) { importer.sRGBTexture = true; dirty = true; }
                if (dirty) importer.SaveAndReimport();
            }
            var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
            nodeLosses.Add("MATERIAL_TEXTURE_IMPORTED: " + materialName + "." + property + " → " + path + "（" + bytes.Length.ToString(CultureInfo.InvariantCulture)
                + " 字节 " + mimeType + (string.IsNullOrEmpty(wrapMode) ? "" : "，wrap=" + wrapMode) + "）");
            return texture;
        }

        /// <summary>
        /// 贴图字节摘要（跨语言一致）：长度 + 每 97 字节取一个样本，喂给同一个 FNV-1a 64。
        /// 产品侧 encodeLpmesh 写进 LPMESH 的 contentDigest 就是这个值，所以两侧能直接比。
        /// </summary>
        internal static string ByteDigest(byte[] bytes)
        {
            var values = new List<long> { bytes.Length };
            for (int index = 0; index < bytes.Length; index += 97) values.Add(bytes[index]);
            return DigestOf(values);
        }

        private static Shader FindShader(string wanted)
        {
            var candidates = new List<string>();
            if (!string.IsNullOrEmpty(wanted)) candidates.Add(wanted);
            candidates.Add("Standard");
            candidates.Add("Universal Render Pipeline/Lit");
            candidates.Add("HDRP/Lit");
            candidates.Add("Legacy Shaders/Diffuse");
            foreach (string name in candidates)
            {
                Shader shader = Shader.Find(name);
                if (shader != null) return shader;
            }
            return null;
        }

        // ── 记录"到底有没有"：Unity 的 JsonUtility 把没有的嵌套记录写成字段默认值实例，从来不是 null ──
        // 所以两边都按内容判存在性；判据写在文档 §6，与产品侧的 hasUnity* 一一对应。

        private static bool HasMesh(MeshRecord record)
        {
            return record != null && (record.vertexCount > 0 || !string.IsNullOrEmpty(record.assetPath) || !string.IsNullOrEmpty(record.file));
        }

        private static bool HasLight(LightRecord record)
        {
            return record != null && !string.IsNullOrEmpty(record.type);
        }

        private static bool HasCamera(CameraRecord record)
        {
            return record != null && (record.fieldOfViewDeg > 0f || record.nearClip > 0f || record.farClip > 0f || record.orthographicSize > 0f);
        }

        private static bool HasPrefab(PrefabRecord record)
        {
            return record != null && (!string.IsNullOrEmpty(record.assetPath) || !string.IsNullOrEmpty(record.status));
        }

        private static bool HasTerrain(TerrainRecord record)
        {
            return record != null && (record.heightmapResolution > 0 || record.meshResolution > 0 || record.widthM > 0f || record.heightM > 0f
                || record.lengthM > 0f || record.treeInstanceCount > 0 || (record.instances != null && record.instances.Length > 0));
        }

        private static void ApplyLight(GameObject target, NodeRecord node)
        {
            if (!HasLight(node.light)) return;
            Light light = target.GetComponent<Light>();
            if (light == null) light = target.AddComponent<Light>();
            LightType type;
            if (!Enum.TryParse(node.light.type, out type)) type = LightType.Point;
            light.type = type;
            light.color = ToColor(node.light.color);
            light.intensity = node.light.intensity == 0f ? 1f : node.light.intensity;
            light.range = node.light.range == 0f ? 10f : node.light.range;
            if (node.light.spotAngleDeg > 0f) light.spotAngle = node.light.spotAngleDeg;
            light.bounceIntensity = node.light.bounceIntensity;
            if (!string.IsNullOrEmpty(node.light.shadows))
            {
                LightShadows shadows;
                if (Enum.TryParse(node.light.shadows, out shadows)) light.shadows = shadows;
            }
            if (node.light.areaSize != null && node.light.areaSize.Length >= 2 && (node.light.areaSize[0] > 0f || node.light.areaSize[1] > 0f))
            {
                try { light.areaSize = new Vector2(node.light.areaSize[0], node.light.areaSize[1]); }
                catch { /* 当前渲染管线不支持面光源尺寸 */ }
            }
            light.enabled = node.light.enabled;
        }

        private static void ApplyCamera(GameObject target, NodeRecord node)
        {
            if (!HasCamera(node.camera)) return;
            Camera camera = target.GetComponent<Camera>();
            if (camera == null) camera = target.AddComponent<Camera>();
            camera.fieldOfView = node.camera.fieldOfViewDeg <= 0f ? 60f : node.camera.fieldOfViewDeg;
            camera.nearClipPlane = node.camera.nearClip <= 0f ? 0.3f : node.camera.nearClip;
            camera.farClipPlane = node.camera.farClip <= 0f ? 1000f : node.camera.farClip;
            camera.orthographic = node.camera.orthographic;
            camera.orthographicSize = node.camera.orthographicSize <= 0f ? 5f : node.camera.orthographicSize;
            camera.depth = node.camera.depth;
            camera.backgroundColor = ToColor(node.camera.background);
            CameraClearFlags flags;
            if (!string.IsNullOrEmpty(node.camera.clearFlags) && Enum.TryParse(node.camera.clearFlags, out flags)) camera.clearFlags = flags;
            camera.enabled = node.camera.enabled;
        }

        /**
         * 地形写回：**高度以交付的 LPMESH 顶点为准**（顶点 y = 归一化高度 × heightM，按规则格点还原成
         * heightmap），不再依赖 Unity 工程里那份侧车文件（产品搬走后侧车就没了）；孔洞从"哪些格子没有
         * 三角形"反推；植被实例优先用文档内联的那份（产品侧按实体当前变换重算过）。
         *
         * 只改交换负责的部分：已有 TerrainData 的层列表/材质模板/细节层不动（层不交换，见 TERRAIN_LAYER_*），
         * 新建的 TerrainData 才按交付的等价贴图补一个层（否则写回去是一块没有贴图的地形）。
         */
        private static void ApplyTerrain(GameObject target, NodeRecord node, string assetFolder, List<string> nodeLosses, LpmeshPayload delivered, ref int copiedFiles)
        {
            if (!HasTerrain(node.terrain)) return;
            TerrainRecord record = node.terrain;
            Terrain terrain = target.GetComponent<Terrain>();
            if (terrain == null) terrain = target.AddComponent<Terrain>();
            TerrainData data = terrain.terrainData;
            bool attachData = data == null;
            if (attachData)
            {
                data = new TerrainData();
                string folder = assetFolder + "/Terrains";
                EnsureAssetFolder(folder);
                string assetPath = folder + "/" + Sanitize(node.name) + "-" + node.index.ToString(CultureInfo.InvariantCulture) + ".asset";
                data.heightmapResolution = Mathf.Max(33, record.heightmapResolution > 0 ? record.heightmapResolution : 33);
                data.size = new Vector3(record.widthM, record.heightM, record.lengthM);
                AssetDatabase.CreateAsset(data, assetPath);
                copiedFiles++;
            }
            int appliedResolution = 0;
            float appliedSizeY = 0f;
            bool fromMesh = false;
            // Unity 会把 heightmapResolution 夹到 2^n+1；真被夹过的话，网格顶点数组的尺寸就和数据对不上了，
            // 只能放弃"用网格写高度"这条路（改走侧车），并在回执里点名，不糊过去。
            bool meshUsable = delivered != null && delivered.mesh != null && record.meshResolution > 1;
            if (meshUsable && data.heightmapResolution != record.meshResolution)
            {
                data.heightmapResolution = record.meshResolution;
                if (data.heightmapResolution != record.meshResolution)
                {
                    nodeLosses.Add("TERRAIN_RESOLUTION_CLAMPED: 交付分辨率 " + record.meshResolution.ToString(CultureInfo.InvariantCulture)
                        + " 被 Unity 夹到 " + data.heightmapResolution.ToString(CultureInfo.InvariantCulture) + "，网格顶点数组尺寸对不上，本次不用网格写高度");
                    meshUsable = false;
                }
            }
            if (meshUsable && delivered.mesh.vertexCount == record.meshResolution * record.meshResolution)
            {
                int resolution = record.meshResolution;
                float sizeX = record.widthM > 0f ? record.widthM : data.size.x;
                float sizeY = record.heightM > 0f ? record.heightM : data.size.y;
                float sizeZ = record.lengthM > 0f ? record.lengthM : data.size.z;
                Vector3[] positions = delivered.mesh.vertices;
                var heights = new float[resolution, resolution];
                var filled = new bool[resolution * resolution];
                bool onLattice = true;
                for (int index = 0; index < positions.Length && onLattice; index++)
                {
                    int column = Mathf.RoundToInt(positions[index].x / sizeX * (resolution - 1));
                    int row = Mathf.RoundToInt(positions[index].z / sizeZ * (resolution - 1));
                    if (column < 0 || column >= resolution || row < 0 || row >= resolution) { onLattice = false; break; }
                    int cell = row * resolution + column;
                    if (filled[cell]) { onLattice = false; break; }   // 两个顶点落在同一格：不是规则格点
                    filled[cell] = true;
                    heights[row, column] = Mathf.Clamp01(positions[index].y / sizeY);
                }
                if (!onLattice) nodeLosses.Add("TERRAIN_MESH_NOT_ON_LATTICE: 交付网格的顶点没落在 " + resolution.ToString(CultureInfo.InvariantCulture) + "×"
                    + resolution.ToString(CultureInfo.InvariantCulture) + " 规则格点上，改用侧车高度图写回");
                else
                {
                    data.size = new Vector3(sizeX, sizeY, sizeZ);
                    data.SetHeights(0, 0, heights);
                    appliedResolution = resolution;
                    appliedSizeY = sizeY;
                    fromMesh = true;
                    nodeLosses.Add("TERRAIN_HEIGHTS_APPLIED_FROM_MESH: " + resolution.ToString(CultureInfo.InvariantCulture) + "×" + resolution.ToString(CultureInfo.InvariantCulture)
                        + " 归一化高度来自交付网格顶点（" + node.mesh.file + "，每点 y ÷ " + sizeY.ToString("R", CultureInfo.InvariantCulture) + " 米）");
                    // 孔洞：交付网格里没有三角形的格子就是被挖掉的（读取时正是这么删的），原样恢复。
                    // 格点索引是 (row × resolution + column)，每个格子的三角形最小行列就是它自己。
                    var covered = new bool[resolution - 1, resolution - 1];
                    int[] indices = delivered.mesh.triangles;
                    for (int triangle = 0; triangle + 2 < indices.Length; triangle += 3)
                    {
                        int bestRow = int.MaxValue, bestColumn = int.MaxValue;
                        for (int corner = 0; corner < 3; corner++)
                        {
                            int vertex = indices[triangle + corner];
                            bestRow = Mathf.Min(bestRow, vertex / resolution);
                            bestColumn = Mathf.Min(bestColumn, vertex % resolution);
                        }
                        if (bestRow >= 0 && bestRow < resolution - 1 && bestColumn >= 0 && bestColumn < resolution - 1) covered[bestColumn, bestRow] = true;
                    }
                    var coverage = new bool[resolution - 1, resolution - 1];
                    int holeCells = 0;
                    for (int row = 0; row < resolution - 1; row++)
                        for (int column = 0; column < resolution - 1; column++)
                        {
                            // SetHoles 收的是"**有地面**"图（true = 有面，false = 孔；真机实测见 ExportTerrain 的注释）。
                            coverage[column, row] = covered[column, row];
                            if (!covered[column, row]) holeCells++;
                        }
                    if (holeCells > 0)
                    {
                        data.SetHoles(0, 0, coverage);
                        nodeLosses.Add("TERRAIN_HOLES_APPLIED: " + holeCells.ToString(CultureInfo.InvariantCulture) + " 个格子按交付网格的缺面恢复为孔洞（SetHoles 的 true = 有地面）");
                        // 真机实测（109 probe-terrain-trees.ts，Unity 6000.3.24f1）：TerrainData 一旦调过
                        // SetHoles（哪怕整张表全 false），treeInstanceCount 就变 0，之后再赋 treeInstances 也留不住。
                        // 本版 Unity 上"孔洞"与"树实例"在脚本口互斥，这里如实记下来，让回执里的人知道树为什么没了。
                        if ((record.instances ?? new TreeInstanceRecord[0]).Length > 0)
                            nodeLosses.Add("TERRAIN_HOLES_BLOCK_TREES: 本版 Unity 的 TerrainData 调过 SetHoles 之后不再接受 treeInstances（孔洞与树实例在脚本口互斥），文档里的 "
                                + (record.instances ?? new TreeInstanceRecord[0]).Length.ToString(CultureInfo.InvariantCulture) + " 棵树写不进去");
                    }
                    else if (record.holeCellCount > 0)
                    {
                        nodeLosses.Add("TERRAIN_HOLES_LOST: 文档说有 " + record.holeCellCount.ToString(CultureInfo.InvariantCulture) + " 个孔洞格，但交付网格里每个格子都有三角形，本次不挖孔");
                    }
                }
            }
            if (!fromMesh && !string.IsNullOrEmpty(record.heightsFile))
            {
                string heightsPath = ResolveProjectPath(record.heightsFile);
                if (!File.Exists(heightsPath)) nodeLosses.Add("TERRAIN_HEIGHTS_MISSING: " + record.heightsFile);
                else
                {
                    int resolution = record.heightmapResolution;
                    byte[] bytes = File.ReadAllBytes(heightsPath);
                    int expected = resolution * resolution * 4;
                    if (bytes.Length != expected)
                    {
                        nodeLosses.Add("TERRAIN_HEIGHTS_SIZE_MISMATCH: 期望 " + expected.ToString(CultureInfo.InvariantCulture) + " 字节，实际 " + bytes.Length.ToString(CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        float[,] heights = new float[resolution, resolution];
                        for (int y = 0; y < resolution; y++)
                            for (int x = 0; x < resolution; x++)
                            {
                                int offset = (y * resolution + x) * 4;
                                heights[y, x] = BitConverter.ToSingle(bytes, offset);
                            }
                        data.SetHeights(0, 0, heights);
                        appliedResolution = resolution;
                        appliedSizeY = data.size.y;
                        nodeLosses.Add("TERRAIN_HEIGHTS_APPLIED: " + resolution.ToString(CultureInfo.InvariantCulture) + "×" + resolution.ToString(CultureInfo.InvariantCulture) + " 来自 " + record.heightsFile);
                    }
                }
            }
            // 植被实例：只有文档明确说"这份清单是权威的"才动 Unity 的 treeInstances。
            // 读侧总是写这份内联清单（空数组 = 真的没有树）并置 treeInstancesAuthoritative；
            // 旧版/手写文档缺这个字段时保持地形原样 —— "文档里没有这一项"不等于"用户把树删了"。
            if (!record.treeInstancesAuthoritative)
            {
                nodeLosses.Add("TERRAIN_TREES_NOT_APPLIED: 文档没带权威的植被清单（treeInstancesAuthoritative=false），Unity 侧原样保留");
            }
            else
            {
                TreeInstanceRecord[] wanted = record.instances ?? new TreeInstanceRecord[0];
                if (wanted.Length == 0)
                {
                    int existing = data.treeInstanceCount;
                    if (existing > 0)
                    {
                        data.treeInstances = new TreeInstance[0];
                        terrain.Flush();
                        int afterClear = data.treeInstanceCount;
                        if (afterClear == 0)
                            nodeLosses.Add("TERRAIN_TREES_CLEARED: 文档里的植被清单是空的（权威清单：确实没有树），清掉地形上原有的 " + existing.ToString(CultureInfo.InvariantCulture) + " 棵（已读回核对）");
                        else
                            nodeLosses.Add("TERRAIN_TREES_CLEAR_FAILED: 文档里的植被清单是空的，想清掉地形上原有的 " + existing.ToString(CultureInfo.InvariantCulture) + " 棵，但 Unity 读回还剩 " + afterClear.ToString(CultureInfo.InvariantCulture) + " 棵");
                    }
                }
                else
                {
                    var prototypes = new List<TreePrototype>();
                    bool prototypesAvailable = true;
                    foreach (TreePrototypeRecord prototype in record.treePrototypes)
                    {
                        GameObject prefab = string.IsNullOrEmpty(prototype.prefabPath) ? null : AssetDatabase.LoadAssetAtPath<GameObject>(prototype.prefabPath);
                        if (prefab == null) { prototypesAvailable = false; nodeLosses.Add("TREE_PROTOTYPE_MISSING: " + prototype.prefabPath); break; }
                        prototypes.Add(new TreePrototype { prefab = prefab, bendFactor = prototype.bendFactor });
                    }
                    if (prototypesAvailable && prototypes.Count > 0)
                    {
                        data.treePrototypes = prototypes.ToArray();
                        var instances = new List<TreeInstance>();
                        foreach (TreeInstanceRecord item in wanted)
                        {
                            int index = item.prototypeIndex;
                            if (index < 0 || index >= prototypes.Count)
                            {
                                nodeLosses.Add("TREE_PROTOTYPE_INDEX_OUT_OF_RANGE: 实例引用的原型 #" + index.ToString(CultureInfo.InvariantCulture)
                                    + " 不在原型表（" + prototypes.Count.ToString(CultureInfo.InvariantCulture) + " 个）里，这棵树跳过");
                                continue;
                            }
                            instances.Add(new TreeInstance
                            {
                                position = ToVector3(item.position),
                                widthScale = item.widthScale,
                                heightScale = item.heightScale,
                                rotation = item.rotationRad,
                                color = ToColor(item.color),
                                prototypeIndex = index,
                                lightmapColor = Color.white,
                            });
                        }
                        data.treeInstances = instances.ToArray();
                        terrain.Flush();
                        // 读回核对：Unity 会对 treeInstances 的赋值静默不生效（例如这版 TerrainData 调过 SetHoles 之后，
                        // 见 probe-terrain-trees.ts）。不回读就报"写好了"等于把丢数据说成成功。
                        int appliedTrees = data.treeInstanceCount;
                        if (appliedTrees == instances.Count)
                            nodeLosses.Add("TERRAIN_TREES_APPLIED: " + instances.Count.ToString(CultureInfo.InvariantCulture) + " 棵、"
                                + prototypes.Count.ToString(CultureInfo.InvariantCulture) + " 个原型（文档内联的实例，已从 Unity 读回核对；原型是项目内既有 prefab，链接保留。实例只带位置/朝向/缩放，几何由 prefab 素材提供）");
                        else
                            nodeLosses.Add("TERRAIN_TREES_DROPPED: 文档要 " + instances.Count.ToString(CultureInfo.InvariantCulture)
                                + " 棵树，Unity 读回只有 " + appliedTrees.ToString(CultureInfo.InvariantCulture) + " 棵 —— 赋值被 Unity 静默丢掉了"
                                + (record.holeCellCount > 0 ? "（地形有 " + record.holeCellCount.ToString(CultureInfo.InvariantCulture) + " 个孔洞格，本版 Unity 上孔洞与树实例互斥）" : ""));
                    }
                    else if (prototypesAvailable && prototypes.Count == 0)
                    {
                        nodeLosses.Add("TERRAIN_TREES_NOT_APPLIED: 文档的原型表是空的，" + wanted.Length.ToString(CultureInfo.InvariantCulture) + " 棵树没有原型可用");
                    }
                    else nodeLosses.Add("TERRAIN_TREES_NOT_APPLIED: " + wanted.Length.ToString(CultureInfo.InvariantCulture) + " 棵树的原型 prefab 在本工程里找不到，本次不写回树实例");
                }
            }
            if (attachData)
            {
                terrain.terrainData = data;
                if (target.GetComponent<TerrainCollider>() == null) target.AddComponent<TerrainCollider>().terrainData = data;
                // 脚本建的 Terrain 没有材质模板，不补的话整块地形渲染成品红（Missing material）。
                if (terrain.materialTemplate == null)
                {
                    Shader terrainShader = Shader.Find("Nature/Terrain/Standard");
                    if (terrainShader != null) terrain.materialTemplate = new Material(terrainShader);
                    else nodeLosses.Add("TERRAIN_MATERIAL_MISSING: 找不到 Unity 自带地形着色器，地形会显示为品红");
                }
                // 新建的地形没有层列表：按交付的等价漫反射贴图补一个层，写回 Unity 后不是一块没贴图的地。
                // 已有 TerrainData 的层一律不动（层列表本身不交换）。
                if (!string.IsNullOrEmpty(record.textureFile))
                {
                    string texturePath = ResolveProjectPath(record.textureFile);
                    if (!File.Exists(texturePath)) nodeLosses.Add("TERRAIN_TEXTURE_MISSING: " + record.textureFile);
                    else
                    {
                        try
                        {
                            byte[] textureBytes = File.ReadAllBytes(texturePath);
                            Texture2D imported = ImportTexture(assetFolder, string.IsNullOrEmpty(node.name) ? "Terrain" : node.name, "_MainTex", textureBytes, "image/png", "Repeat", nodeLosses, ref copiedFiles) as Texture2D;
                            if (imported != null)
                            {
                                string layerFolder = assetFolder + "/TerrainLayers";
                                EnsureAssetFolder(layerFolder);
                                string layerPath = layerFolder + "/" + Sanitize(node.name) + "-blend.terrainlayer";
                                TerrainLayer layer = AssetDatabase.LoadAssetAtPath<TerrainLayer>(layerPath);
                                if (layer == null) { layer = new TerrainLayer(); AssetDatabase.CreateAsset(layer, layerPath); }
                                layer.diffuseTexture = imported;
                                layer.tileSize = new Vector2(record.widthM, record.lengthM);
                                data.terrainLayers = new[] { layer };
                                EditorUtility.SetDirty(layer);
                                nodeLosses.Add("TERRAIN_LAYER_FROM_BAKED_TEXTURE: 新建地形按交付的等价贴图建了 1 个层（" + layerPath + "，tileSize=" + layer.tileSize.ToString("R", CultureInfo.InvariantCulture) + "）");
                            }
                        }
                        catch (Exception error) { nodeLosses.Add("TERRAIN_TEXTURE_IMPORT_FAILED: " + error.Message); }
                    }
                }
            }
            EditorUtility.SetDirty(data);
            if (appliedResolution > 0) nodeLosses.Add("TERRAIN_APPLIED: 分辨率 " + appliedResolution.ToString(CultureInfo.InvariantCulture) + "、高度尺度 "
                + appliedSizeY.ToString("R", CultureInfo.InvariantCulture) + " 米、来源 " + (fromMesh ? "交付网格顶点" : "侧车高度图"));
        }

        // ── 路径与数值工具 ──────────────────────────────────────────────────────

        private static Scene ResolveScene(string scenePath)
        {
            if (!string.IsNullOrEmpty(scenePath))
            {
                Scene loaded = SceneManager.GetSceneByPath(scenePath);
                if (loaded.IsValid() && loaded.isLoaded) return loaded;
                Scene byName = SceneManager.GetSceneByName(Path.GetFileNameWithoutExtension(scenePath));
                if (byName.IsValid() && byName.isLoaded) return byName;
                return EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Additive);
            }
            return SceneManager.GetActiveScene();
        }

        /// <summary>项目相对路径（Assets/... 或 Library/...）取绝对；已经是绝对路径就原样返回。</summary>
        public static string ResolveProjectPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return "";
            return Path.IsPathRooted(path) ? Path.GetFullPath(path) : Path.GetFullPath(Path.Combine(ProjectRoot, path));
        }

        private static string ProjectRelative(string absolutePath)
        {
            string root = ProjectRoot;
            string full = Path.GetFullPath(absolutePath);
            if (full.StartsWith(root, StringComparison.Ordinal))
                return full.Substring(root.Length).TrimStart(Path.DirectorySeparatorChar, '/');
            return full;
        }

        private static void EnsureAssetFolder(string assetFolder)
        {
            if (AssetDatabase.IsValidFolder(assetFolder)) return;
            string[] parts = assetFolder.Split('/');
            string current = parts[0];
            for (int index = 1; index < parts.Length; index++)
            {
                string next = current + "/" + parts[index];
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(current, parts[index]);
                current = next;
            }
        }

        private static string Sanitize(string name)
        {
            if (string.IsNullOrEmpty(name)) return "Unnamed";
            var builder = new StringBuilder(name.Length);
            foreach (char character in name)
                builder.Append(char.IsLetterOrDigit(character) || character == '-' || character == '_' ? character : '_');
            return builder.ToString();
        }

        private static Vector3 ToVector3(float[] values)
        {
            if (values == null || values.Length < 3) return Vector3.zero;
            return new Vector3(values[0], values[1], values[2]);
        }

        private static Quaternion ToQuaternion(float[] values)
        {
            if (values == null || values.Length < 4) return Quaternion.identity;
            var quaternion = new Quaternion(values[0], values[1], values[2], values[3]);
            float norm = Mathf.Sqrt(quaternion.x * quaternion.x + quaternion.y * quaternion.y + quaternion.z * quaternion.z + quaternion.w * quaternion.w);
            return norm < 1e-8f ? Quaternion.identity : new Quaternion(quaternion.x / norm, quaternion.y / norm, quaternion.z / norm, quaternion.w / norm);
        }

        private static Color ToColor(float[] values)
        {
            if (values == null || values.Length < 3) return Color.white;
            return new Color(values[0], values[1], values[2], values.Length > 3 ? values[3] : 1f);
        }
    }

    // ────────────────────────────────────────────────────────────────────────────
    // GLB 写出器：把 Unity 网格写成产品能直接使用的自包含 GLB（无外部依赖、不装任何包）。
    //
    // 约定（与产品侧 unity-exchange.ts 的换算同一对合映射）：
    //   产品空间 = 右手 Z-up 米制；Unity 顶点 v 写为 (v.x, v.z, v.y)；
    //   法线同样换算；因为该映射是镜像（det=-1），三角形绕序反转以保持外法线朝向。
    // 明确不写：蒙皮权重、混合形状、动画、切线/第二套 UV（UV 与 baseColor 贴图自 v2 起会写）。
    // ────────────────────────────────────────────────────────────────────────────

    internal static class GlbWriter
    {
        public static long Write(string path, Mesh mesh, Material[] materials, string meshName)
        {
            Vector3[] vertices = mesh.vertices;
            Vector3[] normals = mesh.normals;
            int vertexCount = vertices.Length;
            if (vertexCount == 0) throw new InvalidOperationException("MESH_EMPTY");
            Vector2[] uvs = mesh.uv != null && mesh.uv.Length == vertexCount ? mesh.uv : null;

            var positions = new byte[vertexCount * 12];
            var normalBytes = new byte[vertexCount * (normals.Length == vertexCount ? 12 : 0)];
            var uvBytes = new byte[vertexCount * (uvs != null ? 8 : 0)];
            for (int index = 0; index < vertexCount; index++)
            {
                Vector3 vertex = vertices[index];
                WriteFloat(positions, index * 12 + 0, vertex.x);
                WriteFloat(positions, index * 12 + 4, vertex.z);
                WriteFloat(positions, index * 12 + 8, vertex.y);
                if (normalBytes.Length > 0)
                {
                    Vector3 normal = normals[index];
                    WriteFloat(normalBytes, index * 12 + 0, normal.x);
                    WriteFloat(normalBytes, index * 12 + 4, normal.z);
                    WriteFloat(normalBytes, index * 12 + 8, normal.y);
                }
                // UV：Unity 是左下原点，glTF 是左上原点，只把 v 翻过来（u 不动）。
                // 位置是镜像映射，但 UV 是贴图坐标、不随几何镜像走，所以只翻 v。
                if (uvBytes.Length > 0 && uvs != null)
                {
                    WriteFloat(uvBytes, index * 8 + 0, uvs[index].x);
                    WriteFloat(uvBytes, index * 8 + 4, 1f - uvs[index].y);
                }
            }

            int subMeshCount = Mathf.Max(1, mesh.subMeshCount);
            var indexBytes = new List<byte>();
            var indexCounts = new List<int>();
            var indexOffsets = new List<int>();
            bool wide = vertexCount > 65535;
            for (int subMesh = 0; subMesh < subMeshCount; subMesh++)
            {
                int[] triangles = mesh.GetTriangles(subMesh);
                indexOffsets.Add(indexBytes.Count);
                indexCounts.Add(triangles.Length);
                // 镜像映射：反转绕序（i0, i2, i1）保持正面朝外。
                for (int index = 0; index + 2 < triangles.Length; index += 3)
                {
                    AppendIndex(indexBytes, triangles[index + 0], wide);
                    AppendIndex(indexBytes, triangles[index + 2], wide);
                    AppendIndex(indexBytes, triangles[index + 1], wide);
                }
            }

            // 贴图：每个子网格材质的 baseColor 贴图**内嵌进 GLB**（同一张图只嵌一次）。
            // 为什么内嵌：Viewer 直接读这个 GLB，引用 Unity 资产路径它渲染不出来；
            // 内嵌之后贴图是随文件走的，不需要目标环境里有任何 Unity 资产。
            var images = new List<LyapunovSceneExchange.TexturePayload>();
            var imageIndexOf = new Dictionary<string, int>(StringComparer.Ordinal);
            var materialImages = new int[subMeshCount];
            for (int subMesh = 0; subMesh < subMeshCount; subMesh++)
            {
                materialImages[subMesh] = -1;
                Material material = materials != null && subMesh < materials.Length ? materials[subMesh] : null;
                Texture texture = BaseColorTextureOf(material);
                if (texture == null) continue;
                LyapunovSceneExchange.TexturePayload payload;
                string error;
                if (!LyapunovSceneExchange.TryTexturePayload(texture, out payload, out error)) continue;   // 读不出来只丢贴图，颜色照写
                int existing;
                if (imageIndexOf.TryGetValue(payload.contentDigest, out existing)) { materialImages[subMesh] = existing; continue; }
                imageIndexOf[payload.contentDigest] = images.Count;
                materialImages[subMesh] = images.Count;
                images.Add(payload);
            }

            // 缓冲区分段：位置 / [法线] / [UV] / 每子网格索引 / 内嵌图片，段内偏移按 4 字节对齐。
            var binary = new List<byte>();
            int positionOffset = Align4(binary);
            binary.AddRange(positions);
            int normalOffset = normalBytes.Length > 0 ? Align4(binary) : 0;
            if (normalBytes.Length > 0) binary.AddRange(normalBytes);
            int uvOffset = uvBytes.Length > 0 ? Align4(binary) : 0;
            if (uvBytes.Length > 0) binary.AddRange(uvBytes);
            var indexOffset = new int[subMeshCount];
            for (int subMesh = 0; subMesh < subMeshCount; subMesh++)
            {
                indexOffset[subMesh] = Align4(binary);
                AppendIndexRange(binary, indexBytes, indexOffsets[subMesh], indexCounts[subMesh], wide);
            }
            var imageOffset = new int[images.Count];
            for (int index = 0; index < images.Count; index++)
            {
                imageOffset[index] = Align4(binary);
                binary.AddRange(images[index].bytes);
            }
            byte[] binaryBytes = binary.ToArray();

            var min = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue);
            var max = new Vector3(float.MinValue, float.MinValue, float.MinValue);
            foreach (Vector3 vertex in vertices)
            {
                var converted = new Vector3(vertex.x, vertex.z, vertex.y);
                min = Vector3.Min(min, converted);
                max = Vector3.Max(max, converted);
            }

            // 视图/访问器编号：先按"有没有法线/UV"定下静态属性，再排每子网格索引，最后是图片。
            int bufferViewIndex = 0;
            int positionView = bufferViewIndex++;
            int normalView = normalBytes.Length > 0 ? bufferViewIndex++ : -1;
            int uvView = uvBytes.Length > 0 ? bufferViewIndex++ : -1;
            int firstIndexView = bufferViewIndex;
            bufferViewIndex += subMeshCount;
            int firstImageView = bufferViewIndex;
            int accessorIndex = 0;
            int positionAccessor = accessorIndex++;
            int normalAccessor = normalBytes.Length > 0 ? accessorIndex++ : -1;
            int uvAccessor = uvBytes.Length > 0 ? accessorIndex++ : -1;
            int firstIndexAccessor = accessorIndex;

            var json = new StringBuilder();
            json.Append("{\"asset\":{\"version\":\"2.0\",\"generator\":\"lyapunov-scene-exchange\"}");
            json.Append(",\"scene\":0,\"scenes\":[{\"nodes\":[0]}]");
            json.Append(",\"nodes\":[{\"name\":").Append(JsonString(meshName)).Append(",\"mesh\":0}]");
            json.Append(",\"meshes\":[{\"name\":").Append(JsonString(meshName)).Append(",\"primitives\":[");
            for (int subMesh = 0; subMesh < subMeshCount; subMesh++)
            {
                if (subMesh > 0) json.Append(',');
                json.Append("{\"attributes\":{\"POSITION\":").Append(positionAccessor);
                if (normalView >= 0) json.Append(",\"NORMAL\":").Append(normalAccessor);
                if (uvView >= 0) json.Append(",\"TEXCOORD_0\":").Append(uvAccessor);
                json.Append("},\"indices\":").Append(firstIndexAccessor + subMesh);
                json.Append(",\"material\":").Append(subMesh);
                json.Append("}");
            }
            json.Append("]}]");
            json.Append(",\"materials\":[");
            var materialList = BuildMaterials(materials, subMeshCount, materialImages);
            for (int index = 0; index < materialList.Count; index++)
            {
                if (index > 0) json.Append(',');
                json.Append(materialList[index]);
            }
            json.Append("]");
            if (images.Count > 0)
            {
                json.Append(",\"images\":[");
                for (int index = 0; index < images.Count; index++)
                {
                    if (index > 0) json.Append(',');
                    json.Append("{\"name\":").Append(JsonString("texture-" + index.ToString(CultureInfo.InvariantCulture)))
                        .Append(",\"bufferView\":").Append(firstImageView + index)
                        .Append(",\"mimeType\":").Append(JsonString(images[index].mimeType)).Append("}");
                }
                json.Append("]");
                json.Append(",\"samplers\":[");
                for (int index = 0; index < images.Count; index++)
                {
                    if (index > 0) json.Append(',');
                    int wrap = WrapCodeOf(images[index].wrapMode);
                    json.Append("{\"wrapS\":").Append(wrap).Append(",\"wrapT\":").Append(wrap).Append("}");
                }
                json.Append("]");
                json.Append(",\"textures\":[");
                for (int index = 0; index < images.Count; index++)
                {
                    if (index > 0) json.Append(',');
                    json.Append("{\"sampler\":").Append(index).Append(",\"source\":").Append(index).Append("}");
                }
                json.Append("]");
            }

            json.Append(",\"accessors\":[");
            json.Append(Accessor(positionView, vertexCount, "VEC3", min, max));
            if (normalView >= 0) json.Append(',').Append(Accessor(normalView, vertexCount, "VEC3", null, null));
            if (uvView >= 0) json.Append(',').Append(Accessor(uvView, vertexCount, "VEC2", null, null));
            for (int subMesh = 0; subMesh < subMeshCount; subMesh++)
                json.Append(',').Append(IndexAccessor(firstIndexView + subMesh, indexCounts[subMesh], wide));
            json.Append("]");

            json.Append(",\"bufferViews\":[{\"buffer\":0,\"byteOffset\":").Append(positionOffset).Append(",\"byteLength\":").Append(positions.Length).Append(",\"target\":34962}");
            if (normalView >= 0) json.Append(",{\"buffer\":0,\"byteOffset\":").Append(normalOffset).Append(",\"byteLength\":").Append(normalBytes.Length).Append(",\"target\":34962}");
            if (uvView >= 0) json.Append(",{\"buffer\":0,\"byteOffset\":").Append(uvOffset).Append(",\"byteLength\":").Append(uvBytes.Length).Append(",\"target\":34962}");
            for (int subMesh = 0; subMesh < subMeshCount; subMesh++)
                json.Append(",{\"buffer\":0,\"byteOffset\":").Append(indexOffset[subMesh]).Append(",\"byteLength\":").Append(indexCounts[subMesh] * (wide ? 4 : 2)).Append(",\"target\":34963}");
            for (int index = 0; index < images.Count; index++)
                json.Append(",{\"buffer\":0,\"byteOffset\":").Append(imageOffset[index]).Append(",\"byteLength\":").Append(images[index].bytes.Length).Append("}");
            json.Append("]");
            json.Append(",\"buffers\":[{\"byteLength\":").Append(binaryBytes.Length).Append("}]");
            json.Append("}");

            byte[] jsonBytes = Encoding.UTF8.GetBytes(json.ToString());
            int jsonPadded = (jsonBytes.Length + 3) / 4 * 4;
            int binaryPadded = (binaryBytes.Length + 3) / 4 * 4;
            int total = 12 + 8 + jsonPadded + 8 + binaryPadded;

            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
            // 落盘用"临时文件 + 原子改名"，**不就地截断**目标文件：产品资源库是把源文件硬链进库的
            // （resources.ts 的 link 快路径），就地写会把**已经交付出去的那份资产**在脚下改掉
            // ——109 真机实测：同一 inode（链接数 3）被第二次导出就地覆盖，产品的 catalog 里记的
            // sha256 d7500ea1… 与磁盘上的 127286b3… 对不上了。改名换的是目录项，旧 inode 留在库里。
            string staging = LyapunovSceneExchange.StagingPath(path);
            using (FileStream stream = File.Create(staging))
            using (BinaryWriter writer = new BinaryWriter(stream))
            {
                writer.Write(0x46546C67);          // "glTF"
                writer.Write(2);
                writer.Write(total);
                writer.Write(jsonPadded);
                writer.Write(0x4E4F534A);          // "JSON"
                writer.Write(jsonBytes);
                for (int index = jsonBytes.Length; index < jsonPadded; index++) writer.Write((byte)0x20);
                writer.Write(binaryPadded);
                writer.Write(0x004E4942);          // "BIN\0"
                writer.Write(binaryBytes);
                for (int index = binaryBytes.Length; index < binaryPadded; index++) writer.Write((byte)0);
            }
            LyapunovSceneExchange.CommitStagedFile(staging, path);
            return new FileInfo(path).Length;
        }

        private static List<string> BuildMaterials(Material[] materials, int subMeshCount, int[] materialImages)
        {
            var list = new List<string>();
            for (int index = 0; index < subMeshCount; index++)
            {
                Material material = materials != null && index < materials.Length ? materials[index] : null;
                Color color = Color.white;
                float metallic = 0f, smoothness = 0.5f;
                string name = "default";
                if (material != null)
                {
                    name = material.name;
                    color = material.HasProperty("_BaseColor") ? material.GetColor("_BaseColor")
                        : material.HasProperty("_Color") ? material.GetColor("_Color") : Color.white;
                    if (material.HasProperty("_Metallic")) metallic = material.GetFloat("_Metallic");
                    if (material.HasProperty("_Smoothness")) smoothness = material.GetFloat("_Smoothness");
                    else if (material.HasProperty("_Glossiness")) smoothness = material.GetFloat("_Glossiness");
                }
                var builder = new StringBuilder();
                builder.Append("{\"name\":").Append(JsonString(name)).Append(",\"pbrMetallicRoughness\":{\"baseColorFactor\":[")
                    .Append(F(color.r)).Append(',').Append(F(color.g)).Append(',').Append(F(color.b)).Append(',').Append(F(color.a))
                    .Append("],\"metallicFactor\":").Append(F(metallic))
                    .Append(",\"roughnessFactor\":").Append(F(1f - Mathf.Clamp01(smoothness)));
                int image = materialImages != null && index < materialImages.Length ? materialImages[index] : -1;
                if (image >= 0) builder.Append(",\"baseColorTexture\":{\"index\":").Append(image).Append(",\"texCoord\":0}");
                builder.Append("}}");
                list.Add(builder.ToString());
            }
            return list;
        }

        /// <summary>材质的 baseColor 主贴图：URP 用 _BaseMap，内置/旧管线用 _MainTex。</summary>
        private static Texture BaseColorTextureOf(Material material)
        {
            if (material == null) return null;
            if (material.HasProperty("_BaseMap") && material.GetTexture("_BaseMap") != null) return material.GetTexture("_BaseMap");
            if (material.HasProperty("_MainTex") && material.GetTexture("_MainTex") != null) return material.GetTexture("_MainTex");
            return null;
        }

        /// <summary>Unity 的 wrap 模式 → glTF sampler 常量（10497 Repeat / 33071 Clamp / 33648 Mirrored）。</summary>
        private static int WrapCodeOf(string wrapMode)
        {
            if (wrapMode == "Clamp") return 33071;
            if (wrapMode == "Mirror" || wrapMode == "MirrorOnce") return 33648;
            return 10497;
        }

        /// <summary>把二进制缓冲补齐到 4 字节边界（glTF 访问器要求），返回补齐后的偏移。</summary>
        private static int Align4(List<byte> binary)
        {
            while (binary.Count % 4 != 0) binary.Add(0);
            return binary.Count;
        }

        /// <summary>
        /// 拷一个子网格的索引区段。`count` 是**索引条目数**，不是字节数：每条 2 字节（ushort）或 4 字节（uint）。
        /// 这里曾经按字节拷，导致 bufferView 声明的 byteLength 是实际写入量的 2/4 倍、区段互相重叠，
        /// 多子网格的 GLB 直接越界读（Viewer 侧表现成索引错乱 / RangeError）。
        /// </summary>
        private static void AppendIndexRange(List<byte> target, List<byte> source, int offset, int count, bool wide)
        {
            int byteCount = count * (wide ? 4 : 2);
            for (int index = 0; index < byteCount; index++) target.Add(source[offset + index]);
        }

        private static string Accessor(int bufferView, int count, string type, Vector3? min, Vector3? max)
        {
            var builder = new StringBuilder();
            builder.Append("{\"bufferView\":").Append(bufferView).Append(",\"componentType\":5126,\"count\":").Append(count).Append(",\"type\":\"").Append(type).Append("\"");
            if (min.HasValue) builder.Append(",\"min\":[").Append(F(min.Value.x)).Append(',').Append(F(min.Value.y)).Append(',').Append(F(min.Value.z)).Append("]");
            if (max.HasValue) builder.Append(",\"max\":[").Append(F(max.Value.x)).Append(',').Append(F(max.Value.y)).Append(',').Append(F(max.Value.z)).Append("]");
            builder.Append("}");
            return builder.ToString();
        }

        private static string IndexAccessor(int bufferView, int count, bool wide)
        {
            return "{\"bufferView\":" + bufferView.ToString(CultureInfo.InvariantCulture) + ",\"componentType\":" + (wide ? 5125 : 5123)
                + ",\"count\":" + count.ToString(CultureInfo.InvariantCulture) + ",\"type\":\"SCALAR\"}";
        }

        private static void AppendIndex(List<byte> bytes, int value, bool wide)
        {
            if (wide) { bytes.AddRange(BitConverter.GetBytes(value)); }
            else { bytes.AddRange(BitConverter.GetBytes((ushort)value)); }
        }

        private static void WriteFloat(byte[] target, int offset, float value)
        {
            byte[] bytes = BitConverter.GetBytes(value);
            target[offset] = bytes[0]; target[offset + 1] = bytes[1]; target[offset + 2] = bytes[2]; target[offset + 3] = bytes[3];
        }

        private static string F(float value)
        {
            if (float.IsNaN(value) || float.IsInfinity(value)) value = 0f;
            return value.ToString("R", CultureInfo.InvariantCulture);
        }

        private static string JsonString(string value)
        {
            if (string.IsNullOrEmpty(value)) return "\"\"";
            var builder = new StringBuilder("\"");
            foreach (char character in value)
            {
                switch (character)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (character < 0x20) builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                        else builder.Append(character);
                        break;
                }
            }
            return builder.Append('"').ToString();
        }
    }
}
#endif
