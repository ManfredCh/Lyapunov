"""合法自有USD：非交换UV变换链、packed通道、解码法线与作者法线定量夹具。"""
import os,struct,sys,zlib
from pxr import Usd,UsdGeom,UsdShade,Sdf,Gf

root=sys.argv[1];os.makedirs(root,exist_ok=True)
def png(name,rgba):
    def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    with open(os.path.join(root,name),'wb')as file:file.write(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b'\0'+bytes(rgba)))+chunk(b'IEND',b''))
png('albedo.png',[128,64,32,255]);png('orm.png',[17,89,203,255]);png('normal.png',[128,191,238,255])
stage=Usd.Stage.CreateNew(os.path.join(root,'uv-normal.usda'));parent=UsdGeom.Xform.Define(stage,'/UVNormal');stage.SetDefaultPrim(parent.GetPrim());UsdGeom.SetStageMetersPerUnit(stage,1);UsdGeom.SetStageUpAxis(stage,'Z')
mesh=UsdGeom.Mesh.Define(stage,'/UVNormal/Mesh');mesh.CreatePointsAttr([(-1,0,0),(0,0,0),(0,1,0),(-1,1,0),(1,0,0),(1,1,0)]);mesh.CreateFaceVertexCountsAttr([4,4]);mesh.CreateFaceVertexIndicesAttr([0,1,2,3,1,4,5,2]);mesh.CreateSubdivisionSchemeAttr('none');mesh.CreateOrientationAttr('leftHanded')
mesh.CreateNormalsAttr([(0,1,-1),(1,0,-1)]);mesh.SetNormalsInterpolation('uniform')
st=UsdGeom.PrimvarsAPI(mesh).CreatePrimvar('st',Sdf.ValueTypeNames.TexCoord2fArray,'faceVarying');st.Set([(0,0),(2,0),(2,.5),(0,.5),(3,1),(1,1),(1,-1),(3,-1)]);st.SetIndices([0,1,2,3,4,5,6,7])
material=UsdShade.Material.Define(stage,'/UVNormal/Material');shader=UsdShade.Shader.Define(stage,'/UVNormal/Material/Surface');shader.CreateIdAttr('UsdPreviewSurface');material.CreateSurfaceOutput().ConnectToSource(shader.ConnectableAPI(),'surface')
reader=UsdShade.Shader.Define(stage,'/UVNormal/Material/Reader');reader.CreateIdAttr('UsdPrimvarReader_float2');reader.CreateInput('varname',Sdf.ValueTypeNames.String).Set('st');reader.CreateOutput('result',Sdf.ValueTypeNames.Float2)
def transform(name,source,scale,rotation,translation):
    node=UsdShade.Shader.Define(stage,'/UVNormal/Material/'+name);node.CreateIdAttr('UsdTransform2d');node.CreateInput('in',Sdf.ValueTypeNames.Float2).ConnectToSource(source.ConnectableAPI(),'result');node.CreateInput('scale',Sdf.ValueTypeNames.Float2).Set(Gf.Vec2f(*scale));node.CreateInput('rotation',Sdf.ValueTypeNames.Float).Set(rotation);node.CreateInput('translation',Sdf.ValueTypeNames.Float2).Set(Gf.Vec2f(*translation));node.CreateOutput('result',Sdf.ValueTypeNames.Float2);return node
inner=transform('Inner',reader,(2,3),90,(.25,-.5));outer=transform('Outer',inner,(.5,-1),-30,(-.1,.2))
if '--connected-rotation'in sys.argv:
    parameter=material.CreateInput('connectedRotation',Sdf.ValueTypeNames.Float);parameter.Set(45)
    outer.GetInput('rotation').ConnectToSource(parameter)
for name,file,space,output,target,kind in [('Albedo','albedo.png','sRGB','rgb','diffuseColor',Sdf.ValueTypeNames.Color3f),('ORM','orm.png','raw','g','roughness',Sdf.ValueTypeNames.Float),('Metal','orm.png','raw','b','metallic',Sdf.ValueTypeNames.Float),('Normal','normal.png','raw','rgb','normal',Sdf.ValueTypeNames.Normal3f)]:
    texture=UsdShade.Shader.Define(stage,'/UVNormal/Material/'+name);texture.CreateIdAttr('UsdUVTexture');texture.CreateInput('file',Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath(file));texture.CreateInput('sourceColorSpace',Sdf.ValueTypeNames.Token).Set(space);texture.CreateInput('wrapS',Sdf.ValueTypeNames.Token).Set('repeat');texture.CreateInput('wrapT',Sdf.ValueTypeNames.Token).Set('repeat');texture.CreateInput('st',Sdf.ValueTypeNames.Float2).ConnectToSource(outer.ConnectableAPI(),'result')
    if name=='Normal':texture.CreateInput('scale',Sdf.ValueTypeNames.Float4).Set(Gf.Vec4f(2));texture.CreateInput('bias',Sdf.ValueTypeNames.Float4).Set(Gf.Vec4f(-1))
    shader.CreateInput(target,kind).ConnectToSource(texture.ConnectableAPI(),output)
UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(material);stage.GetRootLayer().Save()
