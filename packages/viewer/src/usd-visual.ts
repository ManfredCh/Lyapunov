import * as THREE from 'three'
import type { UsdPreview, UsdBodyWorldPose, UsdPreviewMaterial, UsdPreviewTexture, UsdTextureBinding } from '../../lyapunov-contracts/src/usd.ts'

/** OpenUSD默认时刻几何的明确派生显示；源USD仍是ResourceRef.original。 */
export function buildUsdVisual(preview: UsdPreview | undefined): THREE.Group {
  if (!preview || preview.status!=='AVAILABLE') throw Error(preview?.reason??'USD_PREVIEW_UNAVAILABLE')
  const root=new THREE.Group()
  root.userData.usdPreview={source:preview.source,losses:preview.losses}
  for (const shape of preview.shapes) {
    let geometry: THREE.BufferGeometry
    if (shape.kind==='Mesh') {
      const points=shape.points??[], indices=shape.indices??[], triangles:number[]=[]
      const expanded:number[]=[],uvs:number[]=[],normals:number[]=[]
      let cursor=0,faceIndex=0
      for (const count of shape.counts??[]) {
        const cornerStart=cursor,face=indices.slice(cursor,cursor+count); cursor+=count
        if(count<3 || face.some(i=>!points[i]))continue
        // 投影到面积最大的坐标平面，由earcut处理凹多边形；不使用错误的三角扇填洞。
        const a=new THREE.Vector3(...points[face[0]!]! as [number,number,number]),normal=new THREE.Vector3()
        for(let i=1;i<count-1;i++)normal.add(new THREE.Vector3(...points[face[i]!]! as [number,number,number]).sub(a).cross(new THREE.Vector3(...points[face[i+1]!]! as [number,number,number]).sub(a)))
        const axis=Math.abs(normal.x)>Math.abs(normal.y)?Math.abs(normal.x)>Math.abs(normal.z)?0:2:Math.abs(normal.y)>Math.abs(normal.z)?1:2
        const contour=face.map(i=>{const p=points[i]!;return new THREE.Vector2(p[axis===0?1:0],p[axis===2?1:2])})
        for(const triangle of THREE.ShapeUtils.triangulateShape(contour,[]))for(const corner of shape.orientation==='leftHanded'?[...triangle].reverse():triangle){
          const vertex=face[corner]!
          if(shape.uvs?.length||shape.normals?.length){
            expanded.push(...points[vertex]!)
            const element=(interpolation:string|undefined)=>interpolation==='faceVarying'?cornerStart+corner:interpolation==='uniform'?faceIndex:interpolation==='constant'?0:vertex
            if(shape.uvs?.length){const uv=shape.uvs[element(shape.uvInterpolation)];if(!uv||uv.length!==2||!uv.every(Number.isFinite))throw Error('USD_TEXTURE_UV_INVALID: '+shape.primPath);uvs.push(...uv)}
            if(shape.normals?.length){const normal=shape.normals[element(shape.normalInterpolation)];if(!normal||normal.length!==3||!normal.every(Number.isFinite)||Math.hypot(...normal)===0)throw Error('USD_NORMAL_INVALID: '+shape.primPath);normals.push(...normal)}
          }else triangles.push(vertex)
        }
        faceIndex++
      }
      geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(expanded.length?expanded:points.flat(),3))
      if(uvs.length)geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));if(!expanded.length)geometry.setIndex(triangles)
      if(normals.length){geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));geometry.normalizeNormals()}else geometry.computeVertexNormals()
    } else if (shape.kind==='Cube') geometry=new THREE.BoxGeometry(shape.size,shape.size,shape.size)
    else if (shape.kind==='Sphere') geometry=new THREE.SphereGeometry(shape.radius,24,16)
    else if(shape.kind==='Cone') geometry=new THREE.ConeGeometry(shape.radius,shape.height,24)
    else if(shape.kind==='Capsule') geometry=new THREE.CapsuleGeometry(shape.radius,shape.height,8,24)
    else geometry=new THREE.CylinderGeometry(shape.radius,shape.radius,shape.height,24)
    if(['Cylinder','Cone','Capsule'].includes(shape.kind)) {
      if(shape.axis==='Z')geometry.rotateX(Math.PI/2)
      else if(shape.axis==='X')geometry.rotateZ(-Math.PI/2)
    }
    const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({name:shape.material?.sourcePrimPath??'',color:new THREE.Color(...(shape.material?.baseColor??shape.color)),roughness:shape.material?.roughness??.6,metalness:shape.material?.metallic??0,opacity:shape.material?.opacity??1,transparent:(shape.material?.opacity??1)<1,side:THREE.DoubleSide}))
    mesh.name=shape.primPath;mesh.userData.usdPrimPath=shape.primPath;mesh.userData.usdMaterial=shape.material
    if(shape.bodyPrimPath&&shape.bodyFromShape){mesh.userData.usdBodyPrimPath=shape.bodyPrimPath;mesh.userData.usdBodyFromShape=shape.bodyFromShape}
    mesh.applyMatrix4(new THREE.Matrix4().fromArray(shape.matrix))
    mesh.castShadow=true;mesh.receiveShadow=true;root.add(mesh)
  }
  return root
}

/** 与实体根同帧的原生body世界矩阵驱动子几何；不以默认时刻关节角或动画替代。 */
export function applyUsdBodyWorldPoses(root:THREE.Object3D|undefined,value:unknown):{applied:number;unmatched:string[]} {
 const result={applied:0,unmatched:[] as string[]}
 if(!root||!value||typeof value!=='object')return result
 const poses=value as Record<string,UsdBodyWorldPose>
 root.updateWorldMatrix(true,true)
 root.traverse(mesh=>{
  const path=mesh.userData.usdBodyPrimPath,local=mesh.userData.usdBodyFromShape
  if(typeof path!=='string'||!Array.isArray(local))return
  const pose=poses[path]
  if(!pose){result.unmatched.push(path);return}
  if(pose.sourcePrimPath!==path||!Array.isArray(pose.worldMatrixM)||pose.worldMatrixM.length!==16||!pose.worldMatrixM.every(Number.isFinite))throw Error('USD_BODY_POSE_INVALID: '+path)
  const world=new THREE.Matrix4().fromArray(pose.worldMatrixM).multiply(new THREE.Matrix4().fromArray(local))
  if(mesh.parent){mesh.parent.updateWorldMatrix(true,false);world.premultiply(mesh.parent.matrixWorld.clone().invert())}
  mesh.matrixAutoUpdate=false;mesh.matrix.copy(world);mesh.matrixWorldNeedsUpdate=true;result.applied++
 })
 return result
}

const glsl=(value:number)=>Number.isInteger(value)?value.toFixed(1):String(value)
function channelExpression(variable:string,binding:UsdTextureBinding,vector=false,uv='vMapUv'):string {
 const mask=[binding.wrapS==='black'?`step(0.0,${uv}.x)*step(${uv}.x,1.0)`:'1.0',binding.wrapT==='black'?`step(0.0,${uv}.y)*step(${uv}.y,1.0)`:'1.0'].join('*')
 const channel=binding.channel==='rgb'?'r':binding.channel,index={r:0,g:1,b:2,a:3}[channel]
 if(vector&&binding.channel==='rgb')return `(${variable}.rgb * (${mask}) * vec3(${binding.scale.slice(0,3).map(glsl).join(',')}) + vec3(${binding.bias.slice(0,3).map(glsl).join(',')}))`
 const scalar=`(${variable}.${channel} * (${mask}) * ${glsl(binding.scale[index]!)} + ${glsl(binding.bias[index]!)})`
 return vector?`vec3(${scalar})`:scalar
}
/** 在Three标准材质已有map采样处保留USD输出通道和scale/bias，不创建另一渲染器。 */
function configureUsdChannels(material:THREE.MeshStandardMaterial,fact:UsdPreviewMaterial):void {
 material.userData.usdMaterial=fact
 material.onBeforeCompile=shader=>{
  if(fact.baseColorTexture)shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#ifdef USE_MAP
 vec4 sampledDiffuseColor=texture2D(map,vMapUv);
 diffuseColor.rgb *= ${channelExpression('sampledDiffuseColor',fact.baseColorTexture,true)};
#endif`)
  if(fact.roughnessTexture)shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>',THREE.ShaderChunk.roughnessmap_fragment.replace('texelRoughness.g',channelExpression('texelRoughness',fact.roughnessTexture,false,'vRoughnessMapUv')))
  if(fact.metallicTexture)shader.fragmentShader=shader.fragmentShader.replace('#include <metalnessmap_fragment>',THREE.ShaderChunk.metalnessmap_fragment.replace('texelMetalness.b',channelExpression('texelMetalness',fact.metallicTexture,false,'vMetalnessMapUv')))
  if(fact.normalTexture)shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',THREE.ShaderChunk.normal_fragment_maps.replaceAll('texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0',channelExpression('texture2D(normalMap,vNormalMapUv)',fact.normalTexture,true,'vNormalMapUv')))
 }
 material.customProgramCacheKey=()=>JSON.stringify(['usd-preview-surface',fact.baseColorTexture,fact.roughnessTexture,fact.metallicTexture,fact.normalTexture])
}
export async function loadUsdVisual(preview:UsdPreview|undefined,resolveTexture:(texture:UsdPreviewTexture)=>Promise<string>,loadTexture:(url:string)=>Promise<THREE.Texture>=url=>new THREE.TextureLoader().loadAsync(url)):Promise<THREE.Group>{
 const root=buildUsdVisual(preview),sources=new Map<string,Promise<THREE.Texture>>()
 const wrap={repeat:THREE.RepeatWrapping,clamp:THREE.ClampToEdgeWrapping,mirror:THREE.MirroredRepeatWrapping,black:THREE.ClampToEdgeWrapping}
 try{
  for(const object of root.children){
   const mesh=object as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>,fact=mesh.userData.usdMaterial as UsdPreviewMaterial|undefined
   if(!fact)continue
   const owned:THREE.Texture[]=[];mesh.material.addEventListener('dispose',()=>{for(const texture of owned)texture.dispose()})
   for(const [slot,key] of [['baseColorTexture','map'],['roughnessTexture','roughnessMap'],['metallicTexture','metalnessMap'],['normalTexture','normalMap']] as const){
    const binding=fact[slot];if(!binding)continue
    if(!mesh.geometry.hasAttribute('uv'))throw Error('USD_TEXTURE_UV_MISSING: '+mesh.name)
    const descriptor=preview?.textures?.find(texture=>texture.id===binding.textureId)
    if(!descriptor)throw Error('USD_TEXTURE_DESCRIPTOR_MISSING: '+binding.textureId)
    let pending=sources.get(descriptor.id)
    if(!pending){pending=resolveTexture(descriptor).then(loadTexture);sources.set(descriptor.id,pending)}
    const texture=(await pending).clone();owned.push(texture)
    texture.colorSpace=binding.colorSpace==='sRGB'?THREE.SRGBColorSpace:THREE.NoColorSpace
    texture.wrapS=wrap[binding.wrapS];texture.wrapT=wrap[binding.wrapT];texture.flipY=true;texture.needsUpdate=true
    if(binding.uvTransform){if(binding.uvTransform.length!==9||!binding.uvTransform.every(Number.isFinite))throw Error('USD_TEXTURE_UV_TRANSFORM_INVALID');texture.matrixAutoUpdate=false;texture.matrix.fromArray(binding.uvTransform)}
    mesh.material[key]=texture
   }
   configureUsdChannels(mesh.material,fact);mesh.material.needsUpdate=true
  }
  return root
 }catch(error){root.traverse(object=>{if(object instanceof THREE.Mesh){object.geometry.dispose();for(const material of Array.isArray(object.material)?object.material:[object.material])material.dispose()}});throw error}
 finally{for(const pending of sources.values())void pending.then(texture=>texture.dispose(),()=>{})}
}
