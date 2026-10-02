"""当前 Blender 进程加载上游 MCP addon，不写入全局安装或偏好。"""
import argparse, importlib.util, json, sys
import bpy

parser = argparse.ArgumentParser()
parser.add_argument('--addon', required=True)
parser.add_argument('--port', type=int, default=9876)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
if bpy.app.background:
    raise RuntimeError('Blender MCP 需要 GUI 主事件循环，请勿使用 --background')
spec = importlib.util.spec_from_file_location('lyapunov_blender_mcp', args.addon)
addon = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = addon
spec.loader.exec_module(addon)
# 禁止上游 register() 抢占默认端口，由此启动入口指定当前实例的端口。
bpy.context.scene['blendermcp_auto_start_server'] = False
addon.register()
server = addon.BlenderMCPServer(host='127.0.0.1', port=args.port)
bpy.types.blendermcp_server = server
server.start()
bpy.context.scene.blendermcp_port = args.port
bpy.context.scene.blendermcp_server_running = server.running
# 只开匿名、免凭据的 PolyHaven 公共资产目录（CC0-1.0）；收费生成（Hyper3D/Hunyuan3D）
# 与需要 API key / OAuth 的下载源（Poly Pizza / Sketchfab）保持关闭。
for field in ['blendermcp_use_hyper3d', 'blendermcp_use_sketchfab', 'blendermcp_use_polypizza', 'blendermcp_use_hunyuan3d']:
    setattr(bpy.context.scene, field, False)
bpy.context.scene.blendermcp_use_polyhaven = True
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.shading.type = 'SOLID'
if not server.running:
    raise RuntimeError('BLENDER_MCP_START_FAILED')
print('LYAPUNOV_BLENDER_MCP=' + json.dumps({'status':'READY','host':server.host,'port':server.port,'blenderVersion':bpy.app.version_string,'source':bpy.data.filepath,'globalPreferencesSaved':False}), flush=True)
