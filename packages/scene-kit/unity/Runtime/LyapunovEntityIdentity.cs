using UnityEngine;

namespace Lyapunov.SceneExchange
{
    /// <summary>
    /// 稳定实体身份：把产品 Scene 的 entityId 存在 Unity 对象上，跨保存/重开/往返交换不变。
    ///
    /// 为什么需要它：Unity 自己的持久身份（GlobalObjectId / 文件 GUID + fileID）只在 Unity 内稳定，
    /// 产品 entityId 是另一套命名空间。往返交换（产品场景 → Unity → 产品场景）若不携带原始 ID，
    /// 第二次导出的实体就会被当成新对象（批注/历史/引用全部对不上）。这个组件是**唯一**的身份载体：
    ///   - 导入时由 LyapunovSceneExchange 写入产品给的 entityId；
    ///   - 导出时优先读它；没有它（用户手工建的对象）才回退到按 GlobalObjectId 派生的稳定 ID。
    ///
    /// 它是运行时脚本（不是 Editor 脚本），因为身份要随场景一起序列化、随构建进入播放器；
    /// 组件本身不做任何计算、不注册任何回调，纯粹是数据。
    /// </summary>
    [DisallowMultipleComponent]
    public class LyapunovEntityIdentity : MonoBehaviour
    {
        [Tooltip("产品 Scene 的 entityId（交换层的稳定身份，例如 entity_unity_ab12…）")]
        public string entityId = "";
    }
}
