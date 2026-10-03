"""离线独立几何派生。静态环境分对象 triangle mesh，不将房间封成单凸包。"""
import inspect,json,os,sys,importlib.util,hashlib,time
from pathlib import Path
from geometry_stream import GLBGeometry,MAX_MANIFEST_BYTES,MAX_NODE_BYTES,MAX_READ_BYTES

POINT_CHUNK_SIZE = 32768
POINT_CHUNK_BYTES = 8*1024*1024
POINT_MAX_OCCUPIED = 250000
POINT_MAX_BOXES = 2048
POINT_MAX_AUTO_VOXEL_M = .03

class BakeGeometryError(ValueError):
    def __init__(self,message,details):
        self.details=details
        super().__init__(message)

def dependency_facts(method='triangle_mesh'):
    """同一几何解释器的轻量依赖发现；不导入 Isaac/Kit、不加载模型、不写输出。"""
    required=['numpy','trimesh','scipy']+(['coacd'] if method=='coacd' else [])
    missing=[]
    for name in required:
        try:found=importlib.util.find_spec(name) is not None
        except (ImportError,ValueError,AttributeError):found=False
        if not found:missing.append(name)
    return {'provider':'asset-bake','python':sys.executable,'stage':'geometry-dependencies',
            'status':'BLOCKED' if missing else 'AVAILABLE','required':required,'missing':missing}

class BakeDependencyError(ImportError):
    def __init__(self,facts):
        self.facts=facts
        super().__init__('几何解释器缺少依赖：'+', '.join(facts['missing']))

def point_parameters(req):
    import math
    axis=req.get('sourceUpAxis','Y');scale=req.get('metersPerUnit',1.)
    if axis not in ('Y','Z'): raise ValueError('INVALID_SOURCE_UP_AXIS: 点云源轴必须明确为 Y 或 Z')
    if isinstance(scale,bool) or not isinstance(scale,(int,float)) or not math.isfinite(scale) or scale<=0:
        raise ValueError('INVALID_METERS_PER_UNIT: 点云源单位比例必须是有限正数')
    if req.get('pointCloudStrategy',req.get('strategy')) not in ('auto','voxel_boxes') and not(req.get('pointCloudStrategy',req.get('strategy'))=='triangle_mesh' and req.get('pointCloudTiling',{}).get('coverage')=='full'):
        raise ValueError('POINT_CLOUD_REQUIRES_VOXELS: 源文件只有点、没有三角面；请用 strategy=auto 或 voxel_boxes，不能把点云当 triangle_mesh/coacd/convex_hull')
    if req.get('pointCloudStrategy',req.get('strategy'))=='triangle_mesh' and req.get('usage','static') not in ('static','environment'):
        raise ValueError('POINT_CLOUD_VOXEL_SURFACE_REQUIRES_EXPLICIT_STATIC_TRIANGLE_MESH')
    return axis,float(scale)

def ply_points(source):
    """点云 PLY 只提取真实 XYZ。定长记录逐块读取，不映射整个大文件、不复制全量 SH。"""
    import numpy as np
    if source.suffix.lower()!='.ply': return None
    types={'char':'i1','int8':'i1','uchar':'u1','uint8':'u1','short':'i2','int16':'i2',
           'ushort':'u2','uint16':'u2','int':'i4','int32':'i4','uint':'u4','uint32':'u4',
           'float':'f4','float32':'f4','double':'f8','float64':'f8'}
    with source.open('rb') as stream:
        if stream.readline().strip()!=b'ply': raise ValueError('INVALID_PLY_HEADER')
        elements=[];fmt=None;current=None;used=4
        while True:
            line=stream.readline(65537);used+=len(line)
            if not line or used>65536: raise ValueError('INVALID_PLY_HEADER: 缺少 end_header 或头部超预算')
            fields=line.decode('ascii').strip().split()
            if not fields: continue
            if fields[0]=='end_header': break
            if fields[0]=='format': fmt=fields[1]
            elif fields[0]=='element':
                current={'name':fields[1],'count':int(fields[2]),'properties':[]};elements.append(current)
                if current['count']<0: raise ValueError('INVALID_PLY_ELEMENT_COUNT')
            elif fields[0]=='property':
                if current is None: raise ValueError('INVALID_PLY_PROPERTY')
                current['properties'].append(fields[1:])
        offset=stream.tell()
    if any(e['name']=='face' and e['count']>0 for e in elements): return None # 真实三角网格仍走 Trimesh
    vertex=next((e for e in elements if e['name']=='vertex'),None)
    if vertex is None or vertex['count']<=0: raise ValueError('EMPTY_POINT_CLOUD')
    if any(e['count']>0 for e in elements[:elements.index(vertex)]):
        raise ValueError('UNSUPPORTED_POINT_CLOUD_LAYOUT: vertex 前有非空数据元素')
    properties=vertex['properties'];names=[p[-1] for p in properties]
    if not all(a in names for a in ('x','y','z')): raise ValueError('POINT_CLOUD_XYZ_REQUIRED')
    if len(set(names))!=len(names) or any(len(p)!=2 or p[0] not in types for p in properties):
        raise ValueError('UNSUPPORTED_POINT_CLOUD_LAYOUT: 点属性必须是唯一名称的定长数值，不能把列表属性当 XYZ')
    count=vertex['count']
    observed={'sourceReadBytes':0,'sourceReadCalls':0,'observedMaxReadBytes':0}
    if fmt in ('binary_little_endian','binary_big_endian'):
        endian='<' if fmt=='binary_little_endian' else '>'
        dtype=np.dtype([(p[1],endian+types[p[0]]) for p in properties])
        if source.stat().st_size<offset+count*dtype.itemsize: raise ValueError('TRUNCATED_POINT_CLOUD')
        def chunks():
            # mmap 全文件即使按块索引，已触及的文件页仍可能把进程 RSS 推到原件尺寸。
            # 这里每次最多 8 MiB 原始记录，再仅取三列，常驻内存不随 2 GB 原件递增。
            block=max(1,min(POINT_CHUNK_SIZE,POINT_CHUNK_BYTES//dtype.itemsize))
            with source.open('rb') as stream:
                stream.seek(offset);remaining=count
                while remaining:
                    wanted=min(remaining,block);rows=np.fromfile(stream,dtype=dtype,count=wanted)
                    if len(rows)!=wanted: raise ValueError('TRUNCATED_POINT_CLOUD')
                    observed['sourceReadBytes']+=rows.nbytes;observed['sourceReadCalls']+=1
                    observed['observedMaxReadBytes']=max(observed['observedMaxReadBytes'],rows.nbytes)
                    remaining-=wanted
                    yield np.column_stack([rows[a] for a in ('x','y','z')]).astype(np.float64,copy=False)
    elif fmt=='ascii':
        indices=[names.index(a) for a in ('x','y','z')]
        def chunks():
            with source.open('rb') as stream:
                stream.seek(offset);remaining=count
                while remaining:
                    rows=[];read_bytes=0
                    for _ in range(min(remaining,POINT_CHUNK_SIZE)):
                        line=stream.readline(16385)
                        if not line or len(line)>16384: raise ValueError('TRUNCATED_POINT_CLOUD: 缺行或点属性行超预算')
                        if rows and read_bytes+len(line)>POINT_CHUNK_BYTES:
                            stream.seek(-len(line),1);break
                        fields=line.split()
                        if len(fields)!=len(names): raise ValueError('INVALID_POINT_CLOUD_ROW')
                        rows.append([float(fields[i]) for i in indices])
                        read_bytes+=len(line)
                        if read_bytes>=POINT_CHUNK_BYTES: break
                    observed['sourceReadBytes']+=read_bytes;observed['sourceReadCalls']+=1
                    observed['observedMaxReadBytes']=max(observed['observedMaxReadBytes'],read_bytes)
                    remaining-=len(rows);yield np.asarray(rows,dtype=np.float64)
    else: raise ValueError('UNSUPPORTED_PLY_FORMAT: '+str(fmt))
    observed.update({'format':fmt,'sourceBytes':source.stat().st_size,'vertexStrideBytes':dtype.itemsize if fmt!='ascii' else None,'streamedXYZ':True,'maxReadBytes':POINT_CHUNK_BYTES,'readStrategy':'chunked-records-xyz'})
    return chunks,count,observed

def point_voxels(chunks,count,req,source_info):
    """仅占据真实采样落入的单元；不填腔、不从稀疏点虚造三角面。"""
    import math,time,numpy as np
    started=time.perf_counter()
    axis,scale=point_parameters(req)
    def transformed():
        for points in chunks():
            valid=np.isfinite(points).all(axis=1);points=points[valid]
            if axis=='Y': points=points[:,[0,2,1]];points[:,1]*=-1
            points=points*scale
            if not np.isfinite(points).all(): raise ValueError('NONFINITE_POINT_CLOUD_TRANSFORM')
            yield points
    lo=np.full(3,np.inf);hi=np.full(3,-np.inf);finite_count=0
    for points in transformed():
        if len(points):lo=np.minimum(lo,points.min(axis=0));hi=np.maximum(hi,points.max(axis=0));finite_count+=len(points)
    if not finite_count: raise ValueError('EMPTY_POINT_CLOUD: 没有有限 XYZ 样本')
    bounds_ms=(time.perf_counter()-started)*1000
    explicit='voxelSizeM' in req
    pitch=req.get('voxelSizeM',max(float(np.max(hi-lo))/48.,.02))
    if isinstance(pitch,bool) or not isinstance(pitch,(int,float)) or not math.isfinite(pitch) or pitch<=0:
        raise ValueError('INVALID_VOXEL_SIZE: voxelSizeM 必须是有限正数（米）')
    def require_precision(value):
        if not explicit and value>POINT_MAX_AUTO_VOXEL_M:
            raise BakeGeometryError('POINT_CLOUD_PRECISION_REQUIRED: 自动体素超过 0.03 米精度上限；请显式指定 voxelSizeM 并满足占据/盒数预算，未丢弃远点或粗化为可用碰撞',
                {'stage':'point-cloud-precision','sourcePoints':count,'finitePoints':finite_count,'proposedVoxelSizeM':float(value),
                 'maxAutoVoxelSizeM':POINT_MAX_AUTO_VOXEL_M,'sourceBoundsM':{'min':lo.tolist(),'max':hi.tolist()},
                 'sourceReads':{key:source_info[key] for key in ('sourceReadBytes','sourceReadCalls','observedMaxReadBytes') if key in source_info}})
    require_precision(pitch)
    def budget(name,default,upper):
        value=req.get(name,default)
        if isinstance(value,bool) or not isinstance(value,int) or value<1 or value>upper:
            raise ValueError('INVALID_POINT_CLOUD_BUDGET: '+name+' 必须是 1..'+str(upper)+' 的整数')
        return value
    max_occupied=budget('maxOccupiedVoxels',POINT_MAX_OCCUPIED,1000000)
    max_boxes=budget('maxBoxes',POINT_MAX_BOXES,10000)
    # 绝对晶格坐标便于自动边长按 2 倍合并时保持同一原点；拒绝超出 int64 的坐标，不能溢出绕回。
    if np.max(np.abs(np.concatenate([lo,hi]))/pitch)>2**52:
        raise ValueError('POINT_CLOUD_COORDINATE_RANGE: 坐标/体素比超出安全整数范围')
    occupied=set();voxel_started=time.perf_counter();processed_points=0;observed_lo=np.full(3,np.inf);observed_hi=np.full(3,-np.inf)
    for points in transformed():
        processed_points+=len(points)
        cells=np.unique(np.floor(points/pitch).astype(np.int64),axis=0)
        for cell in cells:
            occupied.add(tuple(int(v) for v in cell))
            observed_lo=np.minimum(observed_lo,cell);observed_hi=np.maximum(observed_hi,cell)
            if len(occupied)>max_occupied:
                raise BakeGeometryError('POINT_CLOUD_VOXEL_BUDGET_EXCEEDED: 占据单元超过 '+str(max_occupied)+'；固定精度不被偷偷粗化，请显式调整 voxelSizeM/maxOccupiedVoxels',
                    {'stage':'point-cloud-occupied','voxelSizeM':float(pitch),'maxOccupiedVoxels':max_occupied,'requiredOccupiedVoxelsAtLeast':len(occupied),
                     'sourcePoints':count,'finitePoints':finite_count,'processedFiniteSamples':processed_points,'coverageComplete':False,
                     'sourceBoundsM':{'min':lo.tolist(),'max':hi.tolist()},'observedOccupiedCellBounds':{'min':observed_lo.astype(int).tolist(),'max':observed_hi.astype(int).tolist()},
                     'sourceReads':{key:source_info[key] for key in ('sourceReadBytes','sourceReadCalls','observedMaxReadBytes') if key in source_info}})
        if processed_points% (POINT_CHUNK_SIZE*8)==0:print('LYAPUNOV_PROGRESS='+json.dumps({'stage':'point-cloud-occupied','processedFiniteSamples':processed_points,'sourcePoints':count,'occupiedVoxels':len(occupied)}),file=sys.stderr,flush=True)
    voxel_ms=(time.perf_counter()-voxel_started)*1000
    initial_occupied=len(occupied);steps=0;merge_started=time.perf_counter()
    def merge(cells,pitch):
        remaining=set(cells);boxes=[]
        for x,y,z in sorted(cells):
            if (x,y,z) not in remaining: continue
            x1=x+1
            while (x1,y,z) in remaining:x1+=1
            y1=y+1
            while all((xx,y1,z) in remaining for xx in range(x,x1)):y1+=1
            z1=z+1
            while all((xx,yy,z1) in remaining for yy in range(y,y1) for xx in range(x,x1)):z1+=1
            for zz in range(z,z1):
                for yy in range(y,y1):
                    for xx in range(x,x1):remaining.remove((xx,yy,zz))
            boxes.append({'center':[(x+x1)*pitch/2,(y+y1)*pitch/2,(z+z1)*pitch/2],
                          'halfExtents':[(x1-x)*pitch/2,(y1-y)*pitch/2,(z1-z)*pitch/2]})
            if len(boxes)>max_boxes:return None
        return boxes
    while True:
        boxes=merge(occupied,pitch)
        if boxes is not None: break
        if explicit or steps>=2:
            raise BakeGeometryError('POINT_CLOUD_BOX_BUDGET_EXCEEDED: 盒数超过 '+str(max_boxes)+'；请显式调整 voxelSizeM/maxBoxes，未退回整体 bbox',
                {'stage':'point-cloud-merge','voxelSizeM':float(pitch),'maxBoxes':max_boxes,'requiredBoxesAtLeast':max_boxes+1,'occupiedVoxels':len(occupied),
                 'sourcePoints':count,'finitePoints':finite_count,'coverageComplete':False,'sourceBoundsM':{'min':lo.tolist(),'max':hi.tolist()}})
        # 仅未指定精度时允许最多两轮 2 倍合并；已有占据单元上合并，避免再次读大型原件。
        require_precision(pitch*2)
        occupied={tuple(v//2 for v in cell) for cell in occupied};pitch*=2;steps+=1
    index_min=np.min(np.asarray(list(occupied),dtype=np.int64),axis=0);index_max=np.max(np.asarray(list(occupied),dtype=np.int64),axis=0)
    return {'boxes':boxes,'voxelSizeM':float(pitch),'gridDims':(index_max-index_min+1).tolist(),
            'fillInterior':False,'tiles':1,'pointCloud':{**source_info,'sourceUpAxis':axis,'metersPerUnit':scale,'sourcePoints':count,'finitePoints':finite_count,
              'skippedNonfinitePoints':count-finite_count,'occupiedVoxels':len(occupied),'initialOccupiedVoxels':initial_occupied,
              'maxOccupiedVoxels':max_occupied,'maxBoxes':max_boxes,'chunkPoints':POINT_CHUNK_SIZE,
              'explicitVoxelSize':explicit,'autoCoarseningSteps':steps,'sourceBoundsM':{'min':lo.tolist(),'max':hi.tolist()},
              'maxAutoVoxelSizeM':POINT_MAX_AUTO_VOXEL_M,
              'phaseMs':{'boundsXYZ':round(bounds_ms,3),'occupiedVoxels':round(voxel_ms,3),'mergeBoxes':round((time.perf_counter()-merge_started)*1000,3)},
              'coverage':'measured-sample-voxels','coverageNotice':'只有实际 XYZ 样本的占据单元；没有三角面，不推断未扫描表面/封闭体积/净通道，也不填内部。'}}

def same_file(left,right):
    """同一文件判定：resolve 覆盖符号链接，os.path.samefile(dev+ino) 覆盖硬链接；输出通常尚不存在。"""
    if left.resolve()==right.resolve(): return True
    try: return os.path.samefile(left,right)
    except OSError: return False

def assert_output(target,source,out):
    if target.resolve().parent!=out or same_file(target,source):
        raise ValueError('SOURCE_OVERWRITE_REJECTED: 源文件或输出目录外的别名不能用作派生产物：'+str(target))

def write_array(values,dtype,path,source,out):
    """小段二进制写入并计算内容身份；不转换全节点为 Python 数字列表。"""
    import numpy as np
    assert_output(path,source,out)
    array=np.ascontiguousarray(values,dtype=dtype).reshape(-1)
    if array.nbytes>MAX_NODE_BYTES:raise ValueError('GEOMETRY_NODE_BUDGET_EXCEEDED')
    view=memoryview(array).cast('B');digest=hashlib.sha256()
    with path.open('wb') as stream:
        for start in range(0,len(view),MAX_READ_BYTES):
            block=view[start:start+MAX_READ_BYTES];stream.write(block);digest.update(block)
    return {'path':str(path),'dtype':'f64le' if dtype=='<f8' else 'u32le',
            'count':int(array.size),'bytes':int(array.nbytes),'sha256':digest.hexdigest()}

def write_obj(mesh,path,source,out):
    """OBJ 流式写出，不使用 Trimesh 的全节点字符串 export。"""
    assert_output(path,source,out)
    with path.open('w',encoding='ascii',newline='\n') as stream:
        lines=[];size=0
        for vertex in mesh.vertices:
            line='v %.17g %.17g %.17g\n'%tuple(vertex);lines.append(line);size+=len(line)
            if size>=1024*1024:stream.write(''.join(lines));lines=[];size=0
        if lines:stream.write(''.join(lines))
        lines=[];size=0
        for face in mesh.faces:
            line='f %d %d %d\n'%(int(face[0])+1,int(face[1])+1,int(face[2])+1);lines.append(line);size+=len(line)
            if size>=1024*1024:stream.write(''.join(lines));lines=[];size=0
        if lines:stream.write(''.join(lines))

def bounded_json(value,code='GEOMETRY_MANIFEST_BUDGET_EXCEEDED'):
    """先逐段核小清单预算再拼接；元数据超额也不先构造巨型 JSON 字符串。"""
    pieces=[];size=0
    for piece in json.JSONEncoder(separators=(',',':'),allow_nan=False).iterencode(value):
        size+=len(piece.encode('utf8'))
        if size>MAX_MANIFEST_BYTES:raise ValueError(code+': 小清单超过 8 MiB')
        pieces.append(piece)
    return ''.join(pieces)

def bake(req):
    facts=dependency_facts(req.get('method','triangle_mesh'))
    if facts['status']!='AVAILABLE':raise BakeDependencyError(facts)
    import trimesh
    from urllib.parse import urlsplit,unquote
    source_value=req['sourcePath']
    if source_value.startswith('file:'):
      uri=urlsplit(source_value)
      if uri.netloc not in ('','localhost') or uri.query or uri.fragment: raise ValueError('INVALID_LOCAL_SOURCE_URI: 只接受本机无查询参数的 file URI')
      source_value=unquote(uri.path)
    source=Path(source_value).resolve(); out=Path(req['outputDirectory']).resolve();out.mkdir(parents=True,exist_ok=True)
    method=req.get('method','triangle_mesh');usage=req.get('usage','static')
    if usage=='environment' and method=='convex_hull': raise ValueError('UNSUPPORTED_CAPABILITY: 环境应逐部件导出 triangle_mesh 或显式分解')
    if method not in ['triangle_mesh','convex_hull','coacd']:raise ValueError('INVALID_BAKE_METHOD')
    started=time.perf_counter();geometry=[];parts=[];reader=None
    geometry_prefix='geometry-coacd' if method=='coacd' else 'geometry'
    geometry_path=out/(geometry_prefix+'.json');bake_path=out/'bake.json'
    for target in [geometry_path,bake_path]:assert_output(target,source,out)
    import re
    # 首个产物写入前核已有输出别名，保留符号链接/硬链接原件保护。
    for target in out.iterdir():
      if re.fullmatch(r'(part-\d+-\d+\.obj|geometry(?:-coacd)?-\d+\.(position\.f64|index\.u32)\.bin)',target.name) and same_file(target,source):
        raise ValueError('SOURCE_OVERWRITE_REJECTED: 源文件是派生产物的已有别名：'+str(target))
    source_frame={'pose':'reference','sourceUpAxis':req.get('sourceUpAxis','Y'),'metersPerUnit':req.get('metersPerUnit',1.),
                  'derivedUnits':'m','derivedUpAxis':'Z','animation':{'clips':0,'evaluated':False,'skinApplied':False}}
    points=ply_points(source)
    if points is not None:
      chunks,count,info=points
      if req.get('pointCloudTiling') is not None:
        from point_tiled import point_voxels_tiled
        axis,scale=point_parameters(req);result=point_voxels_tiled(chunks,count,req,info,axis,scale,out,lambda path:assert_output(path,source,out))
      else:result=point_voxels(chunks,count,req,info)
      if result.get('surface'):
        geometry.extend(result['nodes']);parts.extend(result['parts'])
      else:geometry.append({'node':'point-cloud','kind':'point_cloud','watertight':False,'decomposition':result})
      source_meshes=iter([])
    elif source.suffix.lower()=='.glb':
      reader=GLBGeometry(source,req);source_frame=reader.source_frame;source_meshes=reader.meshes()
    else:
      if source.stat().st_size>MAX_NODE_BYTES:
        raise ValueError('GEOMETRY_SOURCE_BUDGET_EXCEEDED: 此格式没有有界大件读取器；请使用 GLB，点云使用定长 PLY；未尝试全场加载')
      scene=trimesh.load(source,force='scene')
      def ordinary_meshes():
        selected=set(req['sourceNodes']) if 'sourceNodes' in req else None
        for index,node in enumerate(scene.graph.nodes_geometry):
          if selected is not None and node not in selected:continue
          transform,name=scene.graph[node];mesh=scene.geometry[name].copy()
          if mesh.vertices.nbytes+getattr(mesh,'faces',mesh.vertices[:0]).nbytes>MAX_NODE_BYTES:
            raise ValueError('GEOMETRY_NODE_BUDGET_EXCEEDED: '+node)
          mesh.apply_transform(transform)
          yield index,node,mesh,{}
      source_meshes=ordinary_meshes()
    for index,node,mesh,metadata in source_meshes:
      if isinstance(mesh,trimesh.points.PointCloud):
        import numpy as np
        vertices=mesh.vertices
        def chunks():
          for start in range(0,len(vertices),POINT_CHUNK_SIZE):yield np.asarray(vertices[start:start+POINT_CHUNK_SIZE],dtype=np.float64)
        result=point_voxels(chunks,len(vertices),req,{'streamedXYZ':False,'format':source.suffix.lower()})
        geometry.append({'node':node,'kind':'point_cloud','watertight':False,'decomposition':result,**metadata});continue
      if not isinstance(mesh,trimesh.Trimesh): raise ValueError('UNSUPPORTED_GEOMETRY_KIND: '+type(mesh).__name__)
      mesh.merge_vertices(merge_tex=True,merge_norm=True)
      if req.get('sourceUpAxis','Y')=='Y': mesh.apply_transform(trimesh.transformations.rotation_matrix(1.5707963267948966,[1,0,0]))
      mesh.apply_scale(req.get('metersPerUnit',1.))
      if mesh.vertices.nbytes+mesh.faces.size*4>MAX_NODE_BYTES:raise ValueError('GEOMETRY_NODE_BUDGET_EXCEEDED: '+node)
      if not __import__('numpy').isfinite(mesh.vertices).all():raise ValueError('NONFINITE_GEOMETRY: '+node)
      geometry.append({'node':node,'kind':'mesh','watertight':bool(mesh.is_watertight),**metadata,
                       'position':write_array(mesh.vertices,'<f8',out/f'{geometry_prefix}-{index}.position.f64.bin',source,out),
                       'index':write_array(mesh.faces,'<u4',out/f'{geometry_prefix}-{index}.index.u32.bin',source,out)})
      if method=='convex_hull': meshes=[mesh.convex_hull]
      elif method=='coacd':
        import coacd
        parameters={'threshold':req.get('threshold',.05)}
        if 'real_metric' in inspect.signature(coacd.run_coacd).parameters:
          parameters['real_metric']=req.get('realMetric',False)
        elif req.get('realMetric',False):
          raise ValueError('COACD_REAL_METRIC_UNSUPPORTED: 当前CoACD不支持以米声明threshold；请使用兼容版本或归一化阈值。')
        meshes=[trimesh.Trimesh(vertices=v,faces=f,process=False) for v,f in coacd.run_coacd(coacd.Mesh(mesh.vertices,mesh.faces),**parameters)]
      else:meshes=[mesh]
      for sub,m in enumerate(meshes):
        path=out/f'part-{index}-{sub}.obj';write_obj(m,path,source,out);bounds=m.bounds
        parts.append({'path':str(path),'sourceNode':node,'vertices':int(len(m.vertices)),'faces':int(len(m.faces)),'volumeM3':float(m.volume),'watertight':bool(m.is_watertight),'bounds':bounds.tolist() if bounds is not None else None,**metadata})
      print('LYAPUNOV_PROGRESS='+json.dumps({'stage':'geometry-node','node':node,'completedNodes':len(geometry),'elapsedMs':round((time.perf_counter()-started)*1000)}),file=sys.stderr,flush=True)
    manifest={'schema':'lyapunov.geometry.v2','version':2,'sourcePath':str(source),'sourceFrame':source_frame,
              'limits':{'maxManifestBytes':MAX_MANIFEST_BYTES,'maxNodeBytes':MAX_NODE_BYTES,'maxReadBytes':MAX_READ_BYTES},'nodes':geometry}
    manifest_text=bounded_json(manifest)
    if not(points is not None and req.get('pointCloudTiling') is not None):geometry_path.write_text(manifest_text)
    result={'sourcePath':str(source),'method':method,'units':'m','upAxis':'Z','parts':parts,'geometryDataPath':str(geometry_path),'sourcePreserved':source.exists(),
            'geometryTransport':{'schema':manifest['schema'],'version':2,'manifestPath':str(geometry_path),'sourceFrame':source_frame,'limits':manifest['limits']},
            'diagnostics':{'completedNodes':len(geometry),'elapsedMs':round((time.perf_counter()-started)*1000),**({'sourceReads':reader.read_stats} if reader else {})}}
    result_text=bounded_json(result,'GEOMETRY_RESULT_BUDGET_EXCEEDED')
    if points is not None and req.get('pointCloudTiling') is not None:
      # 清单也属于同一个总磁盘额度。只在全域几何完成后发布，超限不写新成功清单。
      cap=req['pointCloudTiling'].get('maxDiskBytes',2*1024**3)
      for _ in range(3):
        manifest_text=bounded_json(manifest)
        result_text=bounded_json(result,'GEOMETRY_RESULT_BUDGET_EXCEEDED')
        current=sum(path.stat().st_size for path in out.iterdir()if path.is_file())
        previous=sum(path.stat().st_size for path in (geometry_path,bake_path)if path.exists())
        final_size=current-previous+len(manifest_text.encode('utf8'))+len(result_text.encode('utf8'))
        if final_size>cap:raise BakeGeometryError('POINT_CLOUD_SURFACE_DISK_BUDGET',{'stage':'full-tiled-manifest','diskBytes':current,'requiredDiskBytes':final_size,'maxDiskBytes':cap,'coverageComplete':False})
        for node in geometry:
          if node.get('pointCloud'):node['pointCloud']['outputDiskBytes']=final_size
          elif node.get('decomposition',{}).get('pointCloud'):node['decomposition']['pointCloud']['outputDiskBytes']=final_size
      geometry_path.write_text(manifest_text)
    bake_path.write_text(result_text);return result
if __name__=='__main__':
    if '--check' in sys.argv[1:]:
        facts=dependency_facts();print(json.dumps(facts));sys.exit(0 if facts['status']=='AVAILABLE' else 2)
    try:print(bounded_json(bake(json.load(sys.stdin)),'GEOMETRY_RESULT_BUDGET_EXCEEDED'))
    except ImportError as e:
        facts=e.facts if isinstance(e,BakeDependencyError) else {'provider':'asset-bake','python':sys.executable,'stage':'geometry-import','missing':[e.name] if e.name else [],'causeType':type(e).__name__}
        print(json.dumps({'error':'ASSET_BAKE_DEPENDENCY_UNAVAILABLE','message':str(e),'details':facts}));sys.exit(2)
    except Exception as e:print(json.dumps({'error':type(e).__name__,'message':str(e),**({'details':e.details} if isinstance(getattr(e,'details',None),dict) else {})}));sys.exit(1)
