"""人体平面导航：当前原生几何保守AABB+有界8邻域A*；不是Recast/ORCA或任意三维地形导航。"""
import math,heapq
import numpy as np
import mujoco as mj

def config(value,error):
 if not isinstance(value,dict):raise error('HUMAN_NAV_INVALID','navigation须为显式平面边界配置')
 bounds=value.get('bounds',{});lo=bounds.get('min');hi=bounds.get('max');cell=value.get('cellSizeM',.25);clearance=value.get('clearanceM',.65)
 if not isinstance(lo,list)or not isinstance(hi,list)or len(lo)!=2 or len(hi)!=2 or any(isinstance(x,bool)or not isinstance(x,(int,float))or not math.isfinite(x)for x in lo+hi)or any(a>=b for a,b in zip(lo,hi)):raise error('HUMAN_NAV_INVALID','bounds须为有限二维min/max')
 if not isinstance(cell,(int,float))or not .1<=cell<=1 or not isinstance(clearance,(int,float))or not .65<=clearance<=2:raise error('HUMAN_NAV_INVALID','cellSizeM须0.1-1米；clearanceM须0.65-2米')
 size=[int(math.ceil((hi[i]-lo[i])/cell))+1 for i in range(2)]
 if size[0]*size[1]>4096:raise error('HUMAN_NAV_GRID_LIMIT','平面网格最多4096节点；缩小边界或增大cellSizeM')
 return np.asarray(lo),np.asarray(hi),float(cell),float(clearance),size

def obstacles(world,eid,z,height,clearance,include_humans=True):
 result=[];human_ids={g['geomId']for info in world.entities.values()if info.get('human')for g in info['humanSegments']}
 for gid in range(world.model.ngeom):
  if gid in human_ids or world.model.geom_type[gid]==mj.mjtGeom.mjGEOM_PLANE or not(world.model.geom_contype[gid]or world.model.geom_conaffinity[gid]):continue
  # geom_aabb是编译后的局部包围盒；由同一物理步geom_xpos/xmat变换，网格/旋转盒均不猜尺寸。
  bounds=world.model.geom_aabb[gid];rotation=world.data.geom_xmat[gid].reshape(3,3);center=world.data.geom_xpos[gid]+rotation@bounds[:3];half=np.abs(rotation)@bounds[3:]
  if center[2]+half[2]<=z+.08 or center[2]-half[2]>=z+height:continue
  result.append((center[:2]-half[:2]-clearance,center[:2]+half[:2]+clearance,world.model.geom(gid).name))
 if include_humans:
  for other,info in world.entities.items():
   if other==eid or not info.get('human'):continue
   lower=[];upper=[]
   for segment in info['humanSegments']:
    gid=segment['geomId'];bound=world.model.geom_aabb[gid];rotation=world.data.geom_xmat[gid].reshape(3,3);center=world.data.geom_xpos[gid]+rotation@bound[:3];half=np.abs(rotation)@bound[3:];lower.append(center[:2]-half[:2]);upper.append(center[:2]+half[:2])
   if lower:result.append((np.min(lower,axis=0)-clearance,np.max(upper,axis=0)+clearance,other))
 return result

def plan(world,eid,start,goals,options,height,error):
 lo,hi,cell,clearance,size=config(options,error)
 if any(abs(float(p[2]-start[2]))>1e-5 for p in goals):raise error('HUMAN_NAV_NONPLANAR','首版导航只支持固定Z平面；台阶/坡面/跨层明确拒绝')
 for p in[start,*goals]:
  if (np.asarray(p[:2])<lo).any()or(np.asarray(p[:2])>hi).any():raise error('HUMAN_NAV_OUT_OF_BOUNDS','起点和所有目标必须在显式平面边界内')
 rectangles=obstacles(world,eid,float(start[2]),height,clearance)
 def coord(p):return tuple(int(np.clip(round((p[i]-lo[i])/cell),0,size[i]-1))for i in range(2))
 def point(c):return lo+np.asarray(c)*cell
 def blocked(c):
  p=point(c)
  return any((p>=a).all()and(p<=b).all()for a,b,_ in rectangles)
 def segment_clear(a,b):
  delta=b-a
  for low,high,_ in rectangles:
   enter,leave=0.,1.
   for i in range(2):
    if abs(delta[i])<1e-12:
     if a[i]<low[i]or a[i]>high[i]:enter=2.;break
    else:
     t0,t1=sorted([(low[i]-a[i])/delta[i],(high[i]-a[i])/delta[i]]);enter=max(enter,t0);leave=min(leave,t1)
   if enter<=leave:return False
  return True
 path=[np.asarray(start,dtype=float)];expanded=0
 for goal in goals:
  goal=np.asarray(goal,dtype=float);origin=path[-1];source,target=coord(origin),coord(goal)
  if any((origin[:2]>=a).all()and(origin[:2]<=b).all()for a,b,_ in rectangles):raise error('HUMAN_NAV_NO_PATH','起点在当前保守障碍安全区内，等待真实通路释放')
  if blocked(target):raise error('HUMAN_NAV_NO_PATH','目标落在当前原生障碍/人物的保守安全区内')
  if segment_clear(origin[:2],goal[:2]):path.append(goal);continue
  frontier=[(0.,source)];cost={source:0.};parent={};closed=set();found=False
  while frontier:
   _,current=heapq.heappop(frontier)
   if current in closed:continue
   closed.add(current);expanded+=1
   if expanded>4096:raise error('HUMAN_NAV_NO_PATH','A*已达4096节点预算；当前通路未找到')
   if current==target:found=True;break
   for dx,dy in[(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]:
    nxt=(current[0]+dx,current[1]+dy)
    if not(0<=nxt[0]<size[0]and 0<=nxt[1]<size[1])or blocked(nxt):continue
    if dx and dy and(blocked((current[0]+dx,current[1]))or blocked((current[0],current[1]+dy))):continue
    value=cost[current]+math.hypot(dx,dy)
    if value>=cost.get(nxt,float('inf')):continue
    cost[nxt]=value;parent[nxt]=current;heapq.heappush(frontier,(value+math.hypot(nxt[0]-target[0],nxt[1]-target[1]),nxt))
  if not found:raise error('HUMAN_NAV_NO_PATH','当前边界内没有满足保守碰撞安全区的通路')
  nodes=[target]
  while nodes[-1]!=source:nodes.append(parent[nodes[-1]])
  nodes.reverse();candidates=[origin]+[np.array([*point(c),start[2]])for c in nodes[1:-1]]+[goal]
  # 原生AABB线段测试做有界视线简化，避免栅格拐角过多和斜穿障碍。
  i=0
  while i<len(candidates)-1:
   chosen=i+1
   for j in range(len(candidates)-1,i,-1):
    if segment_clear(candidates[i][:2],candidates[j][:2]):chosen=j;break
   if not segment_clear(candidates[i][:2],candidates[chosen][:2]):raise error('HUMAN_NAV_NO_PATH','当前格点之间没有通过原生几何线段检查的通路，拒绝斜穿障碍角')
   path.append(candidates[chosen]);i=chosen
 if len(path)>257:raise error('HUMAN_NAV_NO_PATH','规划路径超过256段预算')
 return path,{'status':'planned','source':'mujoco-compiled-aabb','expandedNodes':expanded,'segments':len(path)-1,'planeZ':float(start[2]),'clearanceM':clearance,'replans':0}
