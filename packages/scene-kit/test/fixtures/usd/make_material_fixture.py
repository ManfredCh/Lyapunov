"""自有合法小USD/PNG；有常量PBR、indexed faceVarying UV接缝及明确输出通道。"""
from pxr import Usd,UsdGeom,UsdShade,Sdf,Gf
import os,sys,struct,zlib
root=sys.argv[1];os.makedirs(root,exist_ok=True)
# 标准8×8 RGBA PNG，不依赖Pillow或外部图片。
raw=bytearray()
colors=[(230,35,30,255),(30,190,60,255),(30,70,230,255),(245,220,30,255)]
for y in range(8):
 raw.append(0)
 for x in range(8):raw.extend(colors[(x//2+y//2)%4])
def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
image=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',8,8,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(bytes(raw)))+chunk(b'IEND',b'')
open(root+'/checker.png','wb').write(image)
stage=Usd.Stage.CreateNew(root+'/material.usda');UsdGeom.SetStageMetersPerUnit(stage,1);UsdGeom.SetStageUpAxis(stage,'Z')
world=UsdGeom.Xform.Define(stage,'/MaterialDemo');stage.SetDefaultPrim(world.GetPrim())
def mesh(name,x):
 m=UsdGeom.Mesh.Define(stage,'/MaterialDemo/'+name);m.CreatePointsAttr([(-1+x,-.5,0),(x,-.5,0),(x,.5,0),(-1+x,.5,0),(1+x,-.5,0),(1+x,.5,0)]);m.CreateFaceVertexCountsAttr([4,4]);m.CreateFaceVertexIndicesAttr([0,1,2,3,1,4,5,2]);m.CreateSubdivisionSchemeAttr('none')
 uv=UsdGeom.PrimvarsAPI(m).CreatePrimvar('st',Sdf.ValueTypeNames.TexCoord2fArray,UsdGeom.Tokens.faceVarying);uv.Set([(0,0),(1,0),(1,1),(0,1)]);uv.SetIndices([0,1,2,3,0,1,2,3])
 return m

def material(name,color,roughness,metallic):
 path='/MaterialDemo/Looks/'+name;mat=UsdShade.Material.Define(stage,path);surface=UsdShade.Shader.Define(stage,path+'/Surface');surface.CreateIdAttr('UsdPreviewSurface');surface.CreateInput('diffuseColor',Sdf.ValueTypeNames.Color3f).Set(color);surface.CreateInput('roughness',Sdf.ValueTypeNames.Float).Set(roughness);surface.CreateInput('metallic',Sdf.ValueTypeNames.Float).Set(metallic);mat.CreateSurfaceOutput().ConnectToSource(surface.ConnectableAPI(),'surface')
 return mat,surface
textured=mesh('Textured',0);solid=mesh('Solid',2.5);scalar=mesh('Scalar',-2.5)
mat,surface=material('Checker',(1,1,1),.37,.2);UsdShade.MaterialBindingAPI.Apply(textured.GetPrim()).Bind(mat)
reader=UsdShade.Shader.Define(stage,'/MaterialDemo/Looks/UVReader');reader.CreateIdAttr('UsdPrimvarReader_float2');reader.CreateInput('varname',Sdf.ValueTypeNames.Token).Set('st')
texture=UsdShade.Shader.Define(stage,'/MaterialDemo/Looks/CheckerTexture');texture.CreateIdAttr('UsdUVTexture');texture.CreateInput('file',Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath('./checker.png'));texture.CreateInput('st',Sdf.ValueTypeNames.Float2).ConnectToSource(reader.ConnectableAPI(),'result');texture.CreateInput('sourceColorSpace',Sdf.ValueTypeNames.Token).Set('auto');texture.CreateInput('wrapS',Sdf.ValueTypeNames.Token).Set('repeat');texture.CreateInput('wrapT',Sdf.ValueTypeNames.Token).Set('clamp');surface.GetInput('diffuseColor').ConnectToSource(texture.ConnectableAPI(),'rgb')
mat,solid_surface=material('SolidRed',(.8,.03,.02),.8,.6);UsdShade.MaterialBindingAPI.Apply(solid.GetPrim()).Bind(mat)
mat,data_surface=material('ScalarChannels',(.25,.25,.25),.5,.5);UsdShade.MaterialBindingAPI.Apply(scalar.GetPrim()).Bind(mat)
data=UsdShade.Shader.Define(stage,'/MaterialDemo/Looks/DataTexture');data.CreateIdAttr('UsdUVTexture');data.CreateInput('file',Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath('./checker.png'));data.CreateInput('st',Sdf.ValueTypeNames.Float2).ConnectToSource(reader.ConnectableAPI(),'result');data.CreateInput('sourceColorSpace',Sdf.ValueTypeNames.Token).Set('raw');data_surface.GetInput('roughness').ConnectToSource(data.ConnectableAPI(),'r');data_surface.GetInput('metallic').ConnectToSource(data.ConnectableAPI(),'b')
solid_surface.GetInput('diffuseColor').GetAttr().Clear()
variants=world.GetPrim().GetVariantSets().AddVariantSet('finish')
# 使用另一常量输入演示实例变体，不覆盖源全局默认。
for name,color in [('warm',(.8,.03,.02)),('cool',(.02,.1,.8))]:
 variants.AddVariant(name);variants.SetVariantSelection(name)
 with variants.GetVariantEditContext():solid_surface.CreateInput('diffuseColor',Sdf.ValueTypeNames.Color3f).Set(color)
variants.SetVariantSelection('warm')
stage.GetRootLayer().Save()
from pxr import UsdUtils
UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(root+'/material.usda'),root+'/material.usdz')
