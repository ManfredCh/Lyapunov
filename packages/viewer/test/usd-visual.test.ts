import {test,expect} from 'bun:test'
import * as THREE from 'three'
import {buildUsdVisual,applyUsdBodyWorldPoses} from '../src/usd-visual.ts'
import type {UsdPreview} from '../../lyapunov-contracts/src/usd.ts'
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] as const
const preview:UsdPreview={source:'openusd-default-time',status:'AVAILABLE',losses:[],shapes:[{primPath:'/Robot/Link/Cube',kind:'Cube',size:1,color:[.5,.5,.5],matrix:[...identity],bodyPrimPath:'/Robot/Link',bodyFromShape:[...identity]}]}
test('USD子几何应用同帧body世界矩阵；父实体变换不重复叠加，源prim映射稳定',()=>{
 const parent=new THREE.Group();parent.position.set(3,4,5);parent.rotation.z=.2;parent.scale.setScalar(2)
 const visual=buildUsdVisual(preview);parent.add(visual)
 const matrix=new THREE.Matrix4().makeTranslation(1,2,3).toArray()
 const poses={'/Robot/Link':{sourcePrimPath:'/Robot/Link',runtimePrimPath:'/World/e/source/Link',worldMatrixM:matrix}}
 expect(applyUsdBodyWorldPoses(visual,poses).applied).toBe(1)
 const shape=visual.children[0]!,position=shape.getWorldPosition(new THREE.Vector3())
 for(let i=0;i<3;i++)expect(position.toArray()[i]).toBeCloseTo([1,2,3][i]!,8)
 parent.position.set(-4,5,6);matrix[12]=7
 expect(applyUsdBodyWorldPoses(visual,poses).applied).toBe(1);expect(shape.getWorldPosition(new THREE.Vector3()).x).toBeCloseTo(7,8)
 expect(shape.userData.usdPrimPath).toBe('/Robot/Link/Cube')
 expect(()=>applyUsdBodyWorldPoses(visual,{'/Robot/Link':{...poses['/Robot/Link'],sourcePrimPath:'/Other'}})).toThrow('USD_BODY_POSE_INVALID')
})

test('USD PreviewSurface材质、faceVarying UV与受控纹理异步装配；覆盖克隆保留shader且不改原材质',async()=>{
 const {loadUsdVisual}=await import('../src/usd-visual.ts')
 const {primaryResource}=await import('../src/lod.ts')
 const {EntityMaterialOverride}=await import('../src/material-override.ts')
 const binding={textureId:'checker',channel:'rgb' as const,colorSpace:'sRGB' as const,wrapS:'repeat' as const,wrapT:'clamp' as const,scale:[1,1,1,1] as [number,number,number,number],bias:[0,0,0,0] as [number,number,number,number],uvTransform:[0,2,0,-3,0,0,.25,-.5,1]as [number,number,number,number,number,number,number,number,number]}
 const value:UsdPreview={source:'openusd-default-time',status:'AVAILABLE',losses:[],textures:[{id:'checker',file:'checker.png',mimeType:'image/png'}],shapes:[{primPath:'/M/Plane',kind:'Mesh',matrix:[...identity],color:[.1,.2,.3],points:[[-1,0,0],[0,0,0],[0,1,0],[-1,1,0],[1,0,0],[1,1,0]],counts:[4,4],indices:[0,1,2,3,1,4,5,2],uvs:[[0,0],[1,0],[1,1],[0,1],[0,0],[1,0],[1,1],[0,1]],uvInterpolation:'faceVarying',material:{sourcePrimPath:'/M/Material',shader:'UsdPreviewSurface',baseColor:[1,1,1],roughness:.37,metallic:.2,opacity:1,baseColorTexture:binding,roughnessTexture:{...binding,channel:'r',colorSpace:'raw'},normalTexture:{...binding,colorSpace:'raw',scale:[2,2,2,2],bias:[-1,-1,-1,-1]}}}]}
 let reads=0
 const visual=await loadUsdVisual(value,async texture=>'controlled:'+texture.id,async url=>{expect(url).toBe('controlled:checker');reads++;return new THREE.DataTexture(new Uint8Array([255,0,0,255]),1,1)})
 expect(reads).toBe(1)
 const mesh=visual.children[0] as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>,material=mesh.material
 expect(material.roughness).toBeCloseTo(.37);expect(material.metalness).toBeCloseTo(.2);expect(material.map?.colorSpace).toBe(THREE.SRGBColorSpace);expect(material.roughnessMap?.colorSpace).toBe(THREE.NoColorSpace)
 expect(material.map?.wrapS).toBe(THREE.RepeatWrapping);expect(material.map?.wrapT).toBe(THREE.ClampToEdgeWrapping)
 expect(material.normalMap?.colorSpace).toBe(THREE.NoColorSpace);expect(material.normalMapType).toBe(THREE.TangentSpaceNormalMap)
 expect(material.map?.matrixAutoUpdate).toBe(false);expect(material.map?.matrix.elements).toEqual(binding.uvTransform)
 const mapped=new THREE.Vector3(1,.5,1).applyMatrix3(material.map!.matrix);expect(mapped.x).toBeCloseTo(-1.25,8);expect(mapped.y).toBeCloseTo(1.5,8)
 const position=mesh.geometry.getAttribute('position'),uv=mesh.geometry.getAttribute('uv'),seam:number[]=[]
 for(let i=0;i<position.count;i++)if(position.getX(i)===0&&position.getY(i)===0)seam.push(uv.getX(i))
 expect(seam).toContain(0);expect(seam).toContain(1);expect(position.count).toBe(12)
 const shader={fragmentShader:'#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>'} as any
 material.onBeforeCompile(shader,{} as any);expect(shader.fragmentShader).toContain('texelRoughness.r');expect(shader.fragmentShader).not.toContain('texelRoughness.g;')
 expect(shader.fragmentShader).toContain('vec3(2.0,2.0,2.0)');expect(shader.fragmentShader).toContain('vec3(-1.0,-1.0,-1.0)');expect(shader.fragmentShader).not.toContain('xyz * 2.0 - 1.0');expect(shader.fragmentShader).toContain('normal = normalize( tbn * mapN )')
 const override=new EntityMaterialOverride();override.apply([visual],{kind:'visual/material-override',roughness:.8})
 expect(mesh.material.roughness).toBe(.8);expect(material.roughness).toBeCloseTo(.37);expect(mesh.material.map).toBe(material.map);expect(mesh.material.onBeforeCompile).toBe(material.onBeforeCompile)
 override.reset();expect(mesh.material).toBe(material)
 const source={resourceId:'source',version:1,original:{uri:'res:source',mimeType:'model/vnd.usd'},representations:[{uri:'res:source',mimeType:'model/vnd.usd',role:'simulation'}],source:{units:'m',upAxis:'Z' as const,handedness:'right' as const,metersPerUnit:1}},derived={...source,resourceId:'preview',original:{uri:'res:preview',mimeType:'application/vnd.lyapunov.usd-preview+json'},representations:[{uri:'res:preview',mimeType:'application/vnd.lyapunov.usd-preview+json',role:'visual'}]}
 expect(primaryResource({entityId:'e',name:'e',transform:{position:[0,0,0],quaternion:[0,0,0,1],scale:[1,1,1]},components:{visual:{kind:'usd'}},resources:[source,derived]})?.resourceId).toBe('source')
})
