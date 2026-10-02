"""林肯纪念堂可编辑建筑原型；由外部 Codex 辅助编写，供 blender_run 执行。

建筑主尺寸来自 NPS Building Statistics；局部构件、浮雕与坐像为原创简化。
导出由 packages/blender/src/world.py 完成。单位米、右手系、Z-up，入口朝 -Y。
"""
import bpy, math, json, sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(sys.argv[sys.argv.index('--output')+1]).resolve() if '--output' in sys.argv else Path(__file__).resolve().parent
ROOT.mkdir(parents=True,exist_ok=True)
FT = 0.3048
FLOOR = 8 * FT
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1.0
scene['lyapunov_world_kind'] = 'architecture'
scene['lyapunov_scene_id'] = 'lincoln-memorial'
scene['lyapunov_root_entity'] = 'lincoln_memorial'
scene['description_zh'] = 'NPS主要尺寸约束下的原创建筑原型；坐像为简化雕塑，非测绘或扫描复刻。'

def shader_node(nodes,node_type,where):
    # 节点 name 会随界面语言本地化（'Principled BSDF'->'原理化 BSDF'、'Background'->'背景'），
    # 只有 node.type / bl_idname 与语言无关；缺失即显式报错，不静默返回 None。
    found=[n for n in nodes if n.type==node_type]
    if len(found)!=1:
        raise RuntimeError('BLENDER_NODE_MISSING: '+where+'：期望恰好一个 '+node_type+' 着色器节点，实际 '+str(len(found))+' 个（现有='+str([(n.name,n.type) for n in nodes])+'）')
    return found[0]

def in_socket(node,identifier,where):
    # 插槽按 Socket.identifier（语言无关）定位，不用随界面语言变化的 Socket.name。
    for s in node.inputs:
        if s.identifier==identifier:return s
    raise RuntimeError('BLENDER_SOCKET_MISSING: '+where+'：节点 '+node.type+' 上找不到 identifier='+repr(identifier)+' 的输入插槽（现有='+str([s.identifier for s in node.inputs])+'）')

def material(name, color, roughness=.65):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = shader_node(m.node_tree.nodes,'BSDF_PRINCIPLED','material('+name+')')
    in_socket(p,'Base Color','material('+name+')').default_value = (*color, 1)
    in_socket(p,'Roughness','material('+name+')').default_value = roughness
    return m

marble = material('科罗拉多大理石_浅暖白', (.72,.69,.60))
trim = material('檐口_象牙白', (.84,.81,.72))
limestone = material('内厅_印第安纳石灰石', (.61,.58,.50))
floor_mat = material('田纳西粉色大理石', (.50,.40,.35), .42)
statue_mat = material('原创简化雕像_乔治亚白色大理石', (.85,.84,.78), .57)
granite = material('台基_浅粉灰花岗岩', (.45,.41,.37))
bronze = material('天花横梁_青铜', (.25,.18,.09), .4)
dark = material('刻字_暖灰', (.19,.17,.13))
lawn = material('周边草地_示意', (.12,.19,.095))
panel_mat = material('透光天花板_浅琥珀', (.79,.72,.52))

def empty(name, parent=None):
    o=bpy.data.objects.new(name,None); scene.collection.objects.link(o); o.parent=parent
    return o

root=empty('lincoln_memorial')
groups={name:empty(name,root) for name in ('terrace','outer_colonnade','interior','entablature','sculpture','detail')}

def finish(o,name,mat,parent,collision_size=None,role='solid'):
    o.name=name; o.parent=parent
    # 数据块名同样显式给（理由见 world.py 的 box()）：primitive_* 的默认数据块名随界面语言
    # 本地化（en_US 'Cube'/'Sphere'/'Cylinder' vs zh_HANS '立方体'/'球体'/'圆柱体'），
    # 而它是 visual_resource_id 的 slug+hash 来源，也是 GLB 节点名 —— 不赋值 resourceId 就随语言变。
    if o.data is not None: o.data.name=name
    if mat: o.data.materials.append(mat)
    if collision_size:
        o['lyapunov_shape']='box'; o['lyapunov_size']=list(collision_size)
        o['lyapunov_collision_role']=role
    else: o['lyapunov_collision']=False
    return o

def box(name,pos,size,mat,parent=None,collision=True,bevel=0,role='solid'):
    bpy.ops.mesh.primitive_cube_add(size=1,location=pos); o=bpy.context.object; o.dimensions=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    finish(o,name,mat,parent or root,size if collision else None,role)
    if bevel:
        mod=o.modifiers.new('细边倒角','BEVEL');mod.width=bevel;mod.segments=2
        o.modifiers.new('加权法线','WEIGHTED_NORMAL')
    return o

def ellipsoid(name,pos,size,mat,parent=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=12,radius=1,location=pos)
    o=bpy.context.object; o.scale=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    finish(o,name,mat,parent or groups['sculpture'])
    for p in o.data.polygons:p.use_smooth=True
    return o

def cylinder(name,pos,r,depth,mat,parent=None,vertices=40):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=r,depth=depth,location=pos)
    o=bpy.context.object
    finish(o,name,mat,parent or root)
    for p in o.data.polygons:p.use_smooth=True
    return o

def join_parts(parts,name,pos,parent,collision_size=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts:o.select_set(True)
    bpy.context.view_layer.objects.active=parts[0]
    bpy.ops.object.join(); o=bpy.context.object; o.name=name
    # join 保留**活动对象**的数据块，其名字来自某个零件（parts[0]）：显式改成合并后的实体名，
    # 让共享资源身份只由这个实体的名字决定，不随零件构造顺序/默认数据块名漂移。
    o.data.name=name
    scene.cursor.location=pos; bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    o.parent=parent
    o['lyapunov_collision']=True if collision_size else False
    if collision_size:o['lyapunov_shape']='box';o['lyapunov_size']=list(collision_size)
    return o

def column(name,x,y,height,radius,ionic=False,parent=None):
    # 柱身具有 20/24 道凹槽与轻微收分；几何不依赖贴图。
    segments=120 if ionic else 100; rings=16
    cap_h=.65 if ionic else .72; shaft_h=height-cap_h
    vertices=[]; faces=[]
    for j in range(rings+1):
        z=shaft_h*j/rings; t=j/rings
        taper=1-.14*t+.038*math.sin(math.pi*t)
        for i in range(segments):
            theta=2*math.pi*i/segments
            flute=.032*(1+math.cos((24 if ionic else 20)*theta))
            r=radius*(taper-flute)
            vertices.append((x+r*math.cos(theta),y+r*math.sin(theta),FLOOR+z))
    for j in range(rings):
        for i in range(segments):
            a=j*segments+i;b=j*segments+(i+1)%segments
            faces.append((a,b,b+segments,a+segments))
    faces.append(tuple(reversed(range(segments))))
    faces.append(tuple(rings*segments+i for i in range(segments)))
    mesh=bpy.data.meshes.new(name+'_fluted_mesh');mesh.from_pydata(vertices,[],faces);mesh.update()
    shaft=bpy.data.objects.new(name+'_shaft',mesh);scene.collection.objects.link(shaft);shaft.data.materials.append(limestone if ionic else marble)
    for p in shaft.data.polygons:p.use_smooth=True
    parts=[shaft]
    for j,(rad,h) in enumerate([(radius*.90,.12),(radius*1.06,.22),(radius*1.19,.22)]):
        parts.append(cylinder(name+'_capital_'+str(j),(x,y,FLOOR+shaft_h+.10+j*.17),rad,h,trim))
    parts.append(box(name+'_abacus',(x,y,FLOOR+height-.09),(radius*2.48,radius*2.48,.18),trim,collision=False))
    if ionic:
        for side in [-1,1]:
            part=cylinder(name+'_volute_'+str(side),(x+side*radius,y,FLOOR+height-.35),.32,.32,trim,vertices=32)
            part.rotation_euler.x=math.pi/2;parts.append(part)
    # 同一根柱一个可编辑实体，方盒物理包络保守但不封闭柱间。
    o=join_parts(parts,name,(x,y,FLOOR+height/2),parent or groups['outer_colonnade'],(radius*2.48,radius*2.48,height))
    o['collision_note_zh']='柱身/柱帽的保守方盒包络，非高精度凹槽碰撞。'
    o['architectural_role']='Ionic interior column' if ionic else 'Doric exterior column'
    return o

# 地面与三层台基。台基为完整实心楼板，内部行走在其顶面。
box('site_ground',(0,0,-.14),(100,88,.28),lawn,groups['terrace'],role='ground')
for i,(w,d) in enumerate([(201+10/12,132),(197.2,128),(192.5,124.6)]):
    top=(i+1)*FLOOR/3
    box('terrace_step_'+str(i+1),(0,0,top/2),(w*FT,d*FT,top),granite,groups['terrace'],bevel=.035,role='floor')
# 走面顶高严格一致，主厅地面材质独立。
box('chamber_floor',(0,0,FLOOR-.035),(47.4,25.2,.08),floor_mat,groups['interior'],collision=False,role='floor')
# 前侧宽台阶用于建筑辨识；机器人试验从上平台开始，不假定能爬阶。
for i in range(8):
    height=(i+1)*FLOOR/8
    box('front_stair_'+str(i+1),(0,-24.0+i*.58,height/2),(32,5.3-i*.56,height),granite,groups['terrace'],role='stair')

# NPS柱廊包络 188'4'' × 118'6''，基径7'5''，柱高44'。
CW=(188+4/12)*FT; CD=(118+6/12)*FT; R=(7+5/12)*FT/2; H=44*FT
X=CW/2-R*1.24; Y=CD/2-R*1.24
xs=[-X+2*X*i/11 for i in range(12)]
ys=[-Y+2*Y*i/7 for i in range(8)]
for side,y in [('front',-Y),('back',Y)]:
    for i,x in enumerate(xs):column('doric_'+side+'_'+str(i+1).zfill(2),x,y,H,R)
for side,x in [('left',-X),('right',X)]:
    for i,y in enumerate(ys[1:-1]):column('doric_'+side+'_'+str(i+1).zfill(2),x,y,H,R)
for side,x in [('left',-6.3),('right',6.3)]:column('entrance_column_'+side,x,-12.2,H,R)

# 三厅外壳留真实入口，不使用整栋凸包；中厅由8根爱奥尼柱界定。
wall_h=60*FT
box('rear_wall',(0,12.45,FLOOR+wall_h/2),(47.6,.9,wall_h),limestone,groups['interior'])
for side,x in [('left',-23.35),('right',23.35)]:
    box('side_wall_'+side,(x,0,FLOOR+wall_h/2),(.9,24.9,wall_h),limestone,groups['interior'])
    center=-16.275 if side=='left' else 16.275
    box('front_wall_'+side,(center,-12.45,FLOOR+wall_h/2),(14.15,.9,wall_h),limestone,groups['interior'])
box('entrance_lintel',(0,-12.45,FLOOR+15.6),(18.4,.9,5.4),limestone,groups['interior'])
for side,x in [('left',-9.75),('right',9.75)]:
    for i,y in enumerate([-8.25,-2.75,2.75,8.25]):column('ionic_'+side+'_'+str(i+1),x,y,50*FT,5.5*FT/2,True,groups['interior'])
    box('ionic_beam_'+side,(x,0,FLOOR+16.35),(1.95,24.6,2.2),limestone,groups['interior'])

# 四周叠层檐口、楣梁、阁楼和屋顶。每段分件并按原始尺寸保留。
for level,(z,h,overhang) in enumerate([(FLOOR+H+.30,.60,.10),(FLOOR+H+1.15,1.10,.23),(FLOOR+H+1.90,.40,.55)]):
    for side,y in [('front',-(CD/2+.10)),('back',CD/2+.10)]:
        box('entablature_'+str(level)+'_'+side,(0,y,z),(CW+1.7+overhang,1.5+overhang,h),trim,groups['entablature'])
    for side,x in [('left',-(CW/2+.10)),('right',CW/2+.10)]:
        box('entablature_'+str(level)+'_'+side,(x,0,z),(1.5+overhang,CD+.2-(1.5+overhang),h),trim,groups['entablature'])
attic_z=FLOOR+H+4.0
for side,y in [('front',-16.40),('back',16.40)]:box('attic_'+side,(0,y,attic_z),(54.8,1.4,3.8),marble,groups['entablature'])
for side,x in [('left',-26.7),('right',26.7)]:box('attic_'+side,(x,0,attic_z),(1.4,31.4,3.8),marble,groups['entablature'])
box('roof_crown',(0,0,FLOOR+H+6.1),(56.2,35.9,.50),trim,groups['entablature'])
box('main_roof',(0,0,FLOOR+18.63),(48.4,26.2,.65),limestone,groups['entablature'])
# 天花为嵌格结构，顶面受灯照明；不虚构古迹壁画内容。
for ix in range(7):
    box('ceiling_beam_x_'+str(ix),(-20.4+ix*6.8,0,FLOOR+18.07),(.18,24,.34),bronze,groups['detail'],False)
for iy in range(7):
    box('ceiling_beam_y_'+str(iy),(0,-10.8+iy*3.6,FLOOR+18.06),(46,.18,.36),bronze,groups['detail'],False)
for ix in range(6):
    for iy in range(6):
        box('ceiling_panel_'+str(ix)+'_'+str(iy),(-17.0+ix*6.8,-9+iy*3.6,FLOOR+18.28),(6.55,3.35,.08),panel_mat,groups['detail'],False)
# 外檐小齿饰和壁柱，保持节制。
for i,x in enumerate(xs):
    box('frieze_panel_front_'+str(i),(x,-18.25,FLOOR+H+1.15),(2.7,.08,.62),marble,groups['detail'],False)
    box('attic_pilaster_front_'+str(i),(x,-17.16,attic_z),(.20,.15,3.8),trim,groups['detail'],False)
for i in range(61):
    x=-27.0+i*.9
    box('dentil_front_'+str(i),(x,-18.9,FLOOR+H+1.6),(.28,.32,.3),trim,groups['detail'],False)

# 原创简化坐像：基座按NPS主尺寸，人物服饰、面部与椅子不声称复刻原雕塑。
S=groups['sculpture']; CY=6.45
box('statue_platform',(0,CY,FLOOR+.0762),(10.4902,8.5598,.1524),floor_mat,S,role='pedestal')
box('statue_pedestal',(0,CY,FLOOR+3.048/2),(4.8768,5.1816,3.048),floor_mat,S,bevel=.09,role='pedestal')
box('statue_plinth',(0,CY,FLOOR+3.048+.4826/2),(5.80,6.05,.4826),statue_mat,S,bevel=.05,role='pedestal')
Z0=FLOOR+3.048+.4826
parts=[]
parts.append(box('chair_back',(0,CY+1.4,Z0+2.55),(4.85,.70,4.95),statue_mat,S,False,bevel=.12))
parts.append(box('chair_seat',(0,CY,Z0+1.9),(4.8,3.65,.60),statue_mat,S,False,bevel=.1))
for side in [-1,1]:
    parts.append(box('chair_arm_'+str(side),(side*2.10,CY-.25,Z0+2.85),(.60,3.55,.55),statue_mat,S,False,bevel=.1))
    parts.append(box('chair_front_support_'+str(side),(side*2.08,CY-1.65,Z0+1.5),(.64,.6,2.7),statue_mat,S,False,bevel=.07))
    for j in range(4):
        parts.append(cylinder('chair_bundle_'+str(side)+'_'+str(j),(side*2.1+(j-1.5)*.14,CY-1.98,Z0+1.45),.075,2.5,statue_mat,S,20))
parts.append(ellipsoid('coat_torso',(0,CY+.14,Z0+3.25),(1.54,.82,1.47),statue_mat,S))
parts.append(ellipsoid('seated_pelvis',(0,CY-.35,Z0+2.00),(1.45,1.18,.62),statue_mat,S))
for side in [-1,1]:
    thigh=ellipsoid('trouser_thigh_'+str(side),(side*.78,CY-1.03,Z0+1.87),(.66,1.29,.58),statue_mat,S);parts.append(thigh)
    shin=ellipsoid('trouser_shin_'+str(side),(side*.88,CY-2.07,Z0+1.08),(.46,.51,1.02),statue_mat,S);shin.rotation_euler.x=-.13;parts.append(shin)
    parts.append(ellipsoid('shoe_'+str(side),(side*.90,CY-2.46,Z0+.24),(.51,.84,.27),statue_mat,S))
    upper=ellipsoid('coat_upperarm_'+str(side),(side*1.5,CY-.02,Z0+3.18),(.47,.50,.97),statue_mat,S);upper.rotation_euler.y=side*.35;parts.append(upper)
    fore=ellipsoid('coat_forearm_'+str(side),(side*1.87,CY-.86,Z0+2.93),(.40,.88,.39),statue_mat,S);parts.append(fore)
    parts.append(ellipsoid('hand_'+str(side),(side*1.92,CY-1.61,Z0+2.99),(.32,.50,.23),statue_mat,S))
    # 长翻领凸纹及裤褶，让正面阅读为坐姿西装人物。
    lapel=box('lapel_'+str(side),(side*.42,CY-.65,Z0+3.68),(.22,.16,1.40),trim,S,False,bevel=.07);lapel.rotation_euler.y=side*-.25;parts.append(lapel)
    for j in range(3):
        fold=box('trouser_fold_'+str(side)+'_'+str(j),(side*.85+(j-1)*.18,CY-2.52,Z0+1.0),(.05,.035,1.12),trim,S,False,bevel=.015);parts.append(fold)
parts.append(ellipsoid('neck',(0,CY+.03,Z0+4.47),(.37,.35,.42),statue_mat,S))
parts.append(ellipsoid('head',(0,CY-.06,Z0+5.14),(.47,.43,.65),statue_mat,S))
parts.append(ellipsoid('hair',(0,CY+.02,Z0+5.50),(.48,.45,.29),statue_mat,S))
parts.append(ellipsoid('beard',(0,CY-.26,Z0+4.91),(.37,.27,.32),statue_mat,S))
parts.append(ellipsoid('nose',(0,CY-.48,Z0+5.16),(.10,.19,.16),statue_mat,S))
for side in [-1,1]:
    parts.append(ellipsoid('brow_'+str(side),(side*.19,CY-.439,Z0+5.34),(.17,.04,.055),statue_mat,S))
    parts.append(ellipsoid('ear_'+str(side),(side*.47,CY-.04,Z0+5.13),(.085,.14,.20),statue_mat,S))
sculpt=join_parts(parts,'original_simplified_seated_lincoln',(0,CY-.20,Z0+2.896),S,(5.79,6.10,5.792))
sculpt['description_zh']='原创简化坐姿人物与椅子，非Daniel Chester French原作的扫描或忠实复制。'

# 背墙 inscription 仅用作品名称与原型声明，避免伪造历史原文。
def text_obj(name,text,pos,size,mat,parent=None):
    curve=bpy.data.curves.new(name,'FONT');curve.body=text;curve.align_x='CENTER';curve.size=size;curve.extrude=.002
    o=bpy.data.objects.new(name,curve);scene.collection.objects.link(o);o.location=pos;o.rotation_euler=(math.pi/2,0,0);o.parent=parent or groups['detail'];curve.materials.append(mat)
    bpy.context.view_layer.objects.active=o;o.select_set(True);bpy.ops.object.convert(target='MESH');o=bpy.context.object;o['lyapunov_collision']=False
    bpy.ops.object.select_all(action='DESELECT');return o

text_obj('wall_title','ABRAHAM  LINCOLN',(0,11.96,FLOOR+13.1),.58,dark)
text_obj('wall_subtitle','A  MEMORIAL  TO  THE  UNION',(0,11.96,FLOOR+12.15),.31,dark)
for x in [-4.5,4.5]:box('rear_statue_pilaster_'+str(x),(x,11.91,FLOOR+8.5),(.70,.20,15.5),trim,groups['detail'],False)
# 地面板缝为实际细条，在可编辑源中独立；不参与碰撞。
for i in range(-7,8):box('floor_joint_x_'+str(i),(i*3,0,FLOOR+.008),(.017,24,.004),granite,groups['detail'],False)
for i in range(-5,6):box('floor_joint_y_'+str(i),(0,i*2.25,FLOOR+.008),(46,.017,.004),granite,groups['detail'],False)

def camera(name,loc,target,lens):
    # 相机数据块名同样显式给（理由同 finish 的网格数据块）：operator 默认名随界面语言
    # （en_US 'Camera.001' vs zh_HANS '摄像机'），不赋值数据块名就随语言漂。
    bpy.ops.object.camera_add(location=loc);o=bpy.context.object;o.name=name;o.data.name=name;o.data.lens=lens
    o.rotation_euler=(Vector(target)-o.location).to_track_quat('-Z','Y').to_euler();return o
exterior=camera('exterior_camera',(70,-85,45),(0,0,10.5),44)
interior_camera=camera('interior_camera',(0,-11.0,FLOOR+3.0),(0,6.3,FLOOR+7.1),22)
camera('plan_camera',(0,0,95),(0,0,0),32)
scene.camera=exterior
world=bpy.data.worlds.new('建筑天空') if not scene.world else scene.world;scene.world=world;world.use_nodes=True
bg=shader_node(world.node_tree.nodes,'BACKGROUND','world('+world.name+')')
in_socket(bg,'Color','world('+world.name+')').default_value=(.48,.57,.73,1)
in_socket(bg,'Strength','world('+world.name+')').default_value=.45
# 灯与相机一样：对象名与数据块名都显式给（数据块默认名 en_US 'Sun'/'Area' vs zh_HANS '日光'/'面光'）。
bpy.ops.object.light_add(type='SUN',location=(0,-20,45));sun=bpy.context.object;sun.name='late_afternoon_sun';sun.data.name='late_afternoon_sun';sun.data.energy=2.2;sun.data.angle=.06;sun.rotation_euler=(.46,-.55,-.30)
for x in [-13,0,13]:
    bpy.ops.object.light_add(type='AREA',location=(x,-2,FLOOR+17));o=bpy.context.object;o.name='interior_ceiling_light_'+str(x);o.data.name='interior_ceiling_light_'+str(x);o.data.energy=2600;o.data.shape='DISK';o.data.size=10
    o.data.color=(1,.84,.66)
bpy.ops.object.light_add(type='AREA',location=(0,-9,FLOOR+9));o=bpy.context.object;o.name='statue_softbox';o.data.name='statue_softbox';o.data.energy=1900;o.data.size=8;o.rotation_euler=(Vector((0,CY,Z0+3))-o.location).to_track_quat('-Z','Y').to_euler()
scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=32;scene.cycles.use_denoising=True
scene.render.resolution_x=1500;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX'
bpy.context.view_layer.update()
scene.cursor.location=(0,0,0)
route=[[0,-18.5,FLOOR],[0,-14,FLOOR],[0,-10,FLOOR],[0,-2,FLOOR],[6.8,-2,FLOOR],[6.8,6.45,FLOOR]]
manifest={
 'sceneId':'lincoln-memorial','origin':'顶层平台中心在 XY 原点，底部地面 Z=0；入口朝 -Y',
 'units':'m','upAxis':'Z','handedness':'right','floorHeightM':FLOOR,
 'robotSpawnSupport':[0,-18.5,FLOOR],'navigationRouteSupportPoints':route,
 'routeRadiusM':.45,'routeNote':'机器人中心高度须另加；原型从上平台起步，不包含爬台阶。',
 'centralChamberWidthM':60*FT,'centralChamberDepthM':74*FT,'centralChamberHeightM':60*FT,
 'outerColonnadeWidthM':CW,'outerColonnadeDepthM':CD,'outerColumnHeightM':H,'outerColumnDiameterM':2*R,
 'outerColumnCount':36,'entranceColumnCount':2,'innerColumnCount':8,
 'sculptureStatus':'原创简化，非测绘/扫描复刻；坐姿尺度按NPS的19英尺设计。',
 'collisionStrategy':'逐墙、地板、台阶、柱、基座分件box；柱/雕像为保守包络，装饰不碰撞；禁止整建筑凸包。',
 'visualFloorOffsetM':.005,
 'frontCenterGapBetweenCollisionBoxesM':xs[6]-xs[5]-R*2.48,
 'sourceFacts':[{'url':'https://www.nps.gov/linc/learn/historyculture/lincoln-memorial-building-statistics.htm','checkedAt':'2026-09-11','used':'柱廊宽深/柱高径/柱数量/平台总高/内厅宽深高/像及基座主尺寸'}],
 'estimatedDetails':['构件局部比例与檐口','柱位细节与柱帽','前部八级入口台阶','侧厅装饰与天花格栅','光照、材质与场地','原创简化坐像及文字布局'],
 'authorship':'外部Codex建模原型；供DSH blender_run复用，不声称由产品内Agent自主完成。'
}
(ROOT/'model_manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
# 全场可交换视觉供快速查看；标准GLB按规范Y-up，原工程和Scene仍为Z-up。
bpy.ops.object.select_all(action='DESELECT')
for o in scene.objects:
    if o.type=='MESH':o.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(ROOT/'lincoln_memorial.glb'),export_format='GLB',use_selection=True,export_yup=True,export_extras=True,export_cameras=False,export_lights=False)
print('LINCOLN_MODEL_READY='+json.dumps(manifest,ensure_ascii=False))
