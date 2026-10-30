"""Blender离线审核原始蒙皮鞋底接地；不等价于原生碰撞代理或动态平衡。"""
import bpy,json,math,statistics,argparse,sys
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--assets',required=True);args=parser.parse_args(sys.argv[sys.argv.index('--')+1:]);root=Path(args.assets).resolve();bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False);bpy.context.scene.render.fps=30;bpy.ops.import_scene.gltf(filepath=str(root/'Male_Adult_04.glb'));rig=next(o for o in bpy.data.objects if o.type=='ARMATURE');meshes=[o for o in bpy.data.objects if o.type=='MESH'];print('actions',[(a.name,list(a.frame_range))for a in bpy.data.actions]);print('objects',[(o.name,len(o.data.vertices),[g.name for g in o.vertex_groups])for o in meshes]);action=next(a for a in bpy.data.actions if a.name=='Walk');rig.animation_data_clear();rig.animation_data_create();rig.animation_data.action=action
if action.slots:rig.animation_data.action_slot=action.slots[0]
mesh=next(o for o in meshes if len(o.data.vertices)>1000);groups={s:{g.index for g in mesh.vertex_groups if g.name.startswith('Bip01 '+s+' Foot')or g.name.startswith('Bip01 '+s+' Toe')}for s in ['L','R']};ids={s:[v.index for v in mesh.data.vertices if sum(w.weight for w in v.groups if w.group in group)>.8]for s,group in groups.items()};frames=[]
for frame in range(33):
 bpy.context.scene.frame_set(frame);bpy.context.view_layer.update();evaluated=mesh.evaluated_get(bpy.context.evaluated_depsgraph_get());vertices=evaluated.to_mesh();points={s:{i:list(evaluated.matrix_world@vertices.vertices[i].co)for i in selected}for s,selected in ids.items()};evaluated.to_mesh_clear();frames.append({'frame':frame,'timeS':frame/30,'feet':points})
floor=min(v[2]for f in frames for points in f['feet'].values()for v in points.values());reports={}
for side in ids:
 velocities=[];stance=[]
 for before,after in zip(frames,frames[1:]):
  a,b=before['feet'][side],after['feet'][side];active=[i for i in ids[side]if max(a[i][2],b[i][2])<=floor+.015]
  vs=[math.hypot(b[i][0]-a[i][0],b[i][1]-a[i][1])*30 for i in active]
  if len(vs)>=.15*len(ids[side]):velocities.extend(vs);stance.append({'timeS':after['timeS'],'vertices':len(vs),'medianHorizontalSpeedMps':statistics.median(vs),'maxHorizontalSpeedMps':max(vs)})
 values=sorted(velocities);reports[side]={'shoeVertices':len(ids[side]),'stanceIntervals':stance,'contactVertexSamples':len(values),'medianHorizontalSpeedMps':statistics.median(values)if values else None,'p95HorizontalSpeedMps':values[math.floor(len(values)*.95)]if values else None,'maxShoeClearanceM':max(min(v[2]for v in f['feet'][side].values())-floor for f in frames),'minShoeWorldZM':min(v[2]for f in frames for v in f['feet'][side].values())}
result={'method':'真实蒙皮shoe顶点，连续帧同顶点均在全周期最低鞋底+15mm内且至少15%鞋部顶点；比较同顶点世界XY速度，原始轨迹保留；没有从摆动脚估算root速度','fps':30,'frames':33,'clipDurationS':32/30,'floorWorldZM':floor,'rootSpeedMps':1.4023727797434615,'feet':reports,'rawFrames':frames};(root/'stance.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in result.items()if k!='rawFrames'},ensure_ascii=False))
