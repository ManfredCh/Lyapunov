/** 只投影本模块声明的状态；未知技术值及原始来源/许可正文原样保留。 */
const labels:Record<string,readonly [string,string]>={
 EXTERNAL_CONTROLLER_NOT_INTEGRATED:['外部控制器尚未集成','The external controller is not integrated.'],
 DEFAULT_POLICY_NOT_SUPPLIED:['本版本未提供可用的默认策略缓存','This release does not supply a usable default policy cache.'],
 MODEL_NOT_BUNDLED:['模型未随此版本提供，可按需导入','The model is not bundled with this release; import it on demand.'],
 LICENSE_UNVERIFIED:['未核对','Unverified'],
 CONTROL_UNDECLARED:['未声明','Undeclared'],
 ROBOT_LIBRARY_UNAVAILABLE:['机器人库不可用','The robot library is unavailable.'],
 POLICY_RUNTIME_UNAVAILABLE:['基础运动运行时未就绪；请在软件安装入口准备 policy-cpu 后刷新。','The motion runtime is unavailable; install policy-cpu and refresh.'],
 DEFAULT_POLICY_LICENSE_MISSING:['固定来源未提供策略许可证，不能默认分发。','The fixed source has no policy license; default distribution is blocked.'],
 suitable:['适合原生直控','Suitable for native control'],
 requiresPolicy:['需要对应机型策略','Requires a policy for the matching model'],
 requiresExternalController:['需要外部控制器','Requires an external controller'],
 nativeLocalPidExperimental:['本地 PID 实验控制','Experimental local PID control'],
}
const legacy:Record<string,string>={
 '外部控制器尚未集成':'EXTERNAL_CONTROLLER_NOT_INTEGRATED',
 '本版本未提供可用的默认策略缓存':'DEFAULT_POLICY_NOT_SUPPLIED',
 '模型未随此版本提供，可按需导入':'MODEL_NOT_BUNDLED',
 '未核对':'LICENSE_UNVERIFIED','未声明':'CONTROL_UNDECLARED','机器人库不可用':'ROBOT_LIBRARY_UNAVAILABLE',
}
export function robotLibraryText(value:string,tr:(zh:string,en:string)=>string):string{
 const code=value.startsWith('POLICY_RUNTIME_UNAVAILABLE:')?'POLICY_RUNTIME_UNAVAILABLE':legacy[value]??value
 const pair=labels[code]
 return pair?tr(pair[0],pair[1]):value
}
