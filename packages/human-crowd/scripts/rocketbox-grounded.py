"""从已验证GLB原Walk派生WalkGrounded：鞋底接触区间、两骨腿IK与两帧平滑；原Walk保留。"""
import bpy,sys,argparse,json,math,statistics,hashlib,struct
from pathlib import Path
from mathutils import Vector,Matrix
sys.path.insert(0,str(Path(__file__).resolve().parent));from rocketbox_shoe_selection import lowest_shoe_component
p=argparse.ArgumentParser();p.add_argument('--asset',required=True);p.add_argument('--out',required=True);p.add_argument('--avatar',default='Male_Adult_04');p.add_argument('--per-foot-contact-floor',action='store_true');p.add_argument('--vertical-foot-clearance',action='store_true');p.add_argument('--sole-clearance-m',type=float,default=.001);p.add_argument('--shoe-selection',choices=['weighted','lowest-component'],default='weighted');args=p.parse_args(sys.argv[sys.argv.index('--')+1:]);assert .0005<=args.sole_clearance_m<=.01,'SOLE_CLEARANCE_OUT_OF_RANGE';sole_target=args.sole_clearance_m;out=Path(args.out);out.mkdir(parents=True,exist_ok=True);bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False);bpy.context.scene.render.fps=30;bpy.ops.import_scene.gltf(filepath=str(Path(args.asset).resolve()));arm=next(o for o in bpy.data.objects if o.type=='ARMATURE');source_bytes=Path(args.asset).read_bytes();source_gltf=json.loads(source_bytes[20:20+struct.unpack_from('<I',source_bytes,12)[0]]);source_mesh_nodes=[node for node in source_gltf['nodes']if'mesh'in node];assert source_mesh_nodes and all('skin'in node for node in source_mesh_nodes),'SOURCE_UNSKINNED_MESH_UNSUPPORTED';meshes=[o for o in bpy.context.scene.objects if o.type=='MESH'and any(m.type=='ARMATURE'and m.object==arm for m in o.modifiers)];assert len(meshes)==len(source_mesh_nodes),'SOURCE_SKIN_MESH_COUNT_MISMATCH';original_actions=[a for a in bpy.data.actions if a.name in ['Idle','Walk','Run','WalkStart','WalkStop','TurnLeft180']];assert len(original_actions)==6;raw=next(a for a in original_actions if a.name=='Walk');arm.animation_data_clear();arm.animation_data_create();arm.animation_data.action=raw;arm.animation_data.action_slot=raw.slots[0];bones=sorted(arm.data.bones,key=lambda b:len(b.parent_recursive));start_frame=int(round(raw.frame_range[0]));n=int(round(raw.frame_range[1]))-start_frame;assert 4<=n<=300,('WALK_FRAME_RANGE_UNSUPPORTED',n);world=[];vertices=[];ids={};shoe_selection={}
for mesh in meshes:
 for side in ['L','R']:
  groups={g.index for g in mesh.vertex_groups if g.name.startswith('Bip01 '+side+' Foot')or g.name.startswith('Bip01 '+side+' Toe')};ids[(mesh.name,side)]=[v.index for v in mesh.data.vertices if sum(w.weight for w in v.groups if w.group in groups)>.8]
 if args.shoe_selection=='lowest-component':
  mesh.data.calc_loop_triangles();positions=[tuple(v.co)for v in mesh.data.vertices];triangles=[tuple(t.vertices)for t in mesh.data.loop_triangles];neutral=[tuple(mesh.matrix_world@v.co)for v in mesh.data.vertices]
  for side in ['L','R']:ids[(mesh.name,side)],shoe_selection[mesh.name+'/'+side]=lowest_shoe_component(positions,triangles,ids[(mesh.name,side)],neutral)
for frame in range(n+1):
 bpy.context.scene.frame_set(start_frame+frame);bpy.context.view_layer.update();world.append({b.name:(arm.matrix_world@arm.pose.bones[b.name].matrix).copy()for b in bones});row={'L':[],'R':[]}
 for mesh in meshes:
  evaluated=mesh.evaluated_get(bpy.context.evaluated_depsgraph_get());geometry=evaluated.to_mesh()
  for side in row:row[side]+=[evaluated.matrix_world@geometry.vertices[i].co for i in ids[(mesh.name,side)]]
  evaluated.to_mesh_clear()
 vertices.append(row)
floor=min(v.z for row in vertices for points in row.values()for v in points);drift=world[n]['Bip01 Pelvis'].translation-world[0]['Bip01 Pelvis'].translation;drift.z=0;contacts={}
for side in ['L','R']:
 contact_floor=min(v.z for row in vertices for v in row[side])if args.per_foot_contact_floor else floor;mask=[sum(v.z<contact_floor+.015 for v in row[side])>=.15*len(row[side])for row in vertices[:n]];runs=[]
 for start in range(n):
  if not mask[start]or mask[(start-1)%n]:continue
  end=start
  while end-start<n and mask[(end+1)%n]:end+=1
  runs.append((start,end))
 assert runs,(side,mask);start,end=max(runs,key=lambda r:r[1]-r[0]);middle=(start+end)//2;cycle=middle//n;index=middle%n;low=min(v.z for v in vertices[index][side]);sole=[v for v in vertices[index][side]if v.z<low+.006];marker=sum(sole,Vector())/len(sole);foot='Bip01 '+side+' Foot';local=world[index][foot].inverted()@marker;anchor=marker+drift*cycle;anchor.z=floor;contacts[side]={'start':start,'end':end,'middle':middle,'local':local,'anchor':anchor,'vertices':len(sole),'mask':mask,'contactFloorWorldZM':contact_floor}
# 只下沉Pelvis最多数毫米，为足锁提供原骨长内的可达余量；实体路径根Bip01不变。
needed=[]
for frame in range(n):
 drop=0.
 for side,contact in contacts.items():
  sample=frame+round((contact['middle']-frame)/n)*n;start,end=contact['start'],contact['end'];weight=min(1.,max(0.,(sample-(start-2))/2),max(0.,((end+2)-sample)/2));weight=weight*weight*(3-2*weight);foot='Bip01 '+side+' Foot';thigh='Bip01 '+side+' Thigh';calf='Bip01 '+side+' Calf';marker=world[frame][foot]@contact['local']+drift*((sample-frame)//n);correction=contact['anchor']-marker;correction.z=sole_target-min(v.z for v in vertices[frame][side]);correction*=weight
  if args.vertical_foot_clearance:correction.z=max(correction.z,sole_target-min(v.z for v in vertices[frame][side]))
  hip,knee,ankle=[world[frame][name].translation for name in [thigh,calf,foot]];target=ankle+correction;length=(knee-hip).length+(ankle-knee).length-2e-5;horizontal=(Vector((target.x,target.y,0))-Vector((hip.x,hip.y,0))).length
  assert horizontal<length
  drop=max(drop,hip.z-target.z-math.sqrt(length*length-horizontal*horizontal))
 needed.append(max(0.,drop))
pelvis_drop=[max(needed[(i+j)%n]for j in range(-2,3))for i in range(n)]
for _ in range(2):pelvis_drop=[(pelvis_drop[(i-1)%n]+2*pelvis_drop[i]+pelvis_drop[(i+1)%n])/4 for i in range(n)]
assert max(pelvis_drop)<.012,('PELVIS_CLEARANCE_EXCEEDED',max(pelvis_drop))
action=bpy.data.actions.new('WalkGrounded');slot=action.slots.new('OBJECT',arm.name);arm.animation_data.action=action;arm.animation_data.action_slot=slot;report=[];maximum=0.;arm_inverse=arm.matrix_world.inverted()
for frame in range(n+1):
 raw_world=world[frame];shift=Vector((0,0,-pelvis_drop[frame%n]));pelvis=raw_world['Bip01 Pelvis'].copy();pelvis.translation+=shift;explicit={'Bip01 Pelvis':pelvis};row={'frame':frame,'pelvisDropM':pelvis_drop[frame%n],'feet':{}}
 for side,contact in contacts.items():
  sample=frame+round((contact['middle']-frame)/n)*n;start,end=contact['start'],contact['end'];ramp=2.;weight=min(1.,max(0.,(sample-(start-ramp))/ramp),max(0.,((end+ramp)-sample)/ramp));weight=weight*weight*(3-2*weight);thigh='Bip01 '+side+' Thigh';calf='Bip01 '+side+' Calf';foot='Bip01 '+side+' Foot';marker=raw_world[foot]@contact['local']+drift*((sample-frame)//n);correction=contact['anchor']-marker;correction.z=sole_target-min(v.z for v in vertices[frame][side]);correction*=weight
  if args.vertical_foot_clearance:correction.z=max(correction.z,sole_target-min(v.z for v in vertices[frame][side]))
  hip,knee,ankle=[raw_world[name].translation for name in [thigh,calf,foot]];target=ankle+correction;hip+=shift;knee+=shift;ankle+=shift;l1=(knee-hip).length;l2=(ankle-knee).length;axis=target-hip;distance=axis.length;axis.normalize();bounded=max(abs(l1-l2)+1e-7,min(l1+l2-1e-7,distance));reachable=hip+axis*bounded;residual=(reachable-target).length;maximum=max(maximum,residual);bend=(knee-hip)-axis*(knee-hip).dot(axis)
  if bend.length<1e-7:bend=Vector((0,-1,0))-axis*axis.dot(Vector((0,-1,0)))
  bend.normalize();along=(l1*l1-l2*l2+bounded*bounded)/(2*bounded);new_knee=hip+axis*along+bend*math.sqrt(max(0.,l1*l1-along*along));thigh_q=(knee-hip).rotation_difference(new_knee-hip)@raw_world[thigh].to_quaternion();calf_q=(ankle-knee).rotation_difference(reachable-new_knee)@raw_world[calf].to_quaternion();explicit[thigh]=Matrix.LocRotScale(hip,thigh_q,raw_world[thigh].to_scale());explicit[calf]=Matrix.LocRotScale(new_knee,calf_q,raw_world[calf].to_scale());explicit[foot]=Matrix.LocRotScale(reachable,raw_world[foot].to_quaternion(),raw_world[foot].to_scale());row['feet'][side]={'weight':weight,'sample':sample,'targetAnkleWorldM':list(target),'achievedAnkleWorldM':list(reachable),'residualM':residual,'correctionM':list(correction)}
 desired={}
 for b in bones:
  desired[b.name]=explicit[b.name]if b.name in explicit else desired[b.parent.name]@raw_world[b.parent.name].inverted()@raw_world[b.name]if b.parent else raw_world[b.name]
  kwargs={'matrix':arm_inverse@desired[b.name],'matrix_local':b.matrix_local,'invert':True}
  if b.parent:kwargs.update(parent_matrix=arm_inverse@desired[b.parent.name],parent_matrix_local=b.parent.matrix_local)
  basis=b.convert_local_to_pose(**kwargs);pb=arm.pose.bones[b.name];pb.rotation_mode='QUATERNION';pb.matrix_basis=basis
  for name in ['location','rotation_quaternion','scale']:pb.keyframe_insert(data_path=name,frame=frame,group=b.name)
 report.append(row)
assert maximum<1e-5,('IK_UNREACHABLE',maximum)
arm.animation_data.action=None
for a in original_actions+[action]:
 a.use_fake_user=True;track=arm.animation_data.nla_tracks.new();track.name=a.name;strip=track.strips.new(a.name,0,a);strip.action_slot=a.slots[0];strip.action_frame_start=a.frame_range[0];strip.action_frame_end=a.frame_range[1];strip.frame_start=0;strip.frame_end=a.frame_range[1]-a.frame_range[0];strip.blend_type='REPLACE'
bpy.ops.object.select_all(action='DESELECT');arm.select_set(True)
for mesh in meshes:mesh.select_set(True)
bpy.context.view_layer.objects.active=arm;bpy.context.scene.frame_set(0);bpy.ops.export_scene.gltf(filepath=str(out/(args.avatar+'-Grounded.glb')),export_format='GLB',use_selection=True,export_yup=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_frame_range=False,export_optimize_animation_size=False,export_skins=True,export_normals=True,export_tangents=True,export_morph=False,export_image_format='AUTO');data=(out/(args.avatar+'-Grounded.glb')).read_bytes();result={'status':'DERIVED_NOT_VISUALLY_VERIFIED','sourceSha256':hashlib.sha256(Path(args.asset).read_bytes()).hexdigest(),'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'floorWorldZM':floor,'verticalFootClearance':args.vertical_foot_clearance,'shoeSelection':{'mode':args.shoe_selection,'meshes':shoe_selection,'sourceMeshNodes':len(source_mesh_nodes),'processedSkinMeshes':[mesh.name for mesh in meshes]},'contactFloorMethod':'each-foot-cycle-min'if args.per_foot_contact_floor else'both-feet-cycle-min','sourceDriftM':list(drift),'contacts':{s:{k:list(v)if isinstance(v,Vector)else v for k,v in c.items()}for s,c in contacts.items()},'frames':report,'maxIkResidualM':maximum,'rampFrames':2,'soleTargetWorldZM':sole_target,'maxPelvisDropM':max(pelvis_drop),'pelvisSmoothing':'5帧可达性上包络，循环[1,2,1]/4平滑两次，根路径不变','grounding':'水平同点足锁；垂直按原鞋底逐帧投影到显式soleTargetWorldZM余量，保持根/骨长','keptOriginalClips':[a.name for a in original_actions]};(out/'grounded-conversion.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in result.items()if k not in ['frames','contacts']},ensure_ascii=False))
