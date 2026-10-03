"""显式全域点云空间分块：磁盘去重、固定整数晶格，不删除源点/空腔。"""
import json,sqlite3,time

class PointTiledError(ValueError):
    def __init__(self,message,details):self.details=details;super().__init__(message)

def merge_exact(boxes):
    for _ in range(32):
        before=len(boxes)
        for axis in range(3):
            other=[a for a in range(3) if a!=axis];buckets={}
            for lo,hi in boxes:buckets.setdefault(tuple(v for a in other for v in (lo[a],hi[a])),[]).append((lo,hi))
            merged=[]
            for bucket in buckets.values():
                bucket.sort(key=lambda b:b[0][axis]);current=None
                for lo,hi in bucket:
                    if current is not None and current[1][axis]==lo[axis]:current[1][axis]=hi[axis]
                    else:
                        if current is not None:merged.append(current)
                        current=(list(lo),list(hi))
                if current is not None:merged.append(current)
            boxes=merged
        if len(boxes)==before:return boxes
    raise PointTiledError('POINT_CLOUD_MERGE_WORK_BUDGET',{'stage':'full-tiled-merge','maxMergePasses':32})

def merge_disk(connection,disk_check):
    """外存临时盒描述，按另两轴四整数分组；流式只持有当前面贴链。"""
    count=connection.execute('SELECT count(*) FROM boxes').fetchone()[0]
    for _ in range(32):
        before=count
        for axis in range(3):
            other=[a for a in range(3)if a!=axis];columns=['x0','y0','z0','x1','y1','z1']
            order=[columns[a]for a in other]+[columns[a+3]for a in other]+[columns[axis]]
            connection.execute('DROP TABLE IF EXISTS next_boxes');connection.execute('CREATE TABLE next_boxes(x0 INTEGER,y0 INTEGER,z0 INTEGER,x1 INTEGER,y1 INTEGER,z1 INTEGER)')
            current=None;batch=[]
            def store(row):
                batch.append(tuple(row))
                if len(batch)>=4096:connection.executemany('INSERT INTO next_boxes VALUES(?,?,?,?,?,?)',batch);batch.clear()
            for raw in connection.execute('SELECT x0,y0,z0,x1,y1,z1 FROM boxes ORDER BY '+','.join(order)):
                row=list(raw)
                if current is not None and all(current[a]==row[a]and current[a+3]==row[a+3]for a in other)and current[axis+3]==row[axis]:current[axis+3]=row[axis+3]
                else:
                    if current is not None:store(current)
                    current=row
            if current is not None:store(current)
            if batch:connection.executemany('INSERT INTO next_boxes VALUES(?,?,?,?,?,?)',batch)
            connection.execute('DROP TABLE boxes');connection.execute('ALTER TABLE next_boxes RENAME TO boxes');connection.commit();disk_check()
            count=connection.execute('SELECT count(*) FROM boxes').fetchone()[0]
        if count==before:return count
    raise PointTiledError('POINT_CLOUD_MERGE_WORK_BUDGET',{'stage':'full-tiled-disk-merge','maxMergePasses':32,'boxes':count})

def point_voxels_tiled(chunks,count,req,source_info,axis,scale,out,check_output):
    import numpy as np,sys
    started=time.perf_counter();config=req['pointCloudTiling']
    if config.get('coverage')!='full' or 'voxelSizeM' not in req:raise ValueError('POINT_CLOUD_TILING_REQUIRES_EXPLICIT_FULL_PRECISION')
    pitch=req['voxelSizeM']
    if isinstance(pitch,bool) or not isinstance(pitch,(float,int)) or not np.isfinite(pitch) or pitch<=0:raise ValueError('INVALID_VOXEL_SIZE')
    def integer(obj,key,default,upper):
        value=obj.get(key,default)
        if isinstance(value,bool) or not isinstance(value,int) or value<1 or value>upper:raise ValueError('INVALID_POINT_CLOUD_TILING_BUDGET: '+key)
        return value
    edge=integer(config,'tileSizeCells',64,128);total_cap=integer(config,'maxTotalOccupiedVoxels',2000000,2000000)
    box_cap=integer(config,'maxTotalBoxes',10000,10000);tile_cap=integer(config,'maxTiles',16384,16384)
    disk_cap=integer(config,'maxDiskBytes',2*1024**3,2*1024**3)
    working=integer(req,'maxOccupiedVoxels',250000,1000000);node_boxes=integer(req,'maxBoxes',2048,10000)
    if edge**3>working:raise ValueError('POINT_CLOUD_TILE_WORKING_BUDGET: tileSizeCells³ 超出明确单tile占据预算')
    db=out/'point-cloud-full.sqlite';check_output(db)
    for suffix in ('-journal','-wal','-shm'):check_output(out/(db.name+suffix))
    connection=sqlite3.connect(db)
    connection.execute('PRAGMA cache_size=-65536');connection.execute('PRAGMA temp_store=FILE');connection.execute('PRAGMA journal_mode=OFF')
    connection.execute('CREATE TABLE IF NOT EXISTS cells(tx INTEGER,ty INTEGER,tz INTEGER,x INTEGER,y INTEGER,z INTEGER,PRIMARY KEY(tx,ty,tz,x,y,z)) WITHOUT ROWID')
    connection.execute('DELETE FROM cells');connection.commit();starting_changes=connection.total_changes
    lo=np.full(3,np.inf);hi=np.full(3,-np.inf);finite=processed=0;last_progress=0.;read_started=time.perf_counter()
    def fail(reason,details):raise PointTiledError(reason,{'coverage':'full','coverageComplete':False,'voxelSizeM':pitch,'sourcePoints':count,'processedSamples':processed,'finitePoints':finite,**details})
    try:
        def disk_check():
            size=sum(path.stat().st_size for path in out.iterdir()if path.is_file())
            if size>disk_cap:fail('POINT_CLOUD_DISK_BUDGET',{'stage':'full-tiled-disk','diskBytes':size,'maxDiskBytes':disk_cap})
        disk_check()
        print('LYAPUNOV_PROGRESS='+json.dumps({'stage':'full-tiled-read','processedSamples':0,'sourcePoints':count,'occupiedVoxels':0}),file=sys.stderr,flush=True)
        for points in chunks():
            processed+=len(points);points=points[np.isfinite(points).all(axis=1)]
            if axis=='Y':points=points[:,[0,2,1]];points[:,1]*=-1
            points=points*scale
            if not np.isfinite(points).all():fail('NONFINITE_POINT_CLOUD_TRANSFORM',{'stage':'full-tiled-read'})
            finite+=len(points)
            if len(points):lo=np.minimum(lo,points.min(axis=0));hi=np.maximum(hi,points.max(axis=0))
            if np.max(np.abs(points),initial=0)/pitch>2**52:fail('POINT_CLOUD_COORDINATE_RANGE',{'stage':'full-tiled-read'})
            cells=np.unique(np.floor(points/pitch).astype(np.int64),axis=0)
            connection.executemany('INSERT OR IGNORE INTO cells VALUES(?,?,?,?,?,?)',((int(x)//edge,int(y)//edge,int(z)//edge,int(x),int(y),int(z))for x,y,z in cells));connection.commit()
            total=connection.total_changes-starting_changes
            if total>total_cap:fail('POINT_CLOUD_TOTAL_OCCUPIED_BUDGET',{'stage':'full-tiled-read','requiredOccupiedVoxelsAtLeast':total,'maxTotalOccupiedVoxels':total_cap})
            disk_check()
            if time.perf_counter()-last_progress>=.5 or processed==count:
                last_progress=time.perf_counter()
                print('LYAPUNOV_PROGRESS='+json.dumps({'stage':'full-tiled-read','processedSamples':processed,'finitePoints':finite,'sourcePoints':count,'occupiedVoxels':total,**source_info}),file=sys.stderr,flush=True)
        if processed!=count or not finite:fail('EMPTY_OR_INCOMPLETE_POINT_CLOUD',{'stage':'full-tiled-read','declaredSourcePoints':count})
        total=connection.execute('SELECT count(*) FROM cells').fetchone()[0]
        tile_count=connection.execute('SELECT count(*)FROM(SELECT tx,ty,tz FROM cells GROUP BY tx,ty,tz)').fetchone()[0]
        if tile_count>tile_cap:fail('POINT_CLOUD_TILE_BUDGET',{'stage':'full-tiled-read','requiredTiles':tile_count,'maxTiles':tile_cap})
        tiles=connection.execute('SELECT tx,ty,tz,count(*) FROM cells GROUP BY tx,ty,tz ORDER BY tx,ty,tz').fetchall()
        if req.get('pointCloudStrategy',req.get('strategy'))=='triangle_mesh':
            from point_surface import export_surface
            info={**source_info,'sourceUpAxis':axis,'metersPerUnit':scale,'sourcePoints':count,'finitePoints':finite,'skippedNonfinitePoints':count-finite,
                  'explicitVoxelSize':True,'autoCoarseningSteps':0,'fullTiling':config,'sourceBoundsM':{'min':lo.tolist(),'max':hi.tolist()},'occupiedVoxels':total,'tiles':len(tiles),
                  'maxCellsPerTile':max(tile[3]for tile in tiles),'maxOccupiedVoxels':working,'chunkPoints':32768,'phaseMs':{'fullSourceRead':round((time.perf_counter()-read_started)*1000,3)},
                  'coverageNotice':'显式.1/所选米精度的采样体素边界，非原点云三角重建/未采样墙体，不自动切引擎；仅Isaac明确静态none适用'}
            return export_surface(connection,out,pitch,info,disk_cap,check_output)
        connection.execute('DROP TABLE IF EXISTS boxes');connection.execute('CREATE TABLE boxes(x0 INTEGER,y0 INTEGER,z0 INTEGER,x1 INTEGER,y1 INTEGER,z1 INTEGER)')
        max_tile=0;before_merge=0
        for index,(tx,ty,tz,cell_count) in enumerate(tiles):
            max_tile=max(max_tile,cell_count)
            if cell_count>working:fail('POINT_CLOUD_TILE_WORKING_BUDGET',{'stage':'full-tiled-cell','tile':[tx,ty,tz],'requiredOccupiedVoxels':cell_count,'maxOccupiedVoxels':working})
            remaining=set(connection.execute('SELECT x,y,z FROM cells WHERE tx=? AND ty=? AND tz=?',(tx,ty,tz)))
            tile_boxes=[]
            for x,y,z in sorted(remaining):
                if (x,y,z)not in remaining:continue
                x1=x+1
                while(x1,y,z)in remaining:x1+=1
                y1=y+1
                while all((xx,y1,z)in remaining for xx in range(x,x1)):y1+=1
                z1=z+1
                while all((xx,yy,z1)in remaining for yy in range(y,y1)for xx in range(x,x1)):z1+=1
                for zz in range(z,z1):
                    for yy in range(y,y1):
                        for xx in range(x,x1):remaining.remove((xx,yy,zz))
                tile_boxes.append(([x,y,z],[x1,y1,z1]))
                if len(tile_boxes)>node_boxes:fail('POINT_CLOUD_TILE_BOX_BUDGET',{'stage':'full-tiled-merge','tile':[tx,ty,tz],'requiredBoxesAtLeast':len(tile_boxes),'maxBoxes':node_boxes})
            before_merge+=len(tile_boxes)
            tile_boxes=merge_exact(tile_boxes)
            connection.executemany('INSERT INTO boxes VALUES(?,?,?,?,?,?)',((*lo,*hi)for lo,hi in tile_boxes));connection.commit();disk_check()
            if index%32==0:print('LYAPUNOV_PROGRESS='+json.dumps({'stage':'full-tiled-merge','tilesProcessed':index+1,'totalTiles':len(tiles),'temporaryBoxes':before_merge,'occupiedVoxels':total}),file=sys.stderr,flush=True)
        final_count=merge_disk(connection,disk_check)
        if final_count>box_cap:fail('POINT_CLOUD_TOTAL_BOX_BUDGET',{'stage':'full-tiled-complete','requiredTotalBoxes':final_count,'maxTotalBoxes':box_cap,'occupiedVoxels':total,'totalTiles':len(tiles),'diskBytes':db.stat().st_size})
        boxes=[(list(row[:3]),list(row[3:]))for row in connection.execute('SELECT x0,y0,z0,x1,y1,z1 FROM boxes')]
        # 源表与box并集同晶格：精确greedy删除只来自源，face-adjacent合并不新增cell；体积和必须相等。
        covered=sum((hi[0]-lo[0])*(hi[1]-lo[1])*(hi[2]-lo[2])for lo,hi in boxes)
        if covered!=total:fail('POINT_CLOUD_OCCUPANCY_MISMATCH',{'stage':'full-tiled-verify','boxCells':covered,'sourceCells':total})
        floats=[{'center':[(a+b)*pitch/2 for a,b in zip(lo,hi)],'halfExtents':[(b-a)*pitch/2 for a,b in zip(lo,hi)]}for lo,hi in boxes]
        return{'boxes':floats,'voxelSizeM':float(pitch),'gridDims':np.maximum(1,np.ceil((hi-lo)/pitch)).astype(int).tolist(),'fillInterior':False,'tiles':len(tiles),
            'pointCloud':{**source_info,'sourceUpAxis':axis,'metersPerUnit':scale,'sourcePoints':count,'finitePoints':finite,'skippedNonfinitePoints':count-finite,'occupiedVoxels':total,'initialOccupiedVoxels':total,
             'maxOccupiedVoxels':working,'maxBoxes':node_boxes,'explicitVoxelSize':True,'autoCoarseningSteps':0,'processing':'full-spatial-tiles','coverage':'full-measured-sample-voxels',
             'coverageComplete':True,'maxCellsPerTile':max_tile,'boxesBeforeMerge':before_merge,'boxesAfterMerge':len(boxes),'maxWorkingBoxes':40000,'diskBytes':db.stat().st_size,
             'sourceBoundsM':{'min':lo.tolist(),'max':hi.tolist()},'fullTiling':config,'occupiedUnionVerified':True,'elapsedMs':round((time.perf_counter()-started)*1000,3),
             'coverageNotice':'全源所有有限XYZ采样的同.1/显式晶格占据，不重建未采样墙体/封闭体积；不能代替实际接触与通道精度验收'}}
    finally:connection.close()
