"""常见USD PreviewSurface的只读派生；非支持网络明确记录，不改源shader。"""
import hashlib, json, math, os, struct
from pxr import Ar, UsdShade

IMAGE_MIME={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}


def standard_library_context(path):
    """仅源包显式声明的独立标准资源；局部Ar上下文，不设置全局搜索路径。"""
    path=os.path.realpath(path);directory=os.path.dirname(path);roots=[];files=[];identities=[]
    for _ in range(32):
        source_file=os.path.join(directory,'lyapunov-source.json')
        if os.path.isfile(source_file):
            with open(source_file,encoding='utf8')as file:source=json.load(file)
            if source.get('schema')=='lyapunov.simready-source.v1' and os.path.realpath(os.path.join(directory,source.get('rootUsd','')))==path:
                for dependency in source.get('standardLibraries',[]):
                    manifest_path=os.path.realpath(os.path.join(directory,dependency['manifestPath']))
                    if os.path.getsize(manifest_path)>2*1024*1024:raise RuntimeError('USD_STANDARD_LIBRARY_BUDGET')
                    with open(manifest_path,'rb')as file:raw=file.read()
                    if hashlib.sha256(raw).hexdigest()!=dependency['manifestSha256']:raise RuntimeError('USD_STANDARD_LIBRARY_HASH_MISMATCH: manifest')
                    manifest=json.loads(raw);base=os.path.dirname(manifest_path)
                    if manifest.get('schema')!='lyapunov.usd-standard-library.v1' or manifest.get('license',{}).get('id')!='BSD-3-Clause' or len(manifest.get('files',[]))>128:raise RuntimeError('USD_STANDARD_LIBRARY_MANIFEST_INVALID')
                    total=len(raw)
                    for entry in manifest['files']:
                        relative=entry['path']
                        if os.path.isabs(relative)or'..'in relative.split('/')or'\\'in relative or':'in relative:raise RuntimeError('USD_STANDARD_LIBRARY_PATH_INVALID')
                        target=os.path.join(base,relative)
                        total+=entry['size']
                        if entry['size']<1 or total>8*1024*1024 or os.path.getsize(target)!=entry['size']:raise RuntimeError('USD_STANDARD_LIBRARY_BUDGET')
                        with open(target,'rb')as file:data=file.read()
                        if len(data)!=entry['size']or hashlib.sha256(data).hexdigest()!=entry['sha256']:raise RuntimeError('USD_STANDARD_LIBRARY_HASH_MISMATCH: '+relative)
                        files.append(os.path.realpath(target))
                    for relative in manifest['resolverRoots']:
                        if os.path.isabs(relative)or'..'in relative.split('/')or'\\'in relative or':'in relative:raise RuntimeError('USD_STANDARD_LIBRARY_PATH_INVALID')
                        roots.append(os.path.realpath(os.path.join(base,relative)))
                    files.append(manifest_path);identities.append({**dependency,'manifestPath':manifest_path})
                break
        parent=os.path.dirname(directory)
        if parent==directory:break
        directory=parent
    return Ar.DefaultResolverContext(roots),sorted(set(files)),identities


def texture_bytes(path):
    asset=Ar.GetResolver().OpenAsset(Ar.ResolvedPath(path))
    if not asset:raise RuntimeError('USD_TEXTURE_UNAVAILABLE: '+path)
    if asset.GetSize()>32*1024*1024:raise RuntimeError('USD_TEXTURE_PREVIEW_BUDGET: '+path)
    return asset.GetBuffer()


def image_metadata(raw,mime):
    metadata={};bits=8;channels=3
    if mime=='image/png' and raw.startswith(b'\x89PNG\r\n\x1a\n'):
        bits=raw[24];channels={0:1,2:3,3:3,4:2,6:4}.get(raw[25],0)
        offset=8
        while offset+12<=len(raw):
            size=struct.unpack('>I',raw[offset:offset+4])[0];kind=raw[offset+4:offset+8];data=raw[offset+8:offset+8+size];offset+=12+size
            if kind==b'tEXt' and b'\0' in data:
                key,value=data.split(b'\0',1);metadata[key.decode('latin1')]=value.decode('latin1')
            if kind==b'sRGB':metadata['sRGB']=True
            if kind==b'gAMA' and len(data)==4 and struct.unpack('>I',data)[0]==100000:metadata['linear']=True
    elif mime=='image/jpeg':
        offset=2
        while offset+4<=len(raw):
            if raw[offset]!=255:offset+=1;continue
            marker=raw[offset+1];offset+=2
            if marker in (0xd8,0xd9) or 0xd0<=marker<=0xd7:continue
            size=int.from_bytes(raw[offset:offset+2],'big')
            if marker in (0xc0,0xc1,0xc2) and offset+8<len(raw):bits=raw[offset+2];channels=raw[offset+7];break
            if size<2:break
            offset+=size
    return metadata, ('sRGB' if metadata.get('sRGB') else 'raw' if metadata.get('linear') else 'sRGB' if bits==8 and channels in (3,4) else 'raw')


def input_value(shader,name,default):
    value=shader.GetInput(name).Get() if shader.GetInput(name) else None
    return default if value is None else value


def connected(shader,name):
    value=shader.GetInput(name)
    return value.GetConnectedSource() if value and value.HasConnectedSource() else None


def uv_transform(connection,warnings,seen=()):
    if not connection:return None
    source,output,_=connection;shader=UsdShade.Shader(source.GetPrim());path=str(source.GetPath())
    if not shader or str(output)!='result' or path in seen or len(seen)>=16:
        warnings.add('USD_TEXTURE_UV_NETWORK_UNSUPPORTED: '+path);return None
    kind=str(shader.GetIdAttr().Get())
    if kind=='UsdPrimvarReader_float2':
        varname=input_value(shader,'varname','');interface=connected(shader,'varname')
        if interface:
            source_input=interface[0].GetInput(interface[1]);varname=source_input.Get() if source_input else ''
        if str(varname)!='st':warnings.add('USD_TEXTURE_PRIMVAR_UNSUPPORTED: '+str(varname));return None
        return [1.,0.,0.,0.,1.,0.,0.,0.,1.]
    if kind!='UsdTransform2d':warnings.add('USD_TEXTURE_UV_NETWORK_UNSUPPORTED: '+path);return None
    for parameter in ('scale','rotation','translation'):
        if connected(shader,parameter):
            warnings.add('USD_TEXTURE_UV_PARAMETER_CONNECTION_UNSUPPORTED: '+path+':'+parameter);return None
    # Transform2d规定先scale、再逆时针角度rotation、最后translation；外层矩阵左乘内层。
    values=[*input_value(shader,'scale',(1.,1.)),float(input_value(shader,'rotation',0.)),*input_value(shader,'translation',(0.,0.))]
    if len(values)!=5 or not all(math.isfinite(float(v))for v in values):
        warnings.add('USD_TEXTURE_UV_TRANSFORM_INVALID: '+path);return None
    sx,sy,angle,tx,ty=map(float,values);c=math.cos(math.radians(angle));s=math.sin(math.radians(angle))
    outer=[sx*c,sx*s,0.,-sy*s,sy*c,0.,tx,ty,1.]
    inner=uv_transform(connected(shader,'in'),warnings,seen+(path,))
    if inner is None:return None
    return [sum(outer[k*3+r]*inner[col*3+k]for k in range(3))for col in range(3)for r in range(3)]


OMNIPBR_MODULES={
 'Base/OmniPBR.mdl':'d384fc800f120e3cad1b7ca8837f9c554f9c34343d194813fca27caa493001f2',
 'Base/OmniPBR_ClearCoat.mdl':'687fce3f0693146b91495f04407a7c38c78f6b9262b63621f44b4b1f09110469',
 'Base/OmniPBRBase.mdl':'701f37299b44106842bdbe025de52eedec391e35b038f61c4ed4d25bd98e7db1',
 'mdl/nvidia/core_definitions.mdl':'052aec260e8dfef5d671545fc2fc28c0c478a5b043041c65a833b2a6d81bf950',
 'mdl/nvidia/support_definitions.mdl':'bb372f21b6e81d293b99fea6819a8309e2c33c732c7151752b4b33dade177f2e',
 'mdl/nvidia/aux_definitions.mdl':'ebb81c8977aeb30790399ec7aaa7f2f76cb23afb434f56201ef152aba45a6e81'}

def omnipbr_fact(shader,material,textures,warnings,libraries):
    """只派生已核验模块的常见PBR输入；不编译MDL，不按同名shader猜语义。"""
    asset=shader.GetSourceAsset('mdl');symbol=shader.GetSourceAssetSubIdentifier('mdl');name=str(material.GetPath());identity=None
    if not asset or str(symbol)!='OmniPBR':return None
    for dependency in libraries:
        with open(dependency['manifestPath'],encoding='utf8')as file:manifest=json.load(file)
        hashes={row['path']:row['sha256']for row in manifest['files']}
        expected=os.path.realpath(os.path.join(os.path.dirname(dependency['manifestPath']),'Base/OmniPBR.mdl'))
        if manifest.get('libraryId')=='nvidia-core-materials-omnipbr' and manifest.get('version')=='2.1.0' and all(hashes.get(path)==digest for path,digest in OMNIPBR_MODULES.items()) and os.path.realpath(asset.resolvedPath or str(Ar.GetResolver().Resolve(asset.path)))==expected:
            identity={'resourceId':dependency['resourceId'],'version':dependency['version'],'moduleSha256':OMNIPBR_MODULES['Base/OmniPBR.mdl'],'subIdentifier':'OmniPBR','derivation':'pinned-omnipbr-subset'};break
    if identity is None:warnings.add('USD_OMNIPBR_MODULE_UNVERIFIED: '+name);return None
    defaults={'diffuse_color_constant':(.2,.2,.2),'diffuse_tint':(1.,1.,1.),'albedo_brightness':1.,'albedo_add':0.,'reflection_roughness_constant':.5,'metallic_constant':0.,'reflection_roughness_texture_influence':0.,'metallic_texture_influence':0.,'enable_ORM_texture':False,'flip_tangent_u':False,'flip_tangent_v':True,'bump_factor':1.}
    types={**{key:'float'for key in defaults if key not in ('diffuse_color_constant','diffuse_tint','enable_ORM_texture','flip_tangent_u','flip_tangent_v')},'diffuse_color_constant':'color3f','diffuse_tint':'color3f','enable_ORM_texture':'bool','flip_tangent_u':'bool','flip_tangent_v':'bool',**{key:'asset'for key in ('diffuse_texture','ORM_texture','normalmap_texture','reflectionroughness_texture','metallic_texture')}}
    # 这组源资产只使用UV0/identity。其它投影、UV变换或MDL节点不能静默按默认处理。
    uv_defaults={'project_uvw':False,'world_or_object':False,'uv_space_index':0,'texture_translate':(0.,0.),'texture_rotate':0.,'texture_scale':(1.,1.)}
    for value in shader.GetInputs():
        key=str(value.GetBaseName())
        if value.HasConnectedSource():warnings.add('USD_OMNIPBR_CONNECTION_UNSUPPORTED: '+name+':'+key);return None
        if key in uv_defaults:
            actual=value.Get();expected=uv_defaults[key]
            if (tuple(actual)if isinstance(expected,tuple)else actual)!=expected:warnings.add('USD_OMNIPBR_UV_UNSUPPORTED: '+name+':'+key);return None
        elif key not in types or str(value.GetTypeName())!=types[key]:warnings.add('USD_OMNIPBR_INPUT_UNSUPPORTED: '+name+':'+key);return None
    values={key:input_value(shader,key,default)for key,default in defaults.items()}
    numbers=[number for value in values.values()for number in (value if isinstance(value,(tuple,list))or hasattr(value,'__len__')else[value])]
    if not all(math.isfinite(float(number))for number in numbers):warnings.add('USD_OMNIPBR_INPUT_INVALID: '+name);return None
    result={'sourcePrimPath':name,'shader':'OmniPBR','sourceModule':identity,'baseColor':[float(v)*float(t)for v,t in zip(values['diffuse_color_constant'],values['diffuse_tint'])],'roughness':float(values['reflection_roughness_constant']),'metallic':float(values['metallic_constant']),'opacity':1.}
    def binding(key,channel,color_space,scale,bias):
        texture=input_value(shader,key,None)
        if not texture or not texture.path:return None
        path=texture.resolvedPath or str(Ar.GetResolver().Resolve(texture.path));suffix=os.path.splitext(path)[1].lower()
        if suffix not in IMAGE_MIME:warnings.add('USD_TEXTURE_FORMAT_UNSUPPORTED: '+path);return None
        try:raw=texture_bytes(path)
        except RuntimeError as error:warnings.add(str(error));return None
        declared_space=str(shader.GetInput(key).GetAttr().GetColorSpace())
        if declared_space and declared_space not in ('auto','raw','sRGB'):warnings.add('USD_TEXTURE_COLORSPACE_UNSUPPORTED: '+declared_space);return None
        if color_space=='auto':color_space=declared_space if declared_space in ('raw','sRGB')else image_metadata(raw,IMAGE_MIME[suffix])[1]
        elif declared_space and declared_space not in ('auto',color_space):warnings.add('USD_OMNIPBR_COLORSPACE_UNSUPPORTED: '+name+':'+key);return None
        digest=hashlib.sha256(raw).hexdigest()
        if digest not in textures and (len(textures)>=64 or sum(row['size']for row in textures.values())+len(raw)>128*1024*1024):warnings.add('USD_TEXTURE_TOTAL_PREVIEW_BUDGET');return None
        textures[digest]={'id':digest,'assetPath':path,'mimeType':IMAGE_MIME[suffix],'file':digest+suffix,'size':len(raw)}
        return {'textureId':digest,'channel':channel,'colorSpace':color_space,'wrapS':'repeat','wrapT':'repeat','scale':scale,'bias':bias,'uvTransform':[1.,0.,0.,0.,1.,0.,0.,0.,1.]}
    color=binding('diffuse_texture','rgb','auto',[float(values['albedo_brightness'])]*3+[1.],[float(values['albedo_add'])]*3+[0.])
    if color:result['baseColorTexture']=color;result['baseColor']=[float(v)for v in values['diffuse_tint']]
    for target,constant,influence,separate,channel in [('roughnessTexture','roughness','reflection_roughness_texture_influence','reflectionroughness_texture','g'),('metallicTexture','metallic','metallic_texture_influence','metallic_texture','b')]:
        weight=float(values[influence]);offset=result[constant]*(1.-weight)
        if weight:
            texture=binding('ORM_texture'if values['enable_ORM_texture']else separate,channel if values['enable_ORM_texture']else'r','raw',[weight]*4,[offset]*4)
            if texture:result[target]=texture;result[constant]=1.
    factor=float(values['bump_factor']);u=-1. if values['flip_tangent_u']else 1.;v=-1. if values['flip_tangent_v']else 1.
    if factor:
        normal=binding('normalmap_texture','rgb','raw',[2.*factor*u,2.*factor*v,2.,1.],[-factor*u,-factor*v,-1.,0.])
        if normal:result['normalTexture']=normal
    warnings.add('USD_OMNIPBR_SUBSET_DERIVED: '+name+'；固定标准模块的Albedo/roughness/metallic/normal及UV0常量派生，不执行MDL，未支持任意网络/投影/额外材质层')
    return result


def material_fact(prim,textures,warnings,standard_libraries=()):
    material,_=UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial(UsdShade.Tokens.preview)
    if not material:return None
    shader,_,_=material.ComputeSurfaceSource()
    name=str(material.GetPath())
    if not shader or str(shader.GetIdAttr().Get())!='UsdPreviewSurface':
        mdl_shader,_,_=material.ComputeSurfaceSource('mdl')
        if mdl_shader:
            derived=omnipbr_fact(mdl_shader,material,textures,warnings,standard_libraries)
            if derived:return derived
        warnings.add('USD_MATERIAL_SHADER_UNSUPPORTED: '+name+'；仅支持UsdPreviewSurface，MDL/任意shader仍保留于源件')
        return None
    if int(input_value(shader,'useSpecularWorkflow',0))!=0:
        warnings.add('USD_MATERIAL_SPECULAR_WORKFLOW_UNSUPPORTED: '+name);return None
    result={'sourcePrimPath':name,'shader':'UsdPreviewSurface','baseColor':[float(v) for v in input_value(shader,'diffuseColor',(.18,.18,.18))],
            'roughness':float(input_value(shader,'roughness',.5)),'metallic':float(input_value(shader,'metallic',0)),
            'opacity':float(input_value(shader,'opacity',1))}
    for source_name,target,channels in [('diffuseColor','baseColorTexture',('rgb','r','g','b')),('roughness','roughnessTexture',('r','g','b','a')),('metallic','metallicTexture',('r','g','b','a')),('normal','normalTexture',('rgb',))]:
        connection=connected(shader,source_name)
        if not connection:continue
        source,output,_=connection;texture=UsdShade.Shader(source.GetPrim())
        if not texture or str(texture.GetIdAttr().Get())!='UsdUVTexture' or str(output) not in channels:
            warnings.add('USD_MATERIAL_CONNECTION_UNSUPPORTED: '+name+':'+source_name);continue
        st=connected(texture,'st')
        if not st:
            warnings.add('USD_TEXTURE_ST_CONNECTION_REQUIRED: '+str(texture.GetPath()));continue
        transform=uv_transform(st,warnings)
        if transform is None:continue
        asset=input_value(texture,'file',None)
        path=(asset.resolvedPath or asset.path) if asset else ''
        suffix=os.path.splitext(path.rstrip(']'))[1].lower()
        if suffix not in IMAGE_MIME:warnings.add('USD_TEXTURE_FORMAT_UNSUPPORTED: '+path);continue
        try:raw=texture_bytes(path)
        except RuntimeError as error:warnings.add(str(error));continue
        metadata,auto_color=image_metadata(raw,IMAGE_MIME[suffix])
        wrap_s=str(input_value(texture,'wrapS','useMetadata'));wrap_t=str(input_value(texture,'wrapT','useMetadata'))
        if wrap_s=='useMetadata':wrap_s=metadata.get('wrapS','black')
        if wrap_t=='useMetadata':wrap_t=metadata.get('wrapT','black')
        if wrap_s not in ('repeat','clamp','mirror','black') or wrap_t not in ('repeat','clamp','mirror','black'):
            warnings.add('USD_TEXTURE_WRAP_UNSUPPORTED: '+str(texture.GetPath()));continue
        key=hashlib.sha256(raw).hexdigest()
        if key not in textures and (len(textures)>=64 or sum(row['size'] for row in textures.values())+len(raw)>128*1024*1024):
            warnings.add('USD_TEXTURE_TOTAL_PREVIEW_BUDGET');continue
        textures[key]={'id':key,'assetPath':path,'mimeType':IMAGE_MIME[suffix],'file':key+suffix,'size':len(raw)}
        colorspace=str(input_value(texture,'sourceColorSpace','auto'))
        if colorspace not in ('auto','sRGB','raw'):warnings.add('USD_TEXTURE_COLORSPACE_UNSUPPORTED: '+colorspace);continue
        result[target]={'textureId':key,'channel':str(output),'colorSpace':auto_color if colorspace=='auto' else colorspace,
                        'wrapS':wrap_s,'wrapT':wrap_t,'scale':[float(v) for v in input_value(texture,'scale',(1,1,1,1))], 'bias':[float(v) for v in input_value(texture,'bias',(0,0,0,0))],'uvTransform':transform}
        if source_name!='normal':result[{'diffuseColor':'baseColor','roughness':'roughness','metallic':'metallic'}[source_name]]=[1,1,1] if source_name=='diffuseColor' else 1
    # 不把其它连接网络冒充为已显示。
    for field in ('displacement','emissiveColor','opacity'):
        if connected(shader,field):warnings.add('USD_MATERIAL_CHANNEL_UNSUPPORTED: '+name+':'+field)
    return result


def extract_textures(rows):
    result=[]
    for row in rows:
        raw=texture_bytes(row['assetPath'])
        if hashlib.sha256(raw).hexdigest()!=row['id']:raise RuntimeError('USD_TEXTURE_CHANGED: '+row['assetPath'])
        with open(row['target'],'wb') as file:file.write(raw)
        result.append({'id':row['id'],'size':len(raw)})
    return {'files':result}
