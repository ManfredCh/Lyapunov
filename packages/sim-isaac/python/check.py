"""仅检查独立解释器元数据、既有许可选择与 RTX shader/cache 状态；不导入 Kit、不接受许可、不写标记。"""
import importlib.metadata
import importlib.util
import json
import os
import pathlib
import sys

def sdk_facts(launcher=None):
    """同一份只读 SDK 定位：pip 元数据或官方 standalone 布局，均需实际模块定位。"""
    facts={'moduleFound':False,'sdkVersion':None,'sdkRoot':None,
           'pythonVersion':'.'.join(str(n) for n in sys.version_info[:3]),'pythonExecutable':sys.executable}
    try:spec=importlib.util.find_spec('isaacsim')
    except (ImportError,ValueError,AttributeError):return facts
    if spec is None:return facts
    locations=list(spec.submodule_search_locations or [])
    if spec.origin and spec.origin not in ('built-in','frozen'):locations.append(spec.origin)
    facts['moduleFound']=bool(locations)
    if not facts['moduleFound']:return facts
    try:
        distribution=importlib.metadata.distribution('isaacsim')
        root=pathlib.Path(distribution.locate_file('isaacsim')).resolve()
        if any(pathlib.Path(location).resolve().is_relative_to(root) for location in locations):
            facts.update({'sdkVersion':distribution.version,'sdkRoot':str(root)})
            return facts
    except importlib.metadata.PackageNotFoundError:pass
    # 裸 VERSION 文件不能充当 SDK：模块必须位于同一官方安装根，且 Kit/扩展目录真实存在。
    roots=[]
    if os.environ.get('ISAAC_PATH'):roots.append(pathlib.Path(os.environ['ISAAC_PATH']))
    if launcher and pathlib.Path(launcher).name=='python.sh':roots.append(pathlib.Path(launcher).parent)
    for candidate in roots:
        root=candidate.resolve()
        if not (root/'kit').is_dir() or not any((root/name).is_dir() for name in ('exts','extscache')):continue
        if not any(pathlib.Path(location).resolve().is_relative_to(root) for location in locations):continue
        try:
            version_file=root/'VERSION'
            if not version_file.is_file() or version_file.stat().st_size>4096:continue
            version=version_file.read_text().splitlines()[0].strip()
        except (OSError,IndexError):continue
        if version in ('6.0.1','6.0.1.0'):
            facts.update({'sdkVersion':version,'sdkRoot':str(root)})
            return facts
        facts.update({'sdkVersion':version,'sdkRoot':str(root)})
    return facts

def check():
    result={'provider':'isaac','python':sys.executable,'status':'BLOCKED','stage':'sdk-discovery','missing':[]}
    facts=sdk_facts()
    result.update({'moduleFound':facts['moduleFound'],'pythonVersion':facts['pythonVersion']})
    if not facts['moduleFound'] or not facts['sdkRoot']:
        result['missing']=['isaacsim SDK/Kit/PhysX'];result['code']='PROVIDER_UNAVAILABLE';return result
    result['stage']='sdk-version'
    if facts['sdkVersion'] not in ('6.0.1','6.0.1.0'):
        result.update({'sdkVersion':facts['sdkVersion'],'code':'PROVIDER_VERSION_INCOMPATIBLE','missing':['Isaac Sim 6.0.1（当前版本不兼容）']});return result
    root=pathlib.Path(facts['sdkRoot'])
    result.update({'sdkVersion':facts['sdkVersion'],'sdkRoot':str(root),'stage':'sdk-layout'})
    if not (root/'kit').is_dir():
        result.update({'code':'PROVIDER_UNAVAILABLE','missing':['Isaac Kit 安装目录']});return result
    result['stage']='sdk-license'
    marker=root/'kit/EULA_ACCEPTED'
    accepted=os.environ.get('OMNI_KIT_ACCEPT_EULA','N').lower() in ('y','yes','1')
    if marker.exists():
        try:
            accepted=accepted or marker.read_text().splitlines()[0].strip().lower() in ('y','yes','1')
        except (OSError,IndexError):
            result['licenseMarkerReadable']=False
    result.update({'sdkVersion':facts['sdkVersion'],'sdkRoot':str(root),'eulaAccepted':accepted,'eulaUrl':'https://docs.omniverse.nvidia.com/platform/latest/common/NVIDIA_Omniverse_License_Agreement.html'})
    if not accepted:
        result['code']='LICENSE_CONFIRMATION_REQUIRED';result['missing']=['用户明确接受当前 Omniverse Kit EULA'];return result
    result.update({'status':'AVAILABLE','code':'DEPENDENCIES_PRESENT','stage':'sdk-preflight-complete'})
    if os.environ.get('LYAPUNOV_ISAAC_RENDERING')=='rtx':
        result['cache']=cache_status()
    return result

def startup_failure(state):
    """worker 启动错误保留精确阶段；SDK 缺失不能被说成已尝试 PhysX 后端。"""
    stage=state.get('stage','sdk-discovery')
    code={'sdk-discovery':'ISAAC_SDK_UNAVAILABLE','sdk-layout':'ISAAC_SDK_UNAVAILABLE',
          'sdk-version':'ISAAC_SDK_VERSION_INCOMPATIBLE','sdk-license':'ISAAC_LICENSE_CONFIRMATION_REQUIRED'}.get(stage,state['code'])
    detail='; '.join(state.get('missing',[]))
    return {'code':code,'message':code+': '+detail+'（阶段：'+stage+'）','details':state}

def cache_status():
    """只读 RTX shader/cache 预检：存在性、版本键、冷启动分类。
    只读目录元数据；不创建/不修改任何缓存目录；条件不足或读取失败降级为 UNKNOWN，不抛出。"""
    root=os.environ.get('LYAPUNOV_ISAAC_CACHE');rendering=os.environ.get('LYAPUNOV_ISAAC_RENDERING','none')
    result={'rendering':rendering,'cacheRoot':root,'expectedVersion':None,'status':'UNKNOWN',
            'shadercache':None,'nvShadercache':None,'versionsPresent':[],'coldStartWarning':None}
    if rendering!='rtx':
        result['status']='DISABLED';result['coldStartWarning']='rendering!=rtx，不涉及 RTX shader/cache';return result
    if not root:
        result['coldStartWarning']='未提供缓存根（LYAPUNOV_ISAAC_CACHE 为空），无法判定冷/热';return result
    version=sdk_facts()['sdkVersion']
    if version not in ('6.0.1','6.0.1.0'):
        result['coldStartWarning']='未安装 isaacsim，无法解析缓存版本键';return result
    result['expectedVersion']=version
    rtx=pathlib.Path(root)/'rtx-cache';expected=rtx/version
    count=lambda directory:sum(1 for entry in directory.rglob('*') if entry.is_file()) if directory.is_dir() else 0
    try:
        result['shadercache']=count(expected/'shadercache');result['nvShadercache']=count(expected/'nv_shadercache')
        result['versionsPresent']=sorted(p.name for p in rtx.iterdir() if p.is_dir()) if rtx.is_dir() else []
    except OSError:
        result['coldStartWarning']='读取缓存根失败（权限或I/O错误），本次无法判定冷/热';return result
    if not rtx.is_dir():
        result['status']='MISSING'
        result['coldStartWarning']='rtx-cache 根不存在；首次 RTX 运行将进行一次性 shader/管线编译，调用方需预留 ≥300s 时限并标注 cold'
    elif not expected.is_dir():
        result['status']='VERSION_MISMATCH' if result['versionsPresent'] else 'COLD'
        result['coldStartWarning']=f'期望版本键 {version} 目录缺失，rtx-cache 下现有版本 {result["versionsPresent"]}；本次按 cold 处理'
    elif result['nvShadercache']>0:
        result['status']='HOT'
    elif result['shadercache']>0:
        result['status']='PARTIAL'
        result['coldStartWarning']='只有 shadercache 有文件、nv_shadercache 为空：驱动 shader 缓存缺失或已随驱动变更失效，建议按 cold 预留时限'
    else:
        result['status']='COLD'
        result['coldStartWarning']=f'版本键 {version} 目录存在但为空；首次 RTX 运行将进行一次性 shader/管线编译，调用方需预留 ≥300s 时限'
    return result

if __name__=='__main__':
    if '--discover' in sys.argv[1:]:
        launcher=sys.argv[sys.argv.index('--discover')+1] if len(sys.argv)>sys.argv.index('--discover')+1 else None
        print(json.dumps(sdk_facts(launcher),ensure_ascii=False));sys.exit(0)
    if '--cache' in sys.argv[1:]:
        print(json.dumps(cache_status(),ensure_ascii=False,indent=2));sys.exit(0)
    result=check();print(json.dumps(result,ensure_ascii=False));sys.exit(0 if result['status']=='AVAILABLE' else 2)
