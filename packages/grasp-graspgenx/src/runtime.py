"""可独立管理 GraspGenX 已安装容器；模型卷和宿主驱动不归此代码修改。"""
import json,os,subprocess

def inspect_container(name):
    response=subprocess.run(['docker','inspect',name,'--format','{{json .State}}|{{json .NetworkSettings.Networks}}'],capture_output=True,text=True)
    if response.returncode: raise RuntimeError('PROVIDER_UNAVAILABLE: GraspGenX 容器未安装: '+name)
    state,networks=response.stdout.strip().split('|',1)
    return json.loads(state),json.loads(networks)

def resolve_endpoint():
    if os.environ.get('GRASPGENX_ENDPOINT'):return os.environ['GRASPGENX_ENDPOINT']
    # 旧变量仅用于显式兼容读取；新部署应使用 LYAPUNOV_GRASPGENX_CONTAINER。
    name=os.environ.get('LYAPUNOV_GRASPGENX_CONTAINER') or os.environ.get('LYAUP_GRASPGENX_CONTAINER')
    if not name:raise RuntimeError('PROVIDER_UNAVAILABLE: 配置 GRASPGENX_ENDPOINT 或 LYAPUNOV_GRASPGENX_CONTAINER')
    state,networks=inspect_container(name)
    if not state.get('Running'):raise RuntimeError('PROVIDER_UNAVAILABLE: GraspGenX 容器未运行: '+name)
    addresses=[network['IPAddress'] for network in networks.values() if network.get('IPAddress')]
    if len(addresses)!=1:raise RuntimeError('PROVIDER_UNAVAILABLE: 显式设置 GRASPGENX_ENDPOINT 选择容器网络')
    return 'tcp://'+addresses[0]+':5556'

def start_installed(name):
    state,_=inspect_container(name)
    if state.get('Running'):return {'container':name,'started':False,'ownership':'external'}
    subprocess.run(['docker','start',name],check=True,capture_output=True)
    return {'container':name,'started':True,'ownership':'caller'}

def stop_owned(handle):
    if handle.get('ownership')=='caller' and handle.get('started'):subprocess.run(['docker','stop',handle['container']],check=True,capture_output=True)
