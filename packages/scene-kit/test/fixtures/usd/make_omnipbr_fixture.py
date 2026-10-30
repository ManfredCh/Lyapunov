"""自有USD/PNG，声明真实标准OmniPBR的受支持输入；不伪造PreviewSurface。"""
import os,runpy,sys
from pxr import Usd,UsdShade,Sdf
runpy.run_path(os.path.join(os.path.dirname(__file__),'make_uv_normal_fixture.py'))
stage=Usd.Stage.Open(os.path.join(sys.argv[1],'uv-normal.usda'));material=UsdShade.Material(stage.GetPrimAtPath('/UVNormal/Material'))
material.GetPrim().RemoveProperty('outputs:surface')
shader=UsdShade.Shader.Define(stage,'/UVNormal/Material/MDL');shader.SetSourceAsset(Sdf.AssetPath('OmniPBR.mdl'),'mdl');shader.SetSourceAssetSubIdentifier('OmniPBR','mdl');shader.CreateOutput('out',Sdf.ValueTypeNames.Token);material.CreateSurfaceOutput('mdl').ConnectToSource(shader.ConnectableAPI(),'out')
for name,file in [('diffuse_texture','albedo.png'),('ORM_texture','orm.png'),('normalmap_texture','normal.png')]:shader.CreateInput(name,Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath(file))
shader.CreateInput('enable_ORM_texture',Sdf.ValueTypeNames.Bool).Set(True)
shader.CreateInput('reflection_roughness_texture_influence',Sdf.ValueTypeNames.Float).Set(.25)
shader.CreateInput('reflection_roughness_constant',Sdf.ValueTypeNames.Float).Set(.8)
shader.CreateInput('metallic_texture_influence',Sdf.ValueTypeNames.Float).Set(.75)
shader.CreateInput('metallic_constant',Sdf.ValueTypeNames.Float).Set(.4)
shader.CreateInput('bump_factor',Sdf.ValueTypeNames.Float).Set(.5)
if '--connected'in sys.argv:
    value=material.CreateInput('roughness',Sdf.ValueTypeNames.Float);value.Set(.9);shader.GetInput('reflection_roughness_constant').ConnectToSource(value)
if '--nonidentity-uv'in sys.argv:shader.CreateInput('texture_scale',Sdf.ValueTypeNames.Float2).Set((2,1))
stage.GetRootLayer().Save()
