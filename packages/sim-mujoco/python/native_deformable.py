"""原生 MJCF flex/cable 的装配补口与同帧读回；不拥有第二份求解状态。"""
import copy
import math

import mujoco as mj


# MjsFlex 的声明字段（MuJoCo 3.13）；完整保留材料、接触、单元与节点引用。
FLEX_FIELDS = (
    'name', 'contype', 'conaffinity', 'condim', 'priority', 'friction', 'solmix',
    'solref', 'solimp', 'margin', 'gap', 'dim', 'radius', 'size', 'internal',
    'flatskin', 'selfcollide', 'passive', 'activelayers', 'group', 'edgestiffness',
    'edgedamping', 'rgba', 'material', 'young', 'poisson', 'damping', 'thickness',
    'elastic2d', 'cellcount', 'order', 'nodebody', 'vertbody', 'node', 'vert',
    'elem', 'texcoord', 'elemtexcoord', 'info',
)
FLEX_VECTOR_FIELDS = {'friction', 'solref', 'solimp', 'size', 'rgba', 'cellcount',
                      'nodebody', 'vertbody', 'node', 'vert', 'elem', 'texcoord', 'elemtexcoord'}


def flex_declarations(spec):
    result = []
    for flex in spec.flexes:
        fields = {}
        for key in FLEX_FIELDS:
            value = getattr(flex, key)
            fields[key] = list(value) if key in FLEX_VECTOR_FIELDS else value
        result.append(fields)
    return result


def restore_attached_flexes(parent, declarations, prefix, world_body_name):
    """3.13 attach 不复制 flex；仅补缺失原声明，并把源 world pin 绑定到实体安装根。

    attach 仍负责 body、插件、资产及其他命名空间。原件不改写，局部节点坐标不烘焙；
    静态 world_body_name 承载 Scene 的完整刚性位姿，所以 pin 与可动顶点同一坐标口径。
    """
    existing = {flex.name for flex in parent.flexes}
    for declaration in declarations:
        name = prefix + declaration['name']
        if name in existing:
            continue
        fields = copy.deepcopy(declaration)
        fields['name'] = name
        for key in ('vertbody', 'nodebody'):
            fields[key] = [world_body_name if body == 'world' else prefix + body for body in fields[key]]
        if fields['material']:
            fields['material'] = prefix + fields['material']
        parent.add_flex(**fields)


def flex_material(flex):
    return {'youngPa': float(flex.young), 'poisson': float(flex.poisson),
            'rayleighDamping': float(flex.damping)}


def cable_plugins(spec):
    # 隐式 composite 实例的 spec.plugins[].plugin_name 为空；身份在真实 body.plugin 上。
    names = {body.plugin.name for body in spec.bodies
             if body.plugin.active and body.plugin.plugin_name == 'mujoco.elasticity.cable'}
    return {plugin.name: plugin for plugin in spec.plugins if plugin.name in names}


def override_number(value, label, error, lower, upper=None, exclusive_lower=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise error('INVALID_ARGUMENT', label + ' 必须是有限数值 / must be finite')
    if value < lower or (exclusive_lower and value == lower) or (upper is not None and value >= upper):
        raise error('INVALID_ARGUMENT', label + ' 超出原生材料范围 / outside native material range')
    return float(value)


def apply_material_overrides(spec, cfg, error):
    """覆盖只作用于解析出的原生声明，随后由真实 child/parent compile 消费。"""
    result = {'flex': [], 'cable': []}
    flexes = {flex.name: flex for flex in spec.flexes}
    cables = cable_plugins(spec)
    for key, entries in (('flexMaterials', flexes), ('cableMaterials', cables)):
        overrides = cfg.get(key, {})
        if not isinstance(overrides, dict):
            raise error('INVALID_ARGUMENT', key + ' 必须按原生名称索引 / must be keyed by native name')
        for name in overrides:
            if name not in entries:
                raise error('INVALID_ARGUMENT', key + ' 指向不存在的原生声明 / unknown native declaration: ' + str(name))
            if not isinstance(overrides[name], dict):
                raise error('INVALID_ARGUMENT', key + '.' + name + ' 必须是参数对象 / must be an object')
    for name, flex in flexes.items():
        source = flex_material(flex)
        overrides = cfg.get('flexMaterials', {}).get(name, {})
        unknown = set(overrides) - {'youngPa', 'poisson', 'rayleighDamping'}
        if unknown:
            raise error('INVALID_ARGUMENT', '未知 flex 材料参数 / unknown flex material field: ' + ', '.join(sorted(unknown)))
        if 'youngPa' in overrides:
            flex.young = override_number(overrides['youngPa'], name + '.youngPa', error, 0, exclusive_lower=True)
        if 'poisson' in overrides:
            flex.poisson = override_number(overrides['poisson'], name + '.poisson', error, 0, .5)
        if 'rayleighDamping' in overrides:
            flex.damping = override_number(overrides['rayleighDamping'], name + '.rayleighDamping', error, 0)
        result['flex'].append({'nativeName': name, 'model': 'mujoco.flex', 'dimension': int(flex.dim),
                               **flex_material(flex), 'source': source})
    for name, plugin in cables.items():
        config = dict(plugin.config)
        source = {'bendPa': float(config['bend']), 'twistPa': float(config['twist'])}
        overrides = cfg.get('cableMaterials', {}).get(name, {})
        unknown = set(overrides) - {'bendPa', 'twistPa'}
        if unknown:
            raise error('INVALID_ARGUMENT', '未知 cable 材料参数 / unknown cable material field: ' + ', '.join(sorted(unknown)))
        for field, key in (('bendPa', 'bend'), ('twistPa', 'twist')):
            if field in overrides:
                config[key] = str(override_number(overrides[field], name + '.' + field, error, 0, exclusive_lower=True))
        plugin.config = config
        result['cable'].append({'nativeName': name, 'model': 'mujoco.elasticity.cable',
                                'bendPa': float(config['bend']), 'twistPa': float(config['twist']),
                                'inextensible': True, 'source': source, 'pluginConfig': config})
    return result


def bind_geometry(model, info):
    prefix = info['prefix']
    flexes = []
    for material in info.get('nativePhysics', {}).get('flex', []):
        name = prefix + material['nativeName']
        fid = mj.mj_name2id(model, mj.mjtObj.mjOBJ_FLEX, name)
        if fid < 0:
            continue
        dim = int(model.flex_dim[fid])
        if dim == 3:
            adr, count = int(model.flex_shelldataadr[fid]), int(model.flex_shellnum[fid])
            indices = model.flex_shell[adr:adr + count * 3].tolist()
        else:
            adr, count = int(model.flex_elemdataadr[fid]), int(model.flex_elemnum[fid])
            indices = model.flex_elem[adr:adr + count * (dim + 1)].tolist()
        flexes.append({'nativeName': name[len(prefix):], 'kind': 'lines' if dim == 1 else 'mesh',
                      'indices': indices, 'radiusM': float(model.flex_radius[fid]),
                      'id': fid, 'adr': int(model.flex_vertadr[fid]), 'count': int(model.flex_vertnum[fid])})
    cables = []
    for material in info.get('nativePhysics', {}).get('cable', []):
        full_name = prefix + material['nativeName']
        pid = mj.mj_name2id(model, mj.mjtObj.mjOBJ_PLUGIN, full_name)
        body_names = [model.body(bid).name[len(prefix):] for bid in range(1, model.nbody)
                      if pid >= 0 and int(model.body_plugin[bid]) == pid
                      and model.body(bid).name.startswith(prefix)]
        geom_ids = [gid for gid in range(model.ngeom) if pid >= 0
                    and int(model.body_plugin[int(model.geom_bodyid[gid])]) == pid
                    and int(model.geom_type[gid]) == int(mj.mjtGeom.mjGEOM_CAPSULE)]
        if geom_ids:
            cables.append({'nativeName': material['nativeName'], 'geomIds': geom_ids, 'nativeBodyNames': body_names})
    if info.get('nativePhysics', {}).get('integrator') is not None:
        info['nativePhysics']['integrator']['effective'] = mj.mjtIntegrator(int(model.opt.integrator)).name
    info['flexGeometry'], info['cableGeometry'] = flexes, cables


def observe_geometry(model, data, info):
    result = []
    for flex in info.get('flexGeometry', []):
        item = {'nativeName': flex['nativeName'], 'kind': flex['kind'],
                'positionsM': data.flexvert_xpos[flex['adr']:flex['adr'] + flex['count']].reshape(-1).tolist(),
                'indices': list(flex['indices'])}
        if item['kind'] == 'lines':
            item['radiusM'] = flex['radiusM']
        result.append(item)
    for cable in info.get('cableGeometry', []):
        points, indices = [], []
        for gid in cable['geomIds']:
            center = data.geom_xpos[gid]
            # 原生 capsule 的纵轴是局部 z；半长与位姿均来自实际模型/当前求解状态。
            half = data.geom_xmat[gid].reshape(3, 3)[:, 2] * float(model.geom_size[gid, 1])
            start = len(points) // 3
            points.extend((center - half).tolist())
            points.extend((center + half).tolist())
            indices.extend([start, start + 1])
        result.append({'nativeName': cable['nativeName'], 'kind': 'lines', 'positionsM': points,
                       'indices': indices, 'radiusM': float(model.geom_size[cable['geomIds'][0], 0]),
                       'nativeBodyNames': list(cable['nativeBodyNames'])})
    return result
