"""固定微软Rocketbox普通成人，离线组合官方兼容动作。只用现有Blender，不安装/下载。
源文件由prepare-rocketbox.ts按固定版本/SHA验证；本工具不替换网格/权重或添加物理时钟。
"""
import bpy,json,hashlib,math,re,argparse,sys
from mathutils import Matrix,Vector
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--out',required=True);parser.add_argument('--avatar',default='Male_Adult_04');parser.add_argument('--motion-prefix',choices=['m','f'],default='m');parser.add_argument('--specular-maps',action='store_true');parser.add_argument('--retarget-rest-lengths',action='store_true');parser.add_argument('--reference-avatar');args=parser.parse_args(sys.argv[sys.argv.index('--')+1:]);source=Path(args.source).resolve();out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True);assert re.fullmatch(r'(?:Male|Female)_Adult_\d{2}',args.avatar),'AVATAR_ID_INVALID';asset=source/'Assets/Avatars/Adults'/args.avatar;bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False);bpy.ops.import_scene.fbx(filepath=str(asset/'Export'/(args.avatar+'.fbx')),automatic_bone_orientation=False,use_anim=True)
arm=next(o for o in bpy.context.scene.objects if o.type=='ARMATURE');meshes=[o for o in bpy.context.scene.objects if o.type=='MESH'];assert len(meshes)==1,'必须单LOD';arm.animation_data_clear()
for bone in arm.pose.bones:bone.matrix_basis.identity()
material_report={}
for material in meshes[0].data.materials:
 material.use_nodes=True;nodes=material.node_tree.nodes;nodes.clear();output=nodes.new('ShaderNodeOutputMaterial');bsdf=nodes.new('ShaderNodeBsdfPrincipled');material.node_tree.links.new(bsdf.outputs['BSDF'],output.inputs['Surface']);bsdf.inputs['Base Color'].default_value=(1,1,1,1);bsdf.inputs['Metallic'].default_value=0;bsdf.inputs['Roughness'].default_value=.68 if 'head'in material.name else .78;bsdf.inputs['Specular IOR Level'].default_value=0 if 'opacity'in material.name else(.5 if args.specular_maps else .35)
 color=asset/'Textures'/(material.name+'_color.tga');assert color.exists(),color;image=bpy.data.images.load(str(color),check_existing=True);tex=nodes.new('ShaderNodeTexImage');tex.image=image;material.node_tree.links.new(tex.outputs['Color'],bsdf.inputs['Base Color']);material.diffuse_color=(1,1,1,1);material.use_backface_culling=False
 if 'opacity'in material.name:
  material.node_tree.links.new(tex.outputs['Alpha'],bsdf.inputs['Alpha']);material.surface_render_method='DITHERED'
  if hasattr(material,'use_transparency_overlap'):material.use_transparency_overlap=False
 normal=asset/'Textures'/(material.name+'_normal.tga')
 if normal.exists():
  ntex=nodes.new('ShaderNodeTexImage');ntex.image=bpy.data.images.load(str(normal),check_existing=True);ntex.image.colorspace_settings.name='Non-Color';nmap=nodes.new('ShaderNodeNormalMap');nmap.inputs['Strength'].default_value=1. if args.specular_maps else .5;material.node_tree.links.new(ntex.outputs['Color'],nmap.inputs['Color']);material.node_tree.links.new(nmap.outputs['Normal'],bsdf.inputs['Normal'])
 specular=asset/'Textures'/(material.name+'_specular.tga')
 if args.specular_maps and specular.exists():
  stex=nodes.new('ShaderNodeTexImage');stex.image=bpy.data.images.load(str(specular),check_existing=True);material.node_tree.links.new(stex.outputs['Color'],bsdf.inputs['Specular Tint'])
 material_report[material.name]={'baseColorFactor':[1,1,1,1],'color':str(color),'normal':str(normal)if normal.exists()else None,'hairSpecular':0 if 'opacity'in material.name else None,'specularColor':str(specular)if args.specular_maps and specular.exists()else None,'pbrConversion':'Diffuse/alpha/normal retained; original specular color mapped to Principled tint/KHR_materials_specular; fixed roughness, not Max shader execution'if args.specular_maps else'legacy PBR conversion'}
face_names={b.name for b in arm.data.bones if b.name not in {'Bip01 Head'}and any(p.name=='Bip01 Head'for p in b.parent_recursive)}
def filter_curves(action):
 removed=[]
 for layer in action.layers:
  for strip in layer.strips:
   for bag in strip.channelbags:
    for curve in list(bag.fcurves):
     m=re.match(r'pose\.bones\["([^"]+)"\]',curve.data_path)
     if m and(m[1]not in arm.data.bones or m[1]in face_names):removed.append(curve.data_path);bag.fcurves.remove(curve)
 return removed
reference_world=None;reference_bones=None;reference_info=None
if args.retarget_rest_lengths:
 assert args.reference_avatar,'--retarget-rest-lengths需要显式参考avatar FBX；不能把动作FBX首帧当中性bind'
 reference_path=Path(args.reference_avatar).resolve()
 if reference_path==(asset/'Export'/(args.avatar+'.fbx')).resolve():reference_world=arm.matrix_world.copy();reference_bones={b.name:b.matrix_local.copy()for b in arm.data.bones}
 else:
  before=set(bpy.data.objects);bpy.ops.import_scene.fbx(filepath=str(reference_path),automatic_bone_orientation=False,use_anim=False);objects=[o for o in bpy.data.objects if o not in before];reference=next(o for o in objects if o.type=='ARMATURE');reference_world=reference.matrix_world.copy();reference_bones={b.name:b.matrix_local.copy()for b in reference.data.bones}
  for o in objects:bpy.data.objects.remove(o,do_unlink=True)
 reference_info={'path':str(reference_path),'sha256':hashlib.sha256(reference_path.read_bytes()).hexdigest(),'purpose':'同动画族的显式中性avatar bind参考；动作FBX.data骨矩阵可能是首帧pose，不能充当中性bind'}
clips=[('Idle','all_animations_max_motextr_static/m_idle_breathe_01.max.fbx'),('Walk','all_animations_max_motextr_xy/m_walk_neutral.max.fbx'),('Run','all_animations_max_motextr_xy/m_run_neutral.max.fbx'),('WalkStart','all_animations_max_motextr_xy/m_walk_start.max.fbx'),('WalkStop','all_animations_max_motextr_xy/m_walk_stop.max.fbx'),('TurnLeft180','all_animations_max_motextr_xyz/m_turn_left_180_to_walk.max.fbx')];actions=[];report=[]
for name,path in clips:
 before=set(bpy.data.objects);bpy.ops.import_scene.fbx(filepath=str(source/'Assets/Animations'/path.replace('/m_','/'+args.motion_prefix+'_')),automatic_bone_orientation=False,use_anim=True,ignore_leaf_bones=True);new=[o for o in bpy.data.objects if o not in before];rigs=[o for o in new if o.type=='ARMATURE'];assert len(rigs)==1,(name,[o.name for o in rigs]);rig=rigs[0];assert rig.animation_data and rig.animation_data.action,name;source_action=rig.animation_data.action;source_action.use_fake_user=True;missing=[b.name for b in rig.data.bones if b.name not in arm.data.bones];assert all(n.endswith('Nub')for n in missing),(name,missing)
 # 动作FBX以第一帧作局部参考，不能把局部basis直接套到A-pose头像；按共同body骨的实际世界矩阵烘焙。
 action=bpy.data.actions.new(name);slot=action.slots.new('OBJECT',arm.name);arm.animation_data_create();arm.animation_data.action=action;arm.animation_data.action_slot=slot;action.use_fake_user=True;inverse=arm.matrix_world.inverted();bones=sorted(arm.data.bones,key=lambda b:len(b.parent_recursive));start_frame,end_frame=source_action.frame_range;length_errors=[]
 for b in bones:
  if b.name in face_names or not b.parent:continue
  if b.parent.name in rig.data.bones:
   target_length=(arm.matrix_world.to_3x3()@(b.head_local-b.parent.head_local)).length;donor_length=(rig.matrix_world.to_3x3()@(rig.data.bones[b.name].head_local-rig.data.bones[b.parent.name].head_local)).length;length_errors.append(abs(target_length-donor_length))
 rest_relative={b.name:b.parent.matrix_local.inverted()@b.matrix_local for b in bones if b.parent};donor_rest={b.name:inverse@reference_world@reference_bones[b.name]for b in bones}if args.retarget_rest_lengths else {b.name:inverse@rig.matrix_world@rig.data.bones[b.name].matrix_local for b in bones if b.name in rig.data.bones}
 def leg_length(heads):return sum((heads['Bip01 '+side+' '+a].translation-heads['Bip01 '+side+' '+b].translation).length for side in ['L','R']for a,b in [('Thigh','Calf'),('Calf','Foot')])/2
 target_rest={b.name:b.matrix_local for b in bones};rotation_errors=[donor_rest[b.name].to_quaternion().rotation_difference(b.matrix_local.to_quaternion()).angle for b in bones if b.name not in face_names]if args.retarget_rest_lengths else[];motion_scale=leg_length(target_rest)/leg_length(donor_rest)if args.retarget_rest_lengths else 1.;maximum_length_error=0.
 for frame in range(round(start_frame),round(end_frame)+1):
  bpy.context.scene.frame_set(frame);bpy.context.view_layer.update();desired={}
  for b in bones:
   if b.name in face_names:
    parent=desired[b.parent.name];matrix=parent@b.parent.matrix_local.inverted()@b.matrix_local
   else:
    matrix=inverse@rig.matrix_world@rig.pose.bones[b.name].matrix
    if args.retarget_rest_lengths:
     if max(abs(value-1.)for value in matrix.to_scale())>1e-5:raise AssertionError(('SOURCE_ANIMATED_SCALE_UNSUPPORTED',name,b.name,list(matrix.to_scale())))
     if not b.parent or b.name=='Bip01 Pelvis':position=b.matrix_local.translation+(matrix.translation-donor_rest[b.name].translation)*motion_scale
     else:position=desired[b.parent.name]@rest_relative[b.name].translation
     orientation=matrix.to_quaternion()@donor_rest[b.name].to_quaternion().inverted()@b.matrix_local.to_quaternion();matrix=Matrix.LocRotScale(position,orientation,Vector((1,1,1)))
   if args.retarget_rest_lengths and b.parent and b.name!='Bip01 Pelvis':
    error=abs((matrix.translation-desired[b.parent.name].translation).length-(b.head_local-b.parent.head_local).length)*arm.matrix_world.to_scale()[0];maximum_length_error=max(maximum_length_error,error)
   desired[b.name]=matrix;kwargs={'matrix':matrix,'matrix_local':b.matrix_local,'invert':True}
   if b.parent:kwargs.update(parent_matrix=desired[b.parent.name],parent_matrix_local=b.parent.matrix_local)
   basis=b.convert_local_to_pose(**kwargs);pb=arm.pose.bones[b.name];pb.rotation_mode='QUATERNION';pb.matrix_basis=basis
   for data_path in ['location','rotation_quaternion','scale']:pb.keyframe_insert(data_path=data_path,frame=frame,group=b.name)
 arm.animation_data.action=None;actions.append((name,action,slot));report.append({'clip':name,'source':path.replace('/m_','/'+args.motion_prefix+'_'),'frames':[start_frame,end_frame],'sourceBoneCount':len(rig.data.bones),'targetBoneCount':len(arm.data.bones),'retarget':'共同body骨世界矩阵烘焙到目标骨架；保留目标面部中性局部变换','maxBodyRestHeadDistanceDifferenceM':max(length_errors),'targetRestLengthsPreserved':args.retarget_rest_lengths,'maxCanonicalRestRotationDifferenceRad':max(rotation_errors)if rotation_errors else None,'rotationRetarget':'donor motion * inverse(canonical donor bind) * target bind'if args.retarget_rest_lengths else'legacy common world rotation','rootMotionScaleFromTargetLegs':motion_scale,'maxAnimatedSegmentLengthResidualM':maximum_length_error,'excludedSourceEndpointMarkers':missing})
 for o in new:bpy.data.objects.remove(o,do_unlink=True)
arm.animation_data_create()
for name,action,slot in actions:
 track=arm.animation_data.nla_tracks.new();track.name=name;strip=track.strips.new(name,0,action)
 if slot:strip.action_slot=slot
 strip.action_frame_start=action.frame_range[0];strip.action_frame_end=action.frame_range[1];strip.frame_start=0;strip.frame_end=action.frame_range[1]-action.frame_range[0];strip.blend_type='REPLACE'
# 只导出当前唯一角色及其骨架；未改mesh/权重/骨长，仅修正Max材质并组合官方兼容动作。
bpy.ops.object.select_all(action='DESELECT');arm.select_set(True)
for mesh in meshes:mesh.select_set(True)
bpy.context.view_layer.objects.active=arm;bpy.context.scene.render.fps=30;bpy.context.scene.frame_set(0)
props={p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties};requested={'filepath':str(out/(args.avatar+'.glb')),'export_format':'GLB','use_selection':True,'export_yup':True,'export_animations':True,'export_animation_mode':'NLA_TRACKS','export_force_sampling':True,'export_frame_range':False,'export_sampling_rate':1,'export_optimize_animation_size':False,'export_skins':True,'export_normals':True,'export_tangents':True,'export_morph':False,'export_image_format':'AUTO'};used={k:v for k,v in requested.items()if k in props};missing=[k for k in requested if k not in props];print('export options',used,'unavailable',missing);bpy.ops.export_scene.gltf(**used);data=(out/(args.avatar+'.glb')).read_bytes();result={'status':'EXPORTED_NOT_VISUALLY_VERIFIED','sourceRevision':'0943055db6ec570bcef9f2c8b41c9e5467c808f9','license':'MIT (explicit library grant)','avatar':args.avatar,'motionBank':args.motion_prefix,'canonicalReference':reference_info,'mesh':meshes[0].name,'vertices':len(meshes[0].data.vertices),'bones':len(arm.data.bones),'materials':material_report,'animations':report,'exportOptions':used,'unsupportedOptions':missing,'glbBytes':len(data),'glbSha256':hashlib.sha256(data).hexdigest()};(out/'conversion.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result))
