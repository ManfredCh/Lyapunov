"""USD源prim身份的当前刚体读回；复用World现有tensor/USD/Fabric矩阵路径。"""

def usd_body_world_poses(world, entry):
    metadata=entry.get('metadata') or {}
    source_root=metadata.get('nativeReferencedPrim')
    if not metadata.get('nativeUsd') or not source_root: return {}
    runtime_root=entry['path']+'/source'
    paths=entry.get('rigidPaths') or []
    if len(paths)>2048: raise RuntimeError('USD_BODY_POSE_BUDGET: '+str(len(paths)))
    result={}
    for path in paths:
        if path!=runtime_root and not path.startswith(runtime_root+'/'): continue
        source=source_root+path[len(runtime_root):]
        prim=world.stage.GetPrimAtPath(path)
        matrix=world._native_world_matrix(prim)
        result[source]={'sourcePrimPath':source,'runtimePrimPath':path,'worldMatrixM':[float(matrix[i][j]) for i in range(4) for j in range(4)]}
    return result
