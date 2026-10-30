"""以OpenUSD解析完整依赖与默认时刻几何；只读原件，不执行外部服务。"""
import json, os, sys
try:
    from pxr import Ar, Gf, Sdf, Usd, UsdGeom, UsdPhysics, UsdUtils, UsdShade
    from usd_materials import material_fact, extract_textures, standard_library_context
except ImportError:
    raise RuntimeError('USD_RUNTIME_UNAVAILABLE: 请准备usd-core并设置LYAPUNOV_USD_PYTHON')


def physical_path(path):
    # USDZ内部成员由其容器携带，原件只复制容器。
    return Ar.SplitPackageRelativePathOuter(path)[0] if Ar.IsPackageRelativePath(path) else path


def _inspect(path, overrides, standard_libraries=()):
    path = os.path.realpath(path)
    layers, assets, unresolved = UsdUtils.ComputeAllDependencies(Sdf.AssetPath(path))
    if unresolved:
        raise RuntimeError('USD_DEPENDENCY_MISSING: ' + json.dumps(sorted(unresolved)))
    files = sorted(set(os.path.realpath(physical_path(x.realPath)) for x in layers if x.realPath) | set(os.path.realpath(physical_path(x)) for x in assets))
    if path not in files: files.insert(0, path)
    for file in files:
        if not os.path.isfile(file): raise RuntimeError('USD_DEPENDENCY_MISSING: ' + file)
    # 匿名session layer承载变体；绝不编辑原件layer。
    root = Sdf.Layer.FindOrOpen(path)
    stage = Usd.Stage.Open(root, Sdf.Layer.CreateAnonymous(), Ar.GetResolver().GetCurrentContext(), load=Usd.Stage.LoadAll)
    if not stage: raise RuntimeError('USD_STAGE_INVALID: ' + path)
    stage.SetEditTarget(stage.GetSessionLayer())
    for prim_path, sets in (overrides.get('variants') or {}).items():
        prim = stage.GetPrimAtPath(prim_path)
        if not prim: raise RuntimeError('USD_PRIM_MISSING: ' + prim_path)
        for name, value in sets.items():
            variants = prim.GetVariantSet(name)
            if value not in variants.GetVariantNames(): raise RuntimeError('USD_VARIANT_INVALID: ' + prim_path + ':' + name + '=' + value)
            if not variants.SetVariantSelection(value): raise RuntimeError('USD_VARIANT_INVALID: ' + name)
    default = stage.GetDefaultPrim()
    selected = overrides.get('primPath') or (str(default.GetPath()) if default else None)
    if selected and not stage.GetPrimAtPath(selected): raise RuntimeError('USD_PRIM_MISSING: ' + selected)
    prims = list(Usd.PrimRange(stage.GetPrimAtPath(selected), Usd.TraverseInstanceProxies())) if selected else list(stage.Traverse(Usd.TraverseInstanceProxies()))
    facts = {'format': os.path.splitext(path)[1][1:].lower(), 'parserVersion': '.'.join(map(str, Usd.GetVersion())),
             'metersPerUnit': UsdGeom.GetStageMetersPerUnit(stage), 'upAxis': str(UsdGeom.GetStageUpAxis(stage)),
             'layers': [x.identifier for x in layers], 'variants': [],
             'physics': {'rigidBodies': [], 'collisions': [], 'joints': [], 'articulations': []}}
    def jsonable(value):
        if isinstance(value,dict): return {str(key):jsonable(item) for key,item in value.items()}
        if isinstance(value,(str,int,float,bool)) or value is None:return value
        try:return [jsonable(item) for item in value]
        except TypeError:return str(value)
    simready = root.customLayerData.get('SimReady_Metadata')
    if isinstance(simready,dict):facts['simreadyMetadata']=jsonable(simready)
    default = stage.GetDefaultPrim()
    if default: facts['defaultPrim'] = str(default.GetPath())
    shapes, unsupported, total = [], set(), 0
    textures, material_warnings = {}, set()
    cache = UsdGeom.XformCache(Usd.TimeCode.Default())
    parent_inverse = cache.GetLocalToWorldTransform(stage.GetPrimAtPath(selected).GetParent()).GetInverse() if selected and stage.GetPrimAtPath(selected).GetParent() else Gf.Matrix4d(1)
    for prim in prims:
        name = str(prim.GetPath())
        for kind, schema in [('rigidBodies', UsdPhysics.RigidBodyAPI), ('collisions', UsdPhysics.CollisionAPI), ('articulations', UsdPhysics.ArticulationRootAPI)]:
            if prim.HasAPI(schema): facts['physics'][kind].append(name)
        if prim.IsA(UsdPhysics.Joint): facts['physics']['joints'].append(name)
        for name_set in prim.GetVariantSets().GetNames():
            variant = prim.GetVariantSet(name_set)
            facts['variants'].append({'primPath': name, 'set': name_set, 'names': variant.GetVariantNames(), 'selection': variant.GetVariantSelection()})
        image = UsdGeom.Imageable(prim)
        if image and (image.ComputeVisibility() == 'invisible' or image.ComputePurpose() in ('guide', 'proxy')): continue
        kind = prim.GetTypeName()
        if kind not in ('Mesh', 'Cube', 'Sphere', 'Cylinder', 'Cone', 'Capsule'):
            if prim.IsA(UsdGeom.Gprim): unsupported.add(kind)
            continue
        gprim = UsdGeom.Gprim(prim)
        color = gprim.GetDisplayColorAttr().Get()
        matrix = cache.GetLocalToWorldTransform(prim) * parent_inverse
        shape = {'primPath': name, 'kind': kind, 'matrix': [float(matrix[i][j]) for i in range(4) for j in range(4)], 'color': [float(v) for v in color[0]] if color else [.55, .65, .75]}
        material=material_fact(prim,textures,material_warnings,standard_libraries)
        if material:shape['material']=material
        body = prim
        while body and not body.IsPseudoRoot():
            if body.HasAPI(UsdPhysics.RigidBodyAPI):
                body_matrix = cache.GetLocalToWorldTransform(body)
                relative = cache.GetLocalToWorldTransform(prim) * body_matrix.GetInverse()
                shape['bodyPrimPath'] = str(body.GetPath())
                shape['bodyFromShape'] = [float(relative[i][j]) for i in range(4) for j in range(4)]
                break
            body = body.GetParent()
        if kind == 'Mesh':
            mesh = UsdGeom.Mesh(prim)
            points = mesh.GetPointsAttr().Get() or []
            counts = mesh.GetFaceVertexCountsAttr().Get() or []
            indices = mesh.GetFaceVertexIndicesAttr().Get() or []
            total += len(points)
            if total > 250000: unsupported.add('USD_PREVIEW_VERTEX_BUDGET'); continue
            uv=UsdGeom.PrimvarsAPI(prim).GetPrimvar('st')
            if uv and uv.HasValue():
                shape['uvs']=[[float(v) for v in point] for point in uv.ComputeFlattened()]
                shape['uvInterpolation']=str(uv.GetInterpolation())
            normal_primvar=UsdGeom.PrimvarsAPI(prim).GetPrimvar('normals')
            normals=normal_primvar.ComputeFlattened() if normal_primvar and normal_primvar.HasValue() else mesh.GetNormalsAttr().Get()
            if normals:
                shape['normals']=[[float(v)for v in normal]for normal in normals]
                shape['normalInterpolation']=str(normal_primvar.GetInterpolation() if normal_primvar and normal_primvar.HasValue() else mesh.GetNormalsInterpolation())
            shape['orientation']=str(mesh.GetOrientationAttr().Get())
            if material and any(key.endswith('Texture') for key in material) and not shape.get('uvs'):
                material_warnings.add('USD_TEXTURE_UV_MISSING: '+name)
                for key in list(material):
                    if key.endswith('Texture'):del material[key]
            shape.update(points=[[float(v) for v in p] for p in points], counts=list(counts), indices=list(indices))
        elif kind == 'Cube': shape['size'] = float(UsdGeom.Cube(prim).GetSizeAttr().Get())
        elif kind == 'Sphere': shape['radius'] = float(UsdGeom.Sphere(prim).GetRadiusAttr().Get())
        else:
            schema = getattr(UsdGeom, kind)(prim)
            shape.update(radius=float(schema.GetRadiusAttr().Get()), height=float(schema.GetHeightAttr().Get()), axis=str(schema.GetAxisAttr().Get()))
        if kind!='Mesh' and material and any(key.endswith('Texture') for key in material):
            material_warnings.add('USD_TEXTURE_PRIMITIVE_UV_UNSUPPORTED: '+name+'；不以Three默认UV冒充源st')
            for key in list(material):
                if key.endswith('Texture'):del material[key]
        shapes.append(shape)
    losses = ['默认时刻派生几何；刚体运行由原生Frame驱动，不播放USD动画/蒙皮/细分曲面', '材质支持UsdPreviewSurface及已核验固定OmniPBR常量/贴图子集派生；不执行MDL或任意shader网络']+sorted(material_warnings)
    if unsupported: losses.append('未显示的类型/预算: ' + ', '.join(sorted(unsupported)))
    facts['preview'] = {'source': 'openusd-default-time', 'status': 'AVAILABLE' if shapes else 'UNAVAILABLE', 'shapes': shapes, 'textures':list(textures.values()), 'losses': losses}
    if not shapes: facts['preview']['reason'] = 'USD_PREVIEW_NO_SUPPORTED_GEOMETRY'
    bounds = UsdGeom.BBoxCache(Usd.TimeCode.Default(), ['default', 'render']).ComputeWorldBound(stage.GetPrimAtPath(selected) if selected else stage.GetPseudoRoot()).ComputeAlignedRange()
    aabb = None if bounds.IsEmpty() else {'min': list(bounds.GetMin()), 'max': list(bounds.GetMax())}
    # 绝对引用不改原件；复制后必须通过便携闭包检查，不能伪称可搬迁。
    absolute = []
    for layer in layers:
        def visit(raw):
            if os.path.isabs(raw) or ':' in raw.split('/')[0]: absolute.append({'layer': layer.identifier, 'assetPath': raw})
            return raw
        UsdUtils.ModifyAssetPaths(layer, visit)
    return {'files': files, 'usd': facts, 'aabb': aabb, 'absoluteAssetPaths': absolute}


def inspect(path,overrides):
    context,files,libraries=standard_library_context(path)
    with Ar.ResolverContextBinder(context):result=_inspect(path,overrides,libraries)
    if libraries:
        result['files']=sorted(set(result['files']+files));result['usd']['standardLibraries']=libraries
    return result


def mdl_declarations(path):
    stage=Usd.Stage.Open(path)
    if not stage:raise RuntimeError('USD_STAGE_INVALID: '+path)
    declarations=[]
    for prim in stage.Traverse(Usd.TraverseInstanceProxies()):
        if not prim.IsA(UsdShade.Shader):continue
        shader=UsdShade.Shader(prim);asset=shader.GetSourceAsset('mdl');symbol=shader.GetSourceAssetSubIdentifier('mdl')
        if asset and symbol:declarations.append({'assetIdentifier':asset.path,'subIdentifier':str(symbol),'parameters':[{'name':str(value.GetBaseName()),'typeName':str(value.GetTypeName())}for value in shader.GetInputs()]})
    return {'declarations':declarations}


def repath(mapping):
    changed = []
    for source, target in mapping.items():
        if not source.lower().endswith(('.usd','.usda','.usdc')) or source == target: continue
        old = Sdf.Layer.FindOrOpen(source)
        layer = Sdf.Layer.FindOrOpen(target)
        if not old or not layer: raise RuntimeError('USD_LAYER_INVALID: '+target)
        edits = []
        def replace(raw):
            # 相对布局已完整镜像，不重写；只有绝对/解析器定位符需要移动。
            if not os.path.isabs(raw): return raw
            original = os.path.normpath(physical_path(Sdf.ComputeAssetPathRelativeToLayer(old, raw)))
            if original not in mapping: raise RuntimeError('USD_REPATH_DEPENDENCY_MISSING: '+original)
            result = os.path.relpath(mapping[original],os.path.dirname(target))
            edits.append((raw,result))
            return result
        UsdUtils.ModifyAssetPaths(layer, replace)
        if edits: layer.Save();changed.append(target)
    return {'changed':changed}

def layer_dependencies(path):
    # 逐layer只读发现组合/asset引用；尚未下载依赖时不打开组合stage。
    if path.lower().endswith('.usdz'):return {'references':[]}
    layer=Sdf.Layer.FindOrOpen(path)
    if not layer:raise RuntimeError('USD_LAYER_INVALID: '+path)
    sublayers,references,payloads=UsdUtils.ExtractExternalReferences(path)
    return {'references':sorted(set(str(item) for item in [*sublayers,*references,*payloads] if item))}

if __name__ == '__main__':
    try:
        result = mdl_declarations(sys.argv[2]) if sys.argv[1]=='--mdl-declarations' else layer_dependencies(sys.argv[2]) if sys.argv[1]=='--layer-dependencies' else extract_textures(json.loads(sys.argv[2])) if sys.argv[1]=='--extract-textures' else repath(json.loads(sys.argv[2])) if sys.argv[1]=='--repath' else inspect(sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv) > 2 else {})
        print(json.dumps(result, allow_nan=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
