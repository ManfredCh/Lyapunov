from pxr import Usd,UsdGeom,UsdPhysics,Gf,Sdf
import sys,os
root=sys.argv[1];os.makedirs(root,exist_ok=True)
stage=Usd.Stage.CreateNew(root+'/prop.usda');UsdGeom.SetStageUpAxis(stage,'Z');UsdGeom.SetStageMetersPerUnit(stage,1)
body=UsdGeom.Xform.Define(stage,'/Prop');stage.SetDefaultPrim(body.GetPrim());body.AddTranslateOp().Set(Gf.Vec3d(0,0,.5))
cube=UsdGeom.Cube.Define(stage,'/Prop/Cube');cube.CreateSizeAttr();cube.CreateDisplayColorAttr([(0.2,0.7,0.4)]);UsdPhysics.CollisionAPI.Apply(cube.GetPrim())
vs=body.GetPrim().GetVariantSets().AddVariantSet('shape')
for name,size in [('small',1.),('large',2.)]:
 vs.AddVariant(name);vs.SetVariantSelection(name)
 with vs.GetVariantEditContext(): cube.GetSizeAttr().Set(size)
vs.SetVariantSelection('small')
extra=Usd.Stage.CreateNew(root+'/extra.usda');extra_root=UsdGeom.Xform.Define(extra,'/Extra');extra.SetDefaultPrim(extra_root.GetPrim());UsdGeom.Sphere.Define(extra,'/Extra/Sphere');extra.GetRootLayer().Save()
attachment=UsdGeom.Xform.Define(stage,'/Prop/Attachment');variants=attachment.GetPrim().GetVariantSets().AddVariantSet('attachment')
for value in ['none','extra']:
 variants.AddVariant(value);variants.SetVariantSelection(value)
 if value=='extra':
  with variants.GetVariantEditContext():attachment.GetPrim().GetPayloads().AddPayload('./extra.usda')
variants.SetVariantSelection('none')
from pxr import UsdShade
shader=UsdShade.Shader.Define(stage,'/Prop/Looks/Texture');shader.CreateIdAttr('UsdUVTexture');shader.CreateInput('file',Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath('./texture.png'))
import base64
open(root+'/texture.png','wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='))
stage.GetRootLayer().Save()
stage=Usd.Stage.CreateNew(root+'/joint.usda');UsdGeom.SetStageUpAxis(stage,'Z');UsdGeom.SetStageMetersPerUnit(stage,1)
root_prim=UsdGeom.Xform.Define(stage,'/Robot');stage.SetDefaultPrim(root_prim.GetPrim());UsdPhysics.ArticulationRootAPI.Apply(root_prim.GetPrim())
for name,x in [('Base',0),('Link',1)]:
 body=UsdGeom.Xform.Define(stage,'/Robot/'+name);body.AddTranslateOp().Set(Gf.Vec3d(x,0,1));UsdPhysics.RigidBodyAPI.Apply(body.GetPrim());cube=UsdGeom.Cube.Define(stage,'/Robot/'+name+'/Cube');cube.CreateSizeAttr(.3);UsdPhysics.CollisionAPI.Apply(cube.GetPrim())
joint=UsdPhysics.RevoluteJoint.Define(stage,'/Robot/Hinge');joint.CreateBody0Rel().SetTargets(['/Robot/Base']);joint.CreateBody1Rel().SetTargets(['/Robot/Link']);joint.CreateLocalPos0Attr(Gf.Vec3f(.5,0,0));joint.CreateLocalPos1Attr(Gf.Vec3f(-.5,0,0));joint.CreateAxisAttr('Z');joint.CreateLowerLimitAttr(-90);joint.CreateUpperLimitAttr(90);drive=UsdPhysics.DriveAPI.Apply(joint.GetPrim(),'angular');drive.CreateMaxForceAttr(20);drive.CreateStiffnessAttr(100);drive.CreateDampingAttr(10)
fixed=UsdPhysics.FixedJoint.Define(stage,'/Robot/RootFix');fixed.CreateBody1Rel().SetTargets(['/Robot/Base']);fixed.CreateLocalPos0Attr(Gf.Vec3f(0,0,1))
stage.GetRootLayer().Save()
stage.GetRootLayer().Export(root+'/joint.usdc')
from pxr import UsdUtils
UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(root+'/prop.usda'),root+'/prop.usdz')
