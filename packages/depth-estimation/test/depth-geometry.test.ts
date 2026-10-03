/**
 * depth_geometry 的真实行为测试：真实 python + 真实 numpy 跑 `python/geometry.py`，走**原生** tools/subprocess
 * 装配（cordis Context + dsh-tools + dsh-commands + subprocess-local）。数值判定一律用测试自己的独立读数
 * （自己解析 npy 头与像元、自己按相机合同投影、自己解析 GLB 二进制与 PLY 头、自己算最小二乘），
 * 不复用 provider 的 report 当结论——report 只在"与独立读数一致"时被引用。
 *
 * 本版重点（逐条对应本轮审阅意见）：
 *  · 逐图标定：两幅**相同真实几何、故意不同 relative affine** 的图各自恢复自己的 scale/shift；
 *    某图无锚点不得借别的图的锚点变米制，且米制结果与相对预览不混单位、不混同一个世界；
 *  · 锚点独立性：train/check 同图同像元直接拒绝；矛盾训练点即使 check 恰好过也必须 accepted=false
 *    （反例里 check 最大误差就是 0）；报告只声明"未参与拟合 + 不是同一个点"；
 *  · 无尺度只剩**逆深度预览**（1/relative 假定、只旋转不平移）：近远顺序必须与相对值一致（越大越近）；
 *  · GLB 按 glTF 标准 Y-up 导出，并用**真实 SceneOperations.import/mount** 核对非原点三点坐标与朝向；
 *  · 不再有 linear 映射（未匹配真实上游）与生产层 GLB 结构解析器（完整结构检查在测试里）。
 *
 * 前置（缺任一项直接退出 2，不伪装通过）：
 *   LYAPUNOV_DEPTH_GEOMETRY_TEST_PYTHON     含 numpy 的解释器（顶点颜色另需 Pillow）
 *   LYAPUNOV_DEPTH_GEOMETRY_TEST_DEPTH_NPY  真实照片的相对深度 npy（depth_estimate 产物，只读）
 *   LYAPUNOV_DEPTH_GEOMETRY_TEST_METADATA   同一次 depth_estimate 的 metadata（只读）
 *   LYAPUNOV_DEPTH_GEOMETRY_TEST_PHOTO      真实原照片（顶点颜色与来源，只读）
 *   LYAPUNOV_DEPTH_GEOMETRY_TEST_DATA_DIR   产物目录（可选，默认 mkdtemp）
 * 用法：node packages/depth-estimation/test/depth-geometry.test.ts（要复用真实 scene-kit，Node 的 strip-only
 *       解析不了它的构造函数参数属性 → 脚本自己带 --experimental-transform-types 重进一次；bun 直接跑也兼容）
 * 退出码：0=全部通过；1=有失败；2=缺前置条件。
 */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import Commands from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { cp,mkdir,mkdtemp,readFile,rm,stat,truncate,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { spawnSync } from 'node:child_process'
import { Matrix4,Quaternion,Vector3 } from 'three'
import type { Entity,Transform } from '../../lyapunov-contracts/src/types.ts'
import {
  DepthGeometryError,collectGeometryArtifacts,defaultGeometryScript,depthGeometryStatus,
  registerDepthGeometryTools,runDepthGeometry,
} from '../src/geometry.ts'

// Node 的 strip-only 解析器不支持构造函数参数属性（scene-kit/src/operations.ts 用了；script/gates/run-g13.ts 有同样的适配）。
// 本测试要复用**真实** SceneOperations，所以带着 --experimental-transform-types 重新进入一次（幂等，私有标记防递归；
// bun 自己能解析，不重进）。
if(typeof (process.versions as Record<string,unknown>).bun!=='string'
   &&process.env.LYAPUNOV_DEPTH_GEOMETRY_TRANSFORM_TYPES!=='1'
   &&!process.execArgv.includes('--experimental-transform-types')){
  const child=spawnSync(process.execPath,['--experimental-transform-types','--no-warnings',...process.argv.slice(1)],{
    stdio:'inherit',env:{...process.env,LYAPUNOV_DEPTH_GEOMETRY_TRANSFORM_TYPES:'1'},
  })
  if(child.error){console.error('无法用 --experimental-transform-types 重新进入 node: '+String(child.error));process.exit(2)}
  process.exit(child.status??1)
}
const { SceneOperations }=await import('../../scene-kit/src/operations.ts')

const python=process.env.LYAPUNOV_DEPTH_GEOMETRY_TEST_PYTHON??process.env.LYAPUNOV_DEPTH_TEST_PYTHON
const realDepthNpy=process.env.LYAPUNOV_DEPTH_GEOMETRY_TEST_DEPTH_NPY
const realMetadata=process.env.LYAPUNOV_DEPTH_GEOMETRY_TEST_METADATA
const realPhoto=process.env.LYAPUNOV_DEPTH_GEOMETRY_TEST_PHOTO
const dataDirectory=process.env.LYAPUNOV_DEPTH_GEOMETRY_TEST_DATA_DIR
const missing=['LYAPUNOV_DEPTH_GEOMETRY_TEST_PYTHON','LYAPUNOV_DEPTH_GEOMETRY_TEST_DEPTH_NPY','LYAPUNOV_DEPTH_GEOMETRY_TEST_METADATA','LYAPUNOV_DEPTH_GEOMETRY_TEST_PHOTO'].filter(name=>!process.env[name])
if(missing.length){
  console.error('缺少真实前置环境变量，未运行任何用例（不伪装通过）: '+missing.join(', '))
  process.exit(2)
}
const scratch=dataDirectory??await mkdtemp(join(tmpdir(),'lyapunov-depth-geometry-test-'))
await mkdir(scratch,{recursive:true})
const outputRoot=join(scratch,'outputs')
const fixtures=join(scratch,'fixtures')
await mkdir(fixtures,{recursive:true})

const failures:string[]=[]
let passed=0
async function check(name:string,body:()=>Promise<void>|void){
  try{await body();passed++;console.log('  ok  '+name)}
  catch(error){failures.push(name+': '+(error instanceof Error?error.message:String(error)));console.log('  FAIL '+name+' → '+(error instanceof Error?error.message:String(error)))}
}
function assert(condition:unknown,message:string):asserts condition{if(!condition)throw new Error(message)}
function approx(actual:number,expected:number,epsilon:number,label:string){
  assert(Number.isFinite(actual),`${label} 不是有限数: ${actual}`)
  assert(Math.abs(actual-expected)<=epsilon,`${label} 期望 ${expected}±${epsilon}，实际 ${actual}`)
}

// ---------------------------------------------------------------- 独立读数工具（不依赖 provider 的实现）

/** 只给夹具写 npy 用；读取一律走 readNpy（独立解析，不采信 metadata 自述）。 */
function npyBuffer(height:number,width:number,values:Float32Array){
  const header=`{'descr': '<f4', 'fortran_order': False, 'shape': (${height}, ${width}), }`
  const padding=(64-(10+header.length+1)%64)%64
  const text=header+' '.repeat(padding)+'\n'
  const prefix=Buffer.alloc(10+text.length)
  prefix.write('\x93NUMPY','latin1');prefix.writeUInt8(1,6);prefix.writeUInt8(0,7);prefix.writeUInt16LE(text.length,8);prefix.write(text,10,'latin1')
  const body=Buffer.alloc(values.length*4)
  for(let index=0;index<values.length;index++)body.writeFloatLE(values[index]!,index*4)
  return Buffer.concat([prefix,body])
}
interface NpyReadout{shape:number[];dtype:string;float?:Float32Array;bytes?:Uint8Array}
async function readNpy(path:string):Promise<NpyReadout>{
  const buffer=await readFile(path)
  assert(buffer.subarray(0,6).toString('latin1')==='\x93NUMPY','npy magic 不对: '+path)
  const headerLength=buffer.readUInt16LE(8)
  const header=buffer.subarray(10,10+headerLength).toString('latin1')
  const shape=(/\(([^)]*)\)/.exec(header.replace(/'shape':\s*/,''))?.[1]??'').split(',').map(part=>part.trim()).filter(Boolean).map(Number)
  const dtype=/'descr':\s*'([^']+)'/.exec(header)?.[1]??''
  const body=buffer.subarray(10+headerLength)
  if(dtype==='<f4'){
    const values=new Float32Array(shape[0]!*shape[1]!)
    for(let index=0;index<values.length;index++)values[index]=body.readFloatLE(index*4)
    return {shape,dtype,float:values}
  }
  // numpy 的 uint8 descr 是 '|u1'（无字节序），别只认 '<u1'。
  if(dtype==='<u1'||dtype==='|u1')return {shape,dtype,bytes:Uint8Array.from(body)}

  throw new Error('测试不支持读这种 dtype: '+dtype)
}
/** 最小 PNG（RGB8、filter 0）编码器：合成夹具要一张"照片"来验顶点颜色取自原图像元。 */
const CRC_TABLE=(()=>{const table=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c}return table})()
function crc32(buffer:Buffer){
  let crc=-1
  for(const byte of buffer)crc=CRC_TABLE[(crc^byte)&0xff]!^(crc>>>8)
  return (crc^-1)>>>0
}
function pngChunk(type:string,data:Buffer){
  const length=Buffer.alloc(4);length.writeUInt32BE(data.length,0)
  const body=Buffer.concat([Buffer.from(type,'latin1'),data])
  const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body),0)
  return Buffer.concat([length,body,crc])
}
function encodePng(width:number,height:number,rgbAt:(u:number,v:number)=>[number,number,number]){
  const stride=1+width*3,raw=Buffer.alloc(height*stride)
  for(let v=0;v<height;v++)for(let u=0;u<width;u++){
    const color=rgbAt(u,v),offset=v*stride+1+u*3
    raw[offset]=color[0];raw[offset+1]=color[1];raw[offset+2]=color[2]
  }
  const ihdr=Buffer.alloc(13)
  ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4)
  ihdr[8]=8;ihdr[9]=2;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(raw)),pngChunk('IEND',Buffer.alloc(0))])
}
interface GlbPrimitive{vertices:Float32Array;colors:Float32Array|null;colorComponents:number;indices:Uint32Array|null;count:number;extras:Record<string,any>}
interface Glb{extras:Record<string,any>;primitives:GlbPrimitive[];json:Record<string,any>}
/**
 * 独立 GLB 解析器（直接照 glTF 2.0 语法写，不看 provider 的实现）：头/chunk/accessor/bufferView 全走一遍，
 * 位置与颜色按 accessor 解成数组，供"顶点真的落在真值几何上"的独立比较。生产层不再自带这套解析，
 * 完整结构检查只在这里（截断/越界/缺 min-max 都会被这个独立解析器抓到）。
 */
async function readGlb(path:string):Promise<Glb>{
  const buffer=await readFile(path)
  assert(buffer.subarray(0,4).toString('latin1')==='glTF','GLB magic 不对: '+path)
  assert(buffer.readUInt32LE(4)===2,'GLB version 不是 2: '+path)
  assert(buffer.readUInt32LE(8)===buffer.length,'GLB 头声明长度与文件不符: '+path)
  const chunks:Array<{type:string;start:number;length:number}>=[];let offset=12
  while(offset<buffer.length){
    const length=buffer.readUInt32LE(offset),type=buffer.subarray(offset+4,offset+8).toString('latin1')
    chunks.push({type,start:offset+8,length});offset+=8+length
  }
  assert(chunks.length===2&&chunks[0]!.type==='JSON'&&chunks[1]!.type==='BIN\0','GLB 必须恰好 JSON+BIN 两块: '+JSON.stringify(chunks.map(chunk=>chunk.type)))
  const json=JSON.parse(buffer.subarray(chunks[0]!.start,chunks[0]!.start+chunks[0]!.length).toString('utf8')) as Record<string,any>
  const binary=buffer.subarray(chunks[1]!.start,chunks[1]!.start+chunks[1]!.length)
  assert(json.buffers?.[0]?.byteLength===binary.length,'buffers[0].byteLength 与 BIN 块不符: '+path)
  // 5121=uint8(1B) 5123=uint16(2B) 5125=uint32(4B) 5126=float32(4B)
  const componentSize=(type:number)=>type===5125||type===5126?4:type===5123?2:1
  const componentCount=(type:string)=>type==='SCALAR'?1:type==='VEC2'?2:type==='VEC3'?3:type==='VEC4'?4:0
  function readAccessor(index:number){
    const accessor=json.accessors?.[index]
    assert(accessor,'accessor 不存在: '+String(index))
    const view=json.bufferViews?.[accessor.bufferView]
    assert(view,'bufferView 不存在: '+String(accessor.bufferView))
    assert(Number.isInteger(view.byteLength)&&view.byteLength>0,'bufferView 缺 byteLength')
    assert((view.byteOffset??0)+view.byteLength<=binary.length,'bufferView 越出 BIN 块')
    const count=componentCount(accessor.type),stride=view.byteStride??componentSize(accessor.componentType)*count
    const start=binary.byteOffset+(view.byteOffset??0)
    const values=new Float32Array(accessor.count*count)
    for(let item=0;item<accessor.count;item++)for(let part=0;part<count;part++){
      const at=start+item*stride+part*componentSize(accessor.componentType)
      const raw=accessor.componentType===5125?buffer.readUInt32LE(at):accessor.componentType===5123?buffer.readUInt16LE(at):accessor.componentType===5126?buffer.readFloatLE(at):buffer.readUInt8(at)
      values[item*count+part]=accessor.normalized&&accessor.componentType===5121?raw/255:accessor.normalized&&accessor.componentType===5123?raw/65535:raw
    }
    return {values,count,componentType:accessor.componentType as number}
  }
  const primitives:GlbPrimitive[]=[]
  const primitiveExtras:Array<Record<string,any>>=[]
  for(const mesh of json.meshes??[])for(const primitive of mesh.primitives??[]){
    const position=readAccessor(primitive.attributes.POSITION)
    assert(position.count===3&&position.componentType===5126,'POSITION 必须是 VEC3 float32')
    assert(Array.isArray(json.accessors[primitive.attributes.POSITION].min)&&Array.isArray(json.accessors[primitive.attributes.POSITION].max),'POSITION 缺 min/max')
    const color=primitive.attributes.COLOR_0!==undefined?readAccessor(primitive.attributes.COLOR_0):null
    const indices=primitive.indices!==undefined?readAccessor(primitive.indices):null
    primitives.push({vertices:position.values,colors:color?color.values:null,colorComponents:color?color.count:0,indices:indices?Uint32Array.from(indices.values):null,count:position.values.length/3,extras:primitive.extras??{}})
    primitiveExtras.push(primitive.extras??{})
  }
  assert(primitives.length>0,'GLB 没有 primitive: '+path)
  return {extras:json.meshes?.[0]?.extras??{},primitives,json}
}

// ---------------------------------------------------------------- 合成夹具（已知相机 + 已知几何）
const WIDTH=640,HEIGHT=480
const FX=500,FY=500,CX=319.5,CY=239.5
const SKY_ROWS=80
const PANEL={u0:200,u1:440,v0:150,v1:400,depthM:2.5}
const BACKGROUND_M=8.0
/** 图 A 的真值映射：1/d = 1.5*relative + 0.05（测试自己定的，provider 不知道）。 */
const SCALE_TRUTH=1.5,SHIFT_TRUTH=0.05
/** 图 B 的真值映射：**同一真实几何**，但故意换成另一组 affine（scale 与 shift 都不同）。 */
const SCALE_TRUTH_B=0.5,SHIFT_TRUTH_B=0.02
const relativeOf=(depthM:number)=>(1/depthM-SHIFT_TRUTH)/SCALE_TRUTH
const relativeOfB=(depthM:number)=>(1/depthM-SHIFT_TRUTH_B)/SCALE_TRUTH_B
const depthOfRelative=(relative:number)=>1/(SCALE_TRUTH*relative+SHIFT_TRUTH)
function truthDepthM(u:number,v:number):number|null{
  if(v<SKY_ROWS)return null
  if(u>=PANEL.u0&&u<PANEL.u1&&v>=PANEL.v0&&v<PANEL.v1)return PANEL.depthM
  return BACKGROUND_M
}
/** 绕 Y 轴旋转矩阵（R^T=R(-θ)、det=+1；与 sim worker 的 world = R*p_cam + t 同约定）。 */
function rotationY(theta:number){const c=Math.cos(theta),s=Math.sin(theta);return [[c,0,s],[0,1,0],[-s,0,c]]}
const ROTATION=rotationY(0.25)
const POSITION=[1.5,1.2,-3.0]
const POSITION_2=[2.0,1.2,-3.0]
const DELTA_POSITION=[POSITION_2[0]-POSITION[0],0,0]
/** 稳定的小噪声：让最小二乘真的是拟合（而不是照抄真值），又不至于让 1% 的判据飘掉。 */
function noiseAt(index:number){return ((((index*1103515245+12345)>>>8)%1000)/1000-0.5)*2e-4}
function buildField(relative:(depthM:number)=>number){
  const field=new Float32Array(WIDTH*HEIGHT)
  for(let v=0;v<HEIGHT;v++)for(let u=0;u<WIDTH;u++){
    const truth=truthDepthM(u,v)
    field[v*WIDTH+u]=truth===null?0:relative(truth)+noiseAt(v*WIDTH+u)
  }
  return field
}
const syntheticDepth=buildField(relativeOf)
/** 图 B：同一 truthDepthM 生成的另一组相对值（同一几何、不同 affine）。 */
const syntheticDepthB=buildField(relativeOfB)
function fixtureMetadata(scaleNote:string){
  return JSON.stringify({
    schema:'lyapunov.depth-estimation/1',
    depth:{relative:true,metric:false,largerMeans:'closer',scale:scaleNote},
    sizes:{fullDepth:{width:WIDTH,height:HEIGHT},input:{width:WIDTH,height:HEIGHT}},
    image:{path:'synthetic://fixture',width:WIDTH,height:HEIGHT},
    model:{modelId:'synthetic-fixture',revision:'fixture','revisionSource':'manual'},
  },null,2)
}
const syntheticNpy=join(fixtures,'syn-depth.npy')
const syntheticMetadataPath=join(fixtures,'syn-depth-metadata.json')
const syntheticNpyB=join(fixtures,'syn-depth-b.npy')
const syntheticMetadataPathB=join(fixtures,'syn-depth-b-metadata.json')
const syntheticPhoto=join(fixtures,'syn-photo.png')
await writeFile(syntheticNpy,npyBuffer(HEIGHT,WIDTH,syntheticDepth))
await writeFile(syntheticNpyB,npyBuffer(HEIGHT,WIDTH,syntheticDepthB))
await writeFile(syntheticMetadataPath,fixtureMetadata('合成夹具 A：relative=(1/d-0.05)/1.5'))
await writeFile(syntheticMetadataPathB,fixtureMetadata('合成夹具 B：同一几何、另一组 affine relative=(1/d-0.02)/0.5'))
// 合成"照片"：颜色=R(u%256) G(v%256) B(128)，用来验证顶点颜色确实取自原图像元（按像元取，不做插值）。
await writeFile(syntheticPhoto,encodePng(WIDTH,HEIGHT,(u,v)=>[u%256,v%256,128]))
const photoColorAt=(u:number,v:number)=>[u%256,v%256,128]

function cameraOf(position:number[]):Record<string,unknown>{return {positionM:position,rotationMatrix:ROTATION}}
function imageEntry(options:{npy?:string;metadata?:string;photo?:string|null;position?:number[];distortion?:number[]|Record<string,number>;registration?:Record<string,unknown>;width?:number;height?:number}={}){
  return {
    relativeDepth:{path:options.npy??syntheticNpy},
    metadata:{path:options.metadata??syntheticMetadataPath},
    ...options.photo===null?{}:{photo:{path:options.photo??syntheticPhoto}},
    intrinsics:{fx:FX,fy:FY,cx:CX,cy:CY,width:options.width??WIDTH,height:options.height??HEIGHT,...options.distortion?{distortion:options.distortion}:{}},
    worldFromCamera:cameraOf(options.position??POSITION),
    ...options.registration?{registration:options.registration}:{},
  }
}
/** 图 B 的条目：同一相机位姿（同一真实几何），只是相对深度来自另一组 affine。 */
const imageEntryB=(options:Parameters<typeof imageEntry>[0]={})=>imageEntry({npy:syntheticNpyB,metadata:syntheticMetadataPathB,...options})
const TRAIN_ANCHORS=[
  {pixel:[100,300],depthM:8.0,note:'合成真值：背景平面'},
  {pixel:[320,200],depthM:2.5,note:'合成真值：前景板'},
  {pixel:[500,420],depthM:8.0,note:'合成真值：背景平面'},
]
const CHECK_ANCHORS=[
  {pixel:[60,100],depthM:8.0,note:'合成真值：独立 check 锚点'},
  {pixel:[400,250],depthM:2.5,note:'合成真值：独立 check 锚点'},
]
/** 图 B 的锚点：不同像元（否则就是"借用同一批点"），深度同样来自合成真值。 */
const TRAIN_ANCHORS_B=[
  {pixel:[120,320],depthM:8.0,imageIndex:1,note:'图 B：背景平面'},
  {pixel:[300,220],depthM:2.5,imageIndex:1,note:'图 B：前景板'},
  {pixel:[520,400],depthM:8.0,imageIndex:1,note:'图 B：背景平面'},
]
const CHECK_ANCHORS_B=[
  {pixel:[80,120],depthM:8.0,imageIndex:1,note:'图 B：独立 check'},
  {pixel:[420,360],depthM:2.5,imageIndex:1,note:'图 B：独立 check'},
]

// ---------------------------------------------------------------- 独立几何核对
/** 世界点 → 相机坐标 → 像元（严格按 camera x 右/y 上/看向 -z 与 K 像素左上 x 右 y 下）。 */
function projectToCamera(position:number[],point:ArrayLike<number>,rotation:number[][]){
  const delta=[point[0]!-position[0]!,point[1]!-position[1]!,point[2]!-position[2]!]
  const camera=[0,1,2].map(axis=>rotation[0]![axis]!*delta[0]+rotation[1]![axis]!*delta[1]+rotation[2]![axis]!*delta[2])
  const axial=-camera[2]!
  return {axial,u:CX+FX*camera[0]!/axial,v:CY-FY*camera[1]!/axial}
}
function bilinear(field:Float32Array,width:number,height:number,u:number,v:number){
  const x=Math.min(Math.max(u,0),width-1),y=Math.min(Math.max(v,0),height-1)
  const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(x0+1,width-1),y1=Math.min(y0+1,height-1)
  const fx=x-x0,fy=y-y0
  return field[y0*width+x0]!*(1-fx)*(1-fy)+field[y0*width+x1]!*fx*(1-fy)+field[y1*width+x0]!*(1-fx)*fy+field[y1*width+x1]!*fx*fy
}
/**
 * GLB 顶点 → 产品世界坐标：导出侧按 glTF 标准把 Z-up 世界写成 Y-up（(x,y,z)→(x,z,-y)），
 * 所以读回来必须做同一份映射的逆：(X,Y,Z)→(X,-Z,Y)。这条也是"轴没写错"的独立判据。
 */
const glbToWorld=(point:ArrayLike<number>):number[]=>[point[0]!, -point[2]!, point[1]!]
/** 相机坐标 p_cam = [(u-cx)*d/fx, -(v-cy)*d/fy, -d]。 */
const cameraPointOf=(u:number,v:number,d:number):number[]=>[(u-CX)*d/FX,-(v-CY)*d/FY,-d]
/** 只旋转：products 世界 = R * p_cam（不加平移）。 */
const rotateToWorld=(point:ArrayLike<number>):number[]=>[0,1,2].map(row=>ROTATION[row]![0]!*point[0]!+ROTATION[row]![1]!*point[1]!+ROTATION[row]![2]!*point[2]!)
/** 反向：世界（只旋转）→ 相机坐标（R 正交，p_cam = R^T q）。 */
const unrotateToCamera=(point:ArrayLike<number>):number[]=>[0,1,2].map(axis=>ROTATION[0]![axis]!*point[0]!+ROTATION[1]![axis]!*point[1]!+ROTATION[2]![axis]!*point[2]!)
/** 测试自己算的二参数最小二乘（1/d = s*r + b）：反例夹具要用它来构造"恰好通过的 check"。 */
function fitInverse(pairs:Array<{relative:number;depthM:number}>){
  let sumR=0,sumT=0,sumRR=0,sumRT=0
  for(const pair of pairs){const t=1/pair.depthM;sumR+=pair.relative;sumT+=t;sumRR+=pair.relative*pair.relative;sumRT+=pair.relative*t}
  const n=pairs.length,denominator=n*sumRR-sumR*sumR
  assert(Math.abs(denominator)>1e-12,'测试侧拟合退化（相对值跨度太小）')
  return {scale:(n*sumRT-sumR*sumT)/denominator,shift:(sumT*sumRR-sumR*sumRT)/denominator}
}
const predictDepth=(relative:number,fit:{scale:number;shift:number})=>1/(fit.scale*relative+fit.shift)

interface RunOutcome{status:string;output:string;report?:Record<string,any>}
async function run(request:Record<string,unknown>,config:Record<string,unknown>={},signal=new AbortController().signal){
  return await runDepthGeometry(ctx.subprocess,{python,dataDirectory:outputRoot,...config},request,signal)
}
function errorCodeOf(runResult:{output:string}){
  const parsed=JSON.parse(runResult.output) as {error?:{code?:string}}
  return String(parsed.error?.code??'')
}
/** report 按结构化读数用（src 里存的是 unknown，测试按已知结构读，读不到就是失败）。 */
function reportOf(runResult:RunOutcome):Record<string,any>{
  assert(runResult.report,'运行没有 report')
  return runResult.report as Record<string,any>
}
/** 逐图判定条目（新版合同：calibration.images[i] 才是每图自己的标定）。 */
function imageCalibration(report:Record<string,any>,index:number):Record<string,any>{
  const entry=report.calibration?.images?.[index]
  assert(entry,`calibration.images[${index}] 不存在`)
  return entry
}
function artifactOf(report:Record<string,any>,type:string):Record<string,any>{
  const artifact=report.artifacts.find((item:any)=>item.type===type)
  assert(artifact,'缺少产物 '+type+'（实际 '+report.artifacts.map((item:any)=>item.type).join(',')+'）')
  return artifact
}

// ---------------------------------------------------------------- 原生装配
const ctx=new Context()
// 原生服务本体（不是替身）：subprocess 提供进程通道，systemPrompt 是 dsh-tools 的 inject 前置，
// 缺 tools 注册不了工具，缺 commands 验不了命令面。
await ctx.plugin(LocalSubprocess)
await ctx.plugin(SystemPrompt)
await ctx.plugin(Tools)
await ctx.plugin(Commands)
const disposeGeometry=registerDepthGeometryTools(ctx,{python,dataDirectory:outputRoot})
const toolAgent={session:{header:{cwd:fixtures}}} as never
async function callTool(args:Record<string,unknown>){
  return await ctx.tools.execute({callId:ToolCallId('depth-geometry-test'),name:'depth_geometry',arguments:args,signal:new AbortController().signal,agent:toolAgent})
}
function toolValue(result:ToolExecutionResult){return result.value as unknown as {result:string;report:Record<string,any>}|undefined}

console.log('驱动: '+python+'\n脚本: '+defaultGeometryScript+'\n真实深度: '+realDepthNpy+'\n真实照片: '+realPhoto+'\n产物: '+scratch+'\n')
console.log('[1] 夹具自检（真值、npy 与 metadata 对得上；两幅图同几何不同 affine）')
await check('合成 npy 与 metadata 自洽，且真值映射在夹具上可复算',async()=>{
  const read=await readNpy(syntheticNpy)
  assert(read.dtype==='<f4'&&read.shape[0]===HEIGHT&&read.shape[1]===WIDTH,'夹具 npy 形状/dtype 不对: '+JSON.stringify({shape:read.shape,dtype:read.dtype}))
  const field=read.float!
  approx(depthOfRelative(field[300*WIDTH+100]!),8.0,1e-3,'背景像元反算深度')
  approx(depthOfRelative(field[200*WIDTH+320]!),2.5,2e-3,'前景像元反算深度')
  assert(field[40*WIDTH+320]===0,'天空行必须是 0（无深度证据）')
  const metadata=JSON.parse(await readFile(syntheticMetadataPath,'utf8')) as Record<string,any>
  assert(metadata.schema==='lyapunov.depth-estimation/1'&&metadata.depth.relative===true&&metadata.depth.metric===false,'夹具 metadata 语义不对')
  assert(metadata.sizes.fullDepth.width===WIDTH&&metadata.sizes.fullDepth.height===HEIGHT,'夹具 metadata 尺寸不对')
})
await check('两幅夹具是同一真实几何、两组不同 affine（拿 A 的映射解释 B 会明显错）',async()=>{
  const fieldA=(await readNpy(syntheticNpy)).float!,fieldB=(await readNpy(syntheticNpyB)).float!
  const pixel=300*WIDTH+100
  assert(fieldA[pixel]!>0&&fieldB[pixel]!>0,'两幅图都应有该像元的相对值')
  const truthB=1/(SCALE_TRUTH_B*fieldB[pixel]!+SHIFT_TRUTH_B)
  approx(truthB,8.0,1e-2,'图 B 自己的 affine 应精确还原同一背景深度')
  assert(Math.abs(fieldA[pixel]!-fieldB[pixel]!)>0.02,'两幅图的相对值必须明显不同（否则测不出"共享尺度"的错误）: '+JSON.stringify({a:fieldA[pixel],b:fieldB[pixel]}))
  // 用 A 的 affine 解释 B 的同一像元：背景会被算成 ~2.7 m 而不是 8 m，方向与幅度都够明显。
  assert(Math.abs(depthOfRelative(fieldB[pixel]!)-8.0)>2,'错用 A 的 affine 的偏差太小，反例没有力度: '+depthOfRelative(fieldB[pixel]!))
})

console.log('[2] 单图已知相机 / 已知几何：逐图标定与产物数值（独立比对）')
let syntheticReport:Record<string,any>|undefined
await check('3 训练锚点 + 2 独立 check 锚点：本图 scale/shift 收敛到真值，verdict=verified',async()=>{
  const runResult=await run({requestId:'syn-calibrated',images:[imageEntry()],anchors:{train:TRAIN_ANCHORS,check:CHECK_ANCHORS},params:{sampleStep:8}})
  assert(runResult.status==='completed','运行未完成: '+runResult.output.slice(0,400))
  const report=reportOf(runResult)
  syntheticReport=report
  const calibration=report.calibration,entry=imageCalibration(report,0)
  assert(entry.metric===true&&entry.units==='meters','没有给出米制产物: '+JSON.stringify({metric:entry.metric,units:entry.units}))
  assert(entry.verdict==='verified'&&entry.accepted===true,'独立锚点均在容差内应为 verified: '+String(entry.reason))
  assert(report.calibration.accepted===true&&report.calibration.verdict==='verified','顶层汇总应为 verified（单图时与逐图一致）: '+JSON.stringify({verdict:calibration.verdict,accepted:calibration.accepted}))
  approx(entry.scale,SCALE_TRUTH,2e-3,'本图拟合 scale')
  approx(entry.shift,SHIFT_TRUTH,2e-3,'本图拟合 shift')
  assert(entry.train.count===3&&entry.check.count===2,'训练/独立锚点计数不对: '+JSON.stringify({train:entry.train.count,check:entry.check.count}))
  assert(entry.train.maxRelativeError<=0.01,'训练锚点残差异常大: '+String(entry.train.maxRelativeError))
  assert(entry.check.maxRelativeError<=calibration.toleranceRelativeError,'独立锚点残差超容差: '+String(entry.check.maxRelativeError))
  // 训练与独立 check 必须是**两份**残差（同一条数字不能既当训练又当核对）。
  assert(JSON.stringify(entry.train.items)!==JSON.stringify(entry.check.items),'训练与 check 的残差项相同，说明没有分开报告')
  for(const item of entry.check.items){
    assert(Number.isFinite(item.residualM)&&Number.isFinite(item.rayDistanceM),'check 锚点残差含非有限值: '+JSON.stringify(item))
    assert(item.rayDistanceM>=item.axialDepthM,'射线距离必须 >= 轴向深度（射线因子 >= 1）: '+JSON.stringify(item))
  }
})

await check('掩码口径与像元数由独立读数核对（天空 51200 像元无深度证据）',async()=>{
  const report=syntheticReport!
  const mask=await readNpy(artifactOf(report,'depth.mask.npy-i0').path)
  assert((mask.dtype==='|u1'||mask.dtype==='<u1')&&mask.shape[0]===HEIGHT&&mask.shape[1]===WIDTH,'掩码 npy 形状/dtype 不对: '+JSON.stringify({shape:mask.shape,dtype:mask.dtype}))
  let zero=0,nonzero=0,skyMasked=0,panelOk=0
  for(let v=0;v<HEIGHT;v++)for(let u=0;u<WIDTH;u++){
    const code=mask.bytes![v*WIDTH+u]!
    if(code===0)zero++;else nonzero++
    if(v<SKY_ROWS&&code!==0)skyMasked++
    if(u>=PANEL.u0&&u<PANEL.u1&&v>=PANEL.v0&&v<PANEL.v1&&code===0)panelOk++
  }
  assert(nonzero===SKY_ROWS*WIDTH,'掩码非 0 像元数应为天空行: '+String(nonzero))
  assert(skyMasked===SKY_ROWS*WIDTH,'天空行有像元被当成有效深度: '+String(skyMasked))
  assert(panelOk===(PANEL.u1-PANEL.u0)*(PANEL.v1-PANEL.v0),'前景板有效像元数不对: '+String(panelOk))
  assert(report.mask.counts.nonpositive_relative===SKY_ROWS*WIDTH,'report 的掩码计数与独立读数不一致: '+JSON.stringify(report.mask.counts))
  assert(report.mask.totalPixels===WIDTH*HEIGHT,'总像元数不对: '+String(report.mask.totalPixels))
  assert(zero+nonzero===WIDTH*HEIGHT,'掩码没有覆盖全部像元')
})

await check('米制 npy 的每个有效像元都等于真值映射（独立重算，不看 report）',async()=>{
  const report=syntheticReport!
  const metric=await readNpy(artifactOf(report,'depth.metric.npy-i0').path)
  const mask=await readNpy(artifactOf(report,'depth.mask.npy-i0').path)
  assert(metric.dtype==='<f4'&&metric.shape[0]===HEIGHT,'米制 npy 形状/dtype 不对')
  let checked=0,worst=0
  for(let v=0;v<HEIGHT;v+=3)for(let u=0;u<WIDTH;u+=3){
    const code=mask.bytes![v*WIDTH+u]!
    const value=metric.float![v*WIDTH+u]!
    if(code!==0){assert(Number.isNaN(value),`掩码非 0 的像元必须是 NaN: (${u},${v}) = ${value}`);continue}
    const expected=depthOfRelative(syntheticDepth[v*WIDTH+u]!)
    const relativeError=Math.abs(value-expected)/expected
    worst=Math.max(worst,relativeError);checked++
    assert(relativeError<=0.01,`像元 (${u},${v}) 米制深度 ${value} 与真值 ${expected} 差 ${relativeError}`)
  }
  assert(checked>20000,'抽样太少，不足以说明问题: '+String(checked))
  console.log('      抽样 '+checked+' 个有效像元，最大相对误差 '+worst.toExponential(4))
})

/** 独立审计一个 primitive：世界→像元→真值映射，比对轴向深度；顺带量最小投影行与三角面跨度。 */
function auditVertices(primitive:GlbPrimitive,position:number[],field:Float32Array,depthFrom:(relative:number)=>number,label:string){
  let worst=0,minV=Infinity,sampled=0
  const depths:number[]=[]
  for(let index=0;index<primitive.count;index++){
    const point=glbToWorld([primitive.vertices[index*3]!,primitive.vertices[index*3+1]!,primitive.vertices[index*3+2]!])
    const projected=projectToCamera(position,point,ROTATION)
    assert(projected.axial>0,`${label}: 顶点落在相机后方 ${JSON.stringify(point)}`)
    minV=Math.min(minV,projected.v)
    const expected=depthFrom(bilinear(field,WIDTH,HEIGHT,projected.u,projected.v))
    const error=Math.abs(projected.axial-expected)/expected
    worst=Math.max(worst,error);depths.push(projected.axial);sampled++
    assert(error<=0.01,`${label}: 顶点轴向深度 ${projected.axial} 与真值 ${expected} 差 ${error}（像元 ${projected.u},${projected.v}）`)
  }
  assert(sampled===primitive.count&&sampled>0,`${label}: 没有比对到任何顶点`)
  return {worst,minV,depths,sampled}
}
/** 三角面跨度：任何面都不得跨过遮挡跳变（前景 2.5 m 与背景 8 m 差 ~220%）。 */
function auditTriangles(primitive:GlbPrimitive,depths:number[],label:string){
  const indices=primitive.indices
  assert(indices&&indices.length%3===0&&indices.length>0,`${label}: GLB 缺 indices`)
  let worstSpread=0,triangles=0
  for(let triangle=0;triangle<indices.length;triangle+=3){
    const values=[0,1,2].map(offset=>depths[indices[triangle+offset]!]!)
    assert(values.every(value=>value!==undefined),`${label}: 索引越界`)
    const min=Math.min(...values),max=Math.max(...values)
    worstSpread=Math.max(worstSpread,(max-min)/min);triangles++
  }
  return {worstSpread,triangles}
}

await check('米制 GLB：顶点落在真值几何上、无天空顶点、无三角面跨遮挡跳变、按 glTF Y-up 导出',async()=>{
  const report=syntheticReport!
  const glb=await readGlb(artifactOf(report,'geometry.meters.glb').path)
  assert(glb.primitives.length===1,'单图应只有一个 primitive: '+String(glb.primitives.length))
  const primitive=glb.primitives[0]!
  assert(report.geometry.primitives[0].vertices===primitive.count,'report 顶点数与独立解析不一致: '+JSON.stringify({report:report.geometry.primitives[0].vertices,glb:primitive.count}))
  // 采样步长 8 的格点里，天空行（v<80，共 10 行 x 80 列）必须一个顶点都没有。
  assert(primitive.count===4000,'顶点数应为 4000（4800 格点 − 800 天空格点），实际 '+String(primitive.count))
  const audit=auditVertices(primitive,POSITION,syntheticDepth,depthOfRelative,'米制 GLB')
  assert(audit.minV>=SKY_ROWS-0.5,'天空行出现了顶点（遮挡/无证据像元必须不建面）: minV='+String(audit.minV))
  console.log('      '+audit.sampled+' 个顶点最大相对误差 '+audit.worst.toExponential(4)+'；最小投影行 v='+audit.minV.toFixed(2))
  const triangles=auditTriangles(primitive,audit.depths,'米制 GLB')
  assert(triangles.triangles===report.geometry.primitives[0].triangles,'三角面数与 report 不一致')
  assert(triangles.worstSpread<=0.101,'有三角面跨过了遮挡跳变（跨度 '+(triangles.worstSpread*100).toFixed(1)+'%）')
  console.log('      '+triangles.triangles+' 个三角面最大轴向跨度 '+(triangles.worstSpread*100).toFixed(2)+'%')
  // 顶点坐标是米制世界坐标：背景 8 m 与前景 2.5 m 都得在（不是被压到 0..1 的归一化盒子里）。
  assert(audit.depths.some(depth=>depth>5)&&audit.depths.some(depth=>depth<5),'米制顶点深度分布不合理: '+JSON.stringify([Math.min(...audit.depths),Math.max(...audit.depths)]))
  // 轴：extras 自述 Y-up，且**直接**把 GLB 顶点当世界坐标用会明显错（证明导出真的做了转换，不是只写了个字段）。
  assert(glb.extras.sourceUpAxis==='Y'&&String(glb.extras.axisExport).includes('Y-up'),'GLB extras 没有如实标注 Y-up 导出: '+JSON.stringify({up:glb.extras.sourceUpAxis}))
  assert(primitive.extras.imageIndex===0&&primitive.extras.units==='meters'&&primitive.extras.verdict==='verified','primitive extras 没带逐图单位/判定: '+JSON.stringify(primitive.extras))
  let rawWorst=0
  for(let index=0;index<primitive.count;index+=17){
    const raw=[primitive.vertices[index*3]!,primitive.vertices[index*3+1]!,primitive.vertices[index*3+2]!]
    const converted=glbToWorld(raw)
    const distance=Math.hypot(raw[0]!-converted[0]!,raw[1]!-converted[1]!,raw[2]!-converted[2]!)
    rawWorst=Math.max(rawWorst,distance)
  }
  assert(rawWorst>0.5,'GLB 顶点看起来就是 Z-up 世界坐标（Y-up 转换没生效）: 最大差值 '+rawWorst)
})

await check('顶点颜色取自原照片像元（独立按像元核对 RGB）',async()=>{
  const report=syntheticReport!
  const glb=await readGlb(artifactOf(report,'geometry.meters.glb').path)
  const primitive=glb.primitives[0]!
  assert(primitive.colors,'GLB 缺 COLOR_0（照片给了却没颜色）')
  let matched=0,mismatched=0
  for(let index=0;index<primitive.count;index+=37){
    const point=glbToWorld([primitive.vertices[index*3]!,primitive.vertices[index*3+1]!,primitive.vertices[index*3+2]!])
    const projected=projectToCamera(POSITION,point,ROTATION)
    const u=Math.round(projected.u),v=Math.round(projected.v)
    const expected=photoColorAt(u,v)
    // COLOR_0 是 normalized uint8（VEC3，每顶点 3 个分量）：解析出来是 0..1 的浮点，比对前回到 0..255 刻度。
    const step=primitive.colorComponents
    const actual=[0,1,2].map(part=>Math.round(primitive.colors![index*step+part]!*255))
    if(actual[0]===expected[0]&&actual[1]===expected[1]&&actual[2]===expected[2])matched++;else mismatched++
  }
  assert(mismatched===0,'顶点颜色与原照片像元不符: 不符 '+mismatched+' 个（匹配 '+matched+'）')
  assert(matched>50,'颜色核对样本太少: '+matched)
  assert(report.images[0].photo.usedForVertexColor===true,'来源说明没有记下照片确实用于顶点颜色')
})
console.log('[3] 没有尺度就只能相对：逆深度预览（1/relative 假定、只旋转不平移、不混单位）')
let relativeReport:Record<string,any>|undefined
await check('无锚点：verdict=insufficient-anchors、units=relative、没有米制 npy，只有带 assumed 标记的预览 GLB',async()=>{
  const runResult=await run({requestId:'syn-relative',images:[imageEntry()],params:{sampleStep:8}})
  assert(runResult.status==='completed','运行未完成: '+runResult.output.slice(0,300))
  const report=reportOf(runResult)
  relativeReport=report
  assert(report.geometry.units==='relative'&&report.calibration.metric===false&&report.geometry.combined===null,'无锚点却给了米制/合并产物: '+JSON.stringify({units:report.geometry.units,metric:report.calibration.metric,combined:report.geometry.combined}))
  const entry=imageCalibration(report,0)
  assert(entry.verdict==='insufficient-anchors'&&entry.accepted===false,'判定应为 insufficient-anchors/accepted=false: '+JSON.stringify({verdict:entry.verdict}))
  assert(entry.scale===null&&entry.shift===null,'没有标定却报出了 scale/shift: '+JSON.stringify({scale:entry.scale}))
  assert(!('checkAnchorsIndependent' in entry),'旧的 checkAnchorsIndependent 字段必须消失（它是硬写的声明）')
  const types=report.artifacts.map((item:any)=>item.type)
  assert(!types.some((type:string)=>type.startsWith('depth.metric.npy')),'无锚点却写出了米制 npy: '+types.join(','))
  assert(types.includes('geometry.relative.preview.glb-i0'),'缺相对预览产物: '+types.join(','))
  assert(report.gaps.some((gap:string)=>gap.includes('METRIC_NOT_AVAILABLE'))&&report.gaps.some((gap:string)=>gap.includes('RELATIVE_PREVIEW_ONLY')),'缺口没有写明米制不可用/只出预览: '+JSON.stringify(report.gaps))
  const glb=await readGlb(artifactOf(report,'geometry.relative.preview.glb-i0').path)
  assert(glb.extras.units==='relative'&&glb.extras.calibrated===false&&glb.extras.assumed===true,'相对预览必须标明 assumed 且未标定: '+JSON.stringify({units:glb.extras.units,calibrated:glb.extras.calibrated,assumed:glb.extras.assumed}))
  assert(glb.extras.notForMetricUse===true&&String(glb.extras.sceneImportNote).includes('不是米制'),'相对预览必须写明不得当米制使用')
  assert(String(glb.extras.assumedMapping).includes('1 / relative'),'必须写明逆深度预览的假定: '+String(glb.extras.assumedMapping))
  assert(glb.extras.translationApplied===false,'相对预览不得加米制平移: '+JSON.stringify(glb.extras.translationApplied))
})
await check('相对预览的几何按 1/relative 且只用旋转（近远顺序与相对值一致：越大越近）',async()=>{
  const report=relativeReport!
  const glb=await readGlb(artifactOf(report,'geometry.relative.preview.glb-i0').path)
  const primitive=glb.primitives[0]!
  const pairs:Array<[number,number]>=[]
  let worstPreview=0,worstRotation=0,worstTranslation=0
  for(let index=0;index<primitive.count;index++){
    const q=glbToWorld([primitive.vertices[index*3]!,primitive.vertices[index*3+1]!,primitive.vertices[index*3+2]!])
    const camera=unrotateToCamera(q)
    const axial=-camera[2]!
    assert(axial>0,'相对预览顶点落在相机后方: '+JSON.stringify(q))
    const u=CX+FX*camera[0]!/axial,v=CY-FY*camera[1]!/axial
    const relative=bilinear(syntheticDepth,WIDTH,HEIGHT,u,v)
    const expected=1/relative
    worstPreview=Math.max(worstPreview,Math.abs(axial-expected)/expected)
    // 只旋转的期望位置：p_cam(该像元, 该深度) → R*p_cam；若 provider 把 positionM 也加上了，这里会整体偏 |t|。
    const rotated=rotateToWorld(cameraPointOf(u,v,expected))
    worstRotation=Math.max(worstRotation,Math.hypot(q[0]!-rotated[0]!,q[1]!-rotated[1]!,q[2]!-rotated[2]!))
    worstTranslation=Math.max(worstTranslation,Math.hypot(q[0]!-rotated[0]!-POSITION[0]!,q[1]!-rotated[1]!-POSITION[1]!,q[2]!-rotated[2]!-POSITION[2]!))
    pairs.push([relative,axial])
  }
  assert(pairs.length>100,'相对预览顶点太少: '+String(pairs.length))
  assert(worstPreview<=0.01,'相对预览顶点不等于 1/relative: 最大相对偏差 '+worstPreview)
  assert(worstRotation<=1e-3,'相对预览顶点不是"只旋转"的位置: 最大偏差 '+worstRotation)
  // 上面两条已经说明位置=只旋转；这条说明"若把米制平移也加上"会是多大差距（镜像地证明平移没被加）。
  assert(worstTranslation>1,'夹具的米制平移太小，测不出"是否加了平移": '+worstTranslation)
  pairs.sort((left,right)=>right[0]-left[0])
  let inversions=0
  for(let index=1;index<pairs.length;index++){
    if(pairs[index]![1]<pairs[index-1]![1]*(1-1e-4))inversions++
  }
  assert(inversions===0,'相对值越大必须越近（轴向深度越小）；出现 '+inversions+' 处相反顺序（近远写反了）')
  console.log('      '+pairs.length+' 个预览顶点：轴向深度 '+pairs[pairs.length-1]![1].toFixed(3)+'..'+pairs[0]![1].toFixed(3)+'（单位 relative）；与 1/relative 最大偏差 '+worstPreview.toExponential(2))
})
await check('两图都没有尺度：各自一份相对预览、combined=null，绝不把两组 relative 拼进同一个世界',async()=>{
  const runResult=await run({requestId:'syn-relative-two',images:[imageEntry({registration:{frameId:'frame-rel'}}),imageEntryB({registration:{frameId:'frame-rel'}})],params:{sampleStep:16}})
  assert(runResult.status==='completed','运行未完成: '+runResult.output.slice(0,300))
  const report=reportOf(runResult)
  assert(report.geometry.units==='relative'&&report.geometry.combined===null,'两图都没尺度时不得有米制合并产物: '+JSON.stringify({units:report.geometry.units,combined:report.geometry.combined}))
  assert(report.geometry.relativePreviews.map((item:any)=>item.imageIndex).join(',')==='0,1','预览必须逐图一份: '+JSON.stringify(report.geometry.relativePreviews.map((item:any)=>item.imageIndex)))
  const previews=await Promise.all([0,1].map(index=>readGlb(artifactOf(report,`geometry.relative.preview.glb-i${index}`).path)))
  for(const [index,glb] of previews.entries()){
    assert(glb.primitives.length===1,`预览 i${index} 应只有一个 primitive（不混别的图）: ${glb.primitives.length}`)
    assert(glb.primitives[0]!.extras.imageIndex===index,`预览 i${index} 的 primitive extras.imageIndex 不对: ${JSON.stringify(glb.primitives[0]!.extras)}`)
    assert(glb.extras.units==='relative'&&glb.extras.calibrated===false,`预览 i${index} 必须标 relative/未标定`)
  }
  // 同一像元的轴向深度必须按各自的相对值：两幅图 affine 不同，比值应明显不是 1。
  const axialOf=(glb:Glb)=>{
    const values:number[]=[]
    for(let index=0;index<glb.primitives[0]!.count;index++){
      const camera=unrotateToCamera(glbToWorld([glb.primitives[0]!.vertices[index*3]!,glb.primitives[0]!.vertices[index*3+1]!,glb.primitives[0]!.vertices[index*3+2]!]))
      values.push(-camera[2]!)
    }
    return values
  }
  const first=axialOf(previews[0]!),second=axialOf(previews[1]!)
  assert(first.length===second.length&&first.length>0,'两份预览的格点数应一致: '+JSON.stringify([first.length,second.length]))
  let deviated=0
  for(let index=0;index<first.length;index++)if(Math.abs(second[index]!/first[index]!-1)>0.5)deviated++
  assert(deviated>first.length*0.9,'两组 relative 若被当成同一世界的同一尺度，同像元深度会几乎相同: 只 '+deviated+'/'+first.length+' 明显不同')
  console.log('      '+first.length+' 个同格点：图 B/图 A 的预览轴向深度比偏离 1 的有 '+deviated+' 个（两图各自独立，未拼世界）')
})

console.log('[4] 逐图独立标定（同一真实几何、两组不同 affine）')
let perImageReport:Record<string,any>|undefined
/** 图 A 有标定、图 B 没有（mixed 单位）的那次运行，后面合同篡改用它。 */
let mixedReport:Record<string,any>|undefined
await check('两图各有自己的锚点：各自恢复自己的 scale/shift，合并 GLB 两个 primitive 都落在真值几何上',async()=>{
  const runResult=await run({requestId:'syn-per-image',images:[imageEntry({registration:{frameId:'frame-pair'}}),imageEntryB({registration:{frameId:'frame-pair'}})],anchors:{train:[...TRAIN_ANCHORS,...TRAIN_ANCHORS_B],check:[...CHECK_ANCHORS,...CHECK_ANCHORS_B]},params:{sampleStep:8}})
  assert(runResult.status==='completed','逐图标定运行未完成: '+runResult.output.slice(0,400))
  const report=reportOf(runResult)
  perImageReport=report
  const first=imageCalibration(report,0),second=imageCalibration(report,1)
  assert(first.metric&&second.metric,'两图都应有自己的米制标定: '+JSON.stringify([first.metric,second.metric]))
  assert(first.verdict==='verified'&&second.verdict==='verified'&&first.accepted&&second.accepted,'两图都应 verified: '+JSON.stringify([first.verdict,second.verdict]))
  approx(first.scale,SCALE_TRUTH,2e-3,'图 A 拟合 scale')
  approx(first.shift,SHIFT_TRUTH,2e-3,'图 A 拟合 shift')
  approx(second.scale,SCALE_TRUTH_B,5e-4,'图 B 拟合 scale')
  approx(second.shift,SHIFT_TRUTH_B,5e-4,'图 B 拟合 shift')
  assert(Math.abs(first.scale-second.scale)>0.5&&Math.abs(first.shift-second.shift)>0.01,'两图的 scale/shift 必须分别恢复（不能是同一个共享拟合）: '+JSON.stringify({a:[first.scale,first.shift],b:[second.scale,second.shift]}))
  assert(report.geometry.units==='meters'&&report.calibration.summary.allImagesVerified===true&&report.calibration.accepted===true,'顶层汇总应为"全部图 verified": '+JSON.stringify(report.calibration.summary))
  const glb=await readGlb(artifactOf(report,'geometry.meters.glb').path)
  assert(glb.primitives.length===2,'合并米制 GLB 应有 2 个 primitive: '+String(glb.primitives.length))
  assert(glb.primitives[0]!.extras.imageIndex===0&&glb.primitives[1]!.extras.imageIndex===1,'primitive 的 imageIndex 顺序不对: '+JSON.stringify(glb.primitives.map(item=>item.extras.imageIndex)))
  // 独立审计：A 的顶点用 A 的真值 affine、B 的顶点用 B 的真值 affine（同一个世界坐标，同一个相机）。
  const auditFirst=auditVertices(glb.primitives[0]!,POSITION,syntheticDepth,depthOfRelative,'图 A 的 primitive')
  const auditSecond=auditVertices(glb.primitives[1]!,POSITION,syntheticDepthB,relative=>1/(SCALE_TRUTH_B*relative+SHIFT_TRUTH_B),'图 B 的 primitive')
  console.log('      图 A 顶点最大相对误差 '+auditFirst.worst.toExponential(4)+'；图 B '+auditSecond.worst.toExponential(4))
  console.log('      逐图恢复：图 A scale='+Number(first.scale).toFixed(6)+' shift='+Number(first.shift).toFixed(6)
    +'（真值 '+SCALE_TRUTH+'/'+SHIFT_TRUTH+'）；图 B scale='+Number(second.scale).toFixed(6)+' shift='+Number(second.shift).toFixed(6)
    +'（真值 '+SCALE_TRUTH_B+'/'+SHIFT_TRUTH_B+'）')
  // 反例力度：把 6 个训练锚点合成**一个**全局拟合，作用到图 B 的 check 锚点上必然超容差（旧实现就是这个行为）。
  const fieldA=(await readNpy(syntheticNpy)).float!,fieldB=(await readNpy(syntheticNpyB)).float!
  const globalFit=fitInverse([
    ...TRAIN_ANCHORS.map(anchor=>({relative:fieldA[anchor.pixel[1]!*WIDTH+anchor.pixel[0]!]!,depthM:anchor.depthM})),
    ...TRAIN_ANCHORS_B.map(anchor=>({relative:fieldB[anchor.pixel[1]!*WIDTH+anchor.pixel[0]!]!,depthM:anchor.depthM})),
  ])
  let worstGlobal=0
  for(const anchor of CHECK_ANCHORS_B){
    const predicted=predictDepth(fieldB[anchor.pixel[1]!*WIDTH+anchor.pixel[0]!]!,globalFit)
    worstGlobal=Math.max(worstGlobal,Math.abs(predicted-anchor.depthM)/anchor.depthM)
  }
  assert(worstGlobal>report.calibration.toleranceRelativeError,'全局共享拟合在反例上竟然也能过（测试没有力度）: '+worstGlobal)
  console.log('      共享拟合会在图 B 上错到 '+(worstGlobal*100).toFixed(1)+'%（远超容差 '+(Number(report.calibration.toleranceRelativeError)*100).toFixed(1)+'%）')
})
await check('某图没有自己的锚点：不借别的图的锚点变米制，米制 GLB 只含图 A，图 B 只出相对预览',async()=>{
  const runResult=await run({requestId:'syn-no-borrow',images:[imageEntry({registration:{frameId:'frame-pair'}}),imageEntryB({registration:{frameId:'frame-pair'}})],anchors:{train:TRAIN_ANCHORS,check:CHECK_ANCHORS},params:{sampleStep:16}})
  assert(runResult.status==='completed','运行未完成: '+runResult.output.slice(0,400))
  const report=reportOf(runResult)
  mixedReport=report
  const first=imageCalibration(report,0),second=imageCalibration(report,1)
  assert(first.metric&&first.verdict==='verified'&&first.accepted===true,'图 A 仍应 verified')
  assert(second.metric===false&&second.verdict==='insufficient-anchors'&&second.accepted===false,'图 B 没有自己的锚点就不得有米制: '+JSON.stringify({metric:second.metric,verdict:second.verdict}))
  assert(second.scale===null&&second.anchorsUsed.train===0,'图 B 不得借别的图的锚点: '+JSON.stringify({scale:second.scale,anchorsUsed:second.anchorsUsed}))
  assert(report.geometry.units==='mixed'&&report.calibration.accepted===false,'混合单位必须如实标注且 accepted=false: '+JSON.stringify({units:report.geometry.units,accepted:report.calibration.accepted}))
  assert(report.geometry.combined.images.join(',')==='0','米制 GLB 只允许含自己有标定的图: '+JSON.stringify(report.geometry.combined.images))
  const types=report.artifacts.map((item:any)=>item.type)
  assert(types.includes('geometry.meters.glb')&&types.includes('geometry.relative.preview.glb-i1'),'应有的产物类型: '+types.join(','))
  assert(!types.includes('depth.metric.npy-i1'),'图 B 不该有米制 npy: '+types.join(','))
  assert(report.warnings.some((warning:string)=>warning.includes('ANCHORS_NOT_SHARED')),'没有写明"不借用其它图的锚点": '+JSON.stringify(report.warnings))
  assert(report.gaps.some((gap:string)=>gap.includes('RELATIVE_PREVIEW_ONLY')),'缺口没有写明图 B 只出预览: '+JSON.stringify(report.gaps))
  const meters=await readGlb(artifactOf(report,'geometry.meters.glb').path)
  assert(meters.primitives.length===1&&meters.primitives[0]!.extras.imageIndex===0,'米制 GLB 混进了没有标定的图: '+JSON.stringify(meters.primitives.map(item=>item.extras.imageIndex)))
  const preview=await readGlb(artifactOf(report,'geometry.relative.preview.glb-i1').path)
  assert(preview.primitives.length===1&&preview.primitives[0]!.extras.imageIndex===1,'预览里混进了别的图: '+JSON.stringify(preview.primitives.map(item=>item.extras.imageIndex)))
  assert(preview.extras.units==='relative'&&meters.extras.units==='meters','两个文件的单位必须各自如实标注')
  assert(String(report.geometry.unitPolicy).includes('不合并'),'单位政策必须写明不合并: '+String(report.geometry.unitPolicy))
})
console.log('[5] 锚点独立性 / 训练自洽（check 只证"未参与拟合"，不证测量来源独立）')
await check('check 锚点与 train 锚点同图同像元 → 直接拒绝 ANCHOR_CHECK_NOT_INDEPENDENT',async()=>{
  const runResult=await run({requestId:'syn-leak',images:[imageEntry()],anchors:{train:TRAIN_ANCHORS,check:[{pixel:[100,300],depthM:8.0,note:'和 train[0] 是同一个点'}]}})
  assert(runResult.status==='failed','同一个点当独立核对竟然被接受: '+runResult.output.slice(0,200))
  assert(errorCodeOf(runResult)==='ANCHOR_CHECK_NOT_INDEPENDENT','错误码不是 ANCHOR_CHECK_NOT_INDEPENDENT: '+errorCodeOf(runResult))
  const message=String((JSON.parse(runResult.output) as {error?:{message?:string}}).error?.message??'')
  assert(message.includes('同一图同一像元')&&message.includes('独立核对'),'错误消息没写清原因与下一步: '+message.slice(0,200))
})
await check('矛盾训练锚点 + 中心 check 恰好通过 → train-inconsistent、accepted=false（check 过了也不算标定通过）',async()=>{
  // 反例构造：第三个训练锚点（背景像元）故意报 2.0 m，与前两个训练点矛盾。
  const contradictory=[TRAIN_ANCHORS[0]!,TRAIN_ANCHORS[1]!,{...TRAIN_ANCHORS[2]!,depthM:2.0,note:'故意与其它训练点矛盾'}]
  // 用测试自己的最小二乘算出"矛盾拟合"的预测，再在**中心附近另一个像元**放一个恰好落在预测上的 check。
  const field=(await readNpy(syntheticNpy)).float!
  const fit=fitInverse(contradictory.map(anchor=>({relative:field[anchor.pixel[1]!*WIDTH+anchor.pixel[0]!]!,depthM:anchor.depthM})))
  const centerPixel=[330,240]
  const centerCheck={pixel:centerPixel,depthM:predictDepth(field[centerPixel[1]!*WIDTH+centerPixel[0]!]!,fit),note:'恰好落在矛盾拟合上的 check'}
  const runResult=await run({requestId:'syn-contradictory',images:[imageEntry()],anchors:{train:contradictory,check:[centerCheck]}})
  assert(runResult.status==='completed','矛盾训练点不该让整次运行崩掉（要给判定而不是猜）: '+runResult.output.slice(0,300))
  const report=reportOf(runResult),entry=imageCalibration(report,0)
  assert(entry.verdict==='train-inconsistent','矛盾训练点必须判 train-inconsistent，实际 '+String(entry.verdict))
  assert(entry.accepted===false&&report.calibration.accepted===false,'矛盾训练点却标成已通过: '+JSON.stringify({accepted:entry.accepted}))
  assert(entry.check.count===1&&entry.check.maxRelativeError<=report.calibration.toleranceRelativeError,'反例里的 check 必须真的通过（否则测的不是这件事）: '+JSON.stringify({count:entry.check.count,max:entry.check.maxRelativeError}))
  assert(entry.train.maxRelativeError>report.calibration.toleranceRelativeError,'训练残差必须被算出来并超过容差: '+String(entry.train.maxRelativeError))
  console.log('      check 最大相对误差 '+Number(entry.check.maxRelativeError).toExponential(2)+'（通过），训练最大相对残差 '+(Number(entry.train.maxRelativeError)*100).toFixed(1)+'% → '+String(entry.verdict))
})
await check('独立 check 锚点超容差 → check-failed、accepted=false（不得当标定通过），并记警告',async()=>{
  const runResult=await run({requestId:'syn-check-fail',images:[imageEntry()],anchors:{train:TRAIN_ANCHORS,check:[{pixel:[60,100],depthM:24.0,note:'故意写错 3 倍'}]}})
  assert(runResult.status==='completed','运行未完成: '+runResult.output.slice(0,300))
  const report=reportOf(runResult),entry=imageCalibration(report,0)
  assert(entry.verdict==='check-failed','应判 check-failed，实际 '+String(entry.verdict))
  assert(entry.accepted===false&&report.calibration.accepted===false,'独立核对失败却标成已通过')
  assert(entry.check.maxRelativeError>report.calibration.toleranceRelativeError,'check 残差没有超过容差: '+String(entry.check.maxRelativeError))
  assert(report.warnings.some((warning:string)=>warning.includes('check')),'没有给出独立核对失败的警告: '+JSON.stringify(report.warnings))
  assert(report.geometry.units==='meters','米制产物仍应给出（但带 accepted=false 标记）: '+String(report.geometry.units))
  console.log('      verdict='+String(entry.verdict)+'；check 最大相对误差 '+Number(entry.check.maxRelativeError).toFixed(4))
})
await check('独立性字段只声明"未参与拟合 + 不是同一像元"，不声明测量来源统计独立',async()=>{
  const report=syntheticReport!,entry=imageCalibration(report,0)
  assert(entry.checkAnchorsUsedForFit===false,'必须明确 check 锚点未参与拟合')
  assert(entry.checkAnchorsDisjointFromTrain===true,'必须明确 check 与 train 不是同一像元')
  assert(!('checkAnchorsIndependent' in entry)&&!('checkAnchorsIndependent' in report.calibration),'不得再出现 checkAnchorsIndependent 这种硬写声明')
  const claim=String(entry.independenceClaim)
  assert(claim.includes('未参与拟合')&&claim.includes('统计独立'),'独立性声明要写清楚"只证明什么、不声明什么": '+claim)
  assert(claim.includes('不'),'独立性声明必须明确写出"不声明统计独立": '+claim)
})
await check('训练锚点全在同一像元（跨度 0）→ 不硬凑直线：退回相对预览并写明 ANCHORS_UNUSED',async()=>{
  const runResult=await run({requestId:'syn-degenerate',images:[imageEntry()],anchors:{train:[{pixel:[100,300],depthM:8},{pixel:[100,300],depthM:8}],check:CHECK_ANCHORS},params:{sampleStep:32}})
  assert(runResult.status==='completed','退化锚点应退回相对输出而不是崩: '+runResult.output.slice(0,300))
  const report=reportOf(runResult),entry=imageCalibration(report,0)
  assert(entry.verdict==='insufficient-anchors'&&entry.accepted===false,'退化锚点必须判 insufficient-anchors: '+String(entry.verdict))
  assert(report.geometry.units==='relative'&&entry.scale===null,'退化锚点不该产出米制: '+JSON.stringify({units:report.geometry.units,scale:entry.scale}))
  const warning=report.warnings.find((item:string)=>item.includes('ANCHORS_UNUSED'))
  assert(warning&&warning.includes('跨度'),'缺 ANCHORS_UNUSED 警告或没写清原因: '+JSON.stringify(report.warnings))
  assert(!report.artifacts.some((item:any)=>item.type.startsWith('depth.metric.npy')),'退化锚点不该写米制 npy')
})
await check('训练锚点方向反了（近处报远、远处报近 → 拟合 scale<=0）：不产出米制、判 train-inconsistent，且不殃及其它图',async()=>{
  const inverted=[{pixel:[100,300],depthM:2.0,note:'背景像元却报近'},{pixel:[320,200],depthM:8.0,note:'前景板像元却报远'}]
  const runResult=await run({requestId:'syn-inverted',images:[imageEntry()],anchors:{train:inverted,check:CHECK_ANCHORS},params:{sampleStep:32}})
  assert(runResult.status==='completed','单图锚点矛盾不该让整次运行崩掉（要按图给判定）: '+runResult.output.slice(0,300))
  const report=reportOf(runResult),entry=imageCalibration(report,0)
  assert(entry.metric===false&&entry.verdict==='train-inconsistent','方向反了必须判 train-inconsistent 且不给米制: '+JSON.stringify({metric:entry.metric,verdict:entry.verdict}))
  assert(entry.accepted===false&&report.calibration.accepted===false,'矛盾锚点不得 accepted')
  assert(report.geometry.units==='relative'&&report.geometry.combined===null,'方向反了不得产出米制几何: '+String(report.geometry.units))
  assert(!report.artifacts.some((item:any)=>item.type.startsWith('depth.metric.npy')),'方向反了不该写米制 npy')
  assert(report.artifacts.some((item:any)=>item.type==='geometry.relative.preview.glb-i0'),'应退回相对预览')
  const warning=report.warnings.find((item:string)=>item.includes('ANCHORS_UNUSED'))
  assert(warning&&warning.includes('语义'),'警告要写清是逆深度语义冲突: '+JSON.stringify(report.warnings))
  // 同一次请求里另一张图有自己的正确锚点 → 仍然可以米制（逐图隔离，不一起毙掉）。
  const withGoodSecond=await run({requestId:'syn-inverted-pair',images:[imageEntry({registration:{frameId:'frame-inv'}}),imageEntryB({registration:{frameId:'frame-inv'}})],anchors:{train:[...inverted,...TRAIN_ANCHORS_B.map(anchor=>({...anchor,imageIndex:1}))],check:CHECK_ANCHORS_B.map(anchor=>({...anchor,imageIndex:1}))},params:{sampleStep:32}})
  assert(withGoodSecond.status==='completed','两图请求未完成: '+withGoodSecond.output.slice(0,300))
  const pair=reportOf(withGoodSecond)
  assert(imageCalibration(pair,1).metric===true&&imageCalibration(pair,1).accepted===true,'图 1 自己的锚点没问题就该照常米制: '+JSON.stringify(imageCalibration(pair,1).verdict))
  assert(pair.geometry.combined.images.join(',')==='1','米制 GLB 只该收判定通过的那张图: '+JSON.stringify(pair.geometry.combined.images))
})
await check('单个训练锚点不足以定尺度 → 仍走相对预览（而不是硬凑一条直线）',async()=>{
  const runResult=await run({requestId:'syn-one-anchor',images:[imageEntry()],anchors:{train:[{pixel:[100,300],depthM:8.0}]},params:{sampleStep:32}})
  assert(runResult.status==='completed','单锚点运行未完成: '+runResult.output.slice(0,300))
  const report=reportOf(runResult)
  assert(imageCalibration(report,0).verdict==='insufficient-anchors','单锚点应判 insufficient-anchors: '+String(imageCalibration(report,0).verdict))
  assert(report.geometry.units==='relative','单锚点不该给出米制几何')
})

console.log('[6] 参数与输入负例（mapping=linear 已被删除：不为没有真实输出的映射留选项）')
await check("mapping='linear' 与任何非 inverse 映射 → MAPPING_UNSUPPORTED（不再有未匹配上游的分支）",async()=>{
  const linear=await run({requestId:'syn-linear',images:[imageEntry()],anchors:{train:TRAIN_ANCHORS},params:{mapping:'linear'}})
  assert(linear.status==='failed','linear 映射竟然还能跑: '+linear.output.slice(0,200))
  assert(errorCodeOf(linear)==='MAPPING_UNSUPPORTED','错误码不是 MAPPING_UNSUPPORTED: '+errorCodeOf(linear))
  const other=await run({requestId:'syn-other-mapping',images:[imageEntry()],anchors:{train:TRAIN_ANCHORS},params:{mapping:'disparity'}})
  assert(errorCodeOf(other)==='MAPPING_UNSUPPORTED','未知映射也必须明确拒绝: '+errorCodeOf(other))
  const inverse=await run({requestId:'syn-inverse-explicit',images:[imageEntry()],anchors:{train:TRAIN_ANCHORS},params:{mapping:'inverse',sampleStep:32}})
  assert(inverse.status==='completed'&&imageCalibration(reportOf(inverse),0).metric===true,'显式 mapping=inverse 是唯一支持项: '+inverse.output.slice(0,200))
})
await check('minDepthM/maxDepthM 真裁范围：范围外像元进掩码 code 2，几何里没有范围外的顶点',async()=>{
  const runResult=await run({requestId:'syn-range-cut',images:[imageEntry()],anchors:{train:TRAIN_ANCHORS,check:CHECK_ANCHORS},params:{minDepthM:0.5,maxDepthM:4.0,sampleStep:16}})
  assert(runResult.status==='completed','范围裁剪运行未完成: '+runResult.output.slice(0,300))
  const report=reportOf(runResult)
  // 独立口径：前景板 60000 像元在范围内；背景 196000 像元被 maxDepthM 裁掉；天空 51200 像元没有深度证据。
  const counts=report.mask.counts
  assert(counts.ok===60000,'范围内像元数不对: '+String(counts.ok))
  assert(counts.outside_depth_range===196000,'范围外像元数不对: '+String(counts.outside_depth_range))
  assert(counts.nonpositive_relative===51200,'无深度证据像元数不对: '+String(counts.nonpositive_relative))
  const glb=await readGlb(artifactOf(report,'geometry.meters.glb').path)
  let nearest=Infinity,farthest=0
  const values=glb.primitives[0]!.vertices
  for(let index=0;index<values.length;index+=3){
    const {axial}=projectToCamera(POSITION,glbToWorld([values[index]!,values[index+1]!,values[index+2]!]),ROTATION)
    nearest=Math.min(nearest,axial);farthest=Math.max(farthest,axial)
  }
  assert(nearest>=0.5-1e-3&&farthest<=4.0+1e-3,`几何里有范围外的顶点：轴向深度 ${nearest.toFixed(4)}..${farthest.toFixed(4)} m`)
  console.log('      顶点轴向深度 '+nearest.toFixed(4)+'..'+farthest.toFixed(4)+' m（范围内）')
})
/** PLY 独立解析（二进制小端、只读头与第一个顶点，不看 provider 的实现）。 */
async function readPly(path:string){
  const buffer=await readFile(path)
  const endMarker=Buffer.from('end_header\n','ascii')
  const endIndex=buffer.indexOf(endMarker)
  assert(endIndex>=0,'PLY 缺 end_header: '+path)
  const header=buffer.subarray(0,endIndex+endMarker.length).toString('ascii').trim().split('\n').map(line=>line.trim())
  assert(header[0]==='ply'&&header[1]==='format binary_little_endian 1.0','PLY 头不合法: '+JSON.stringify(header.slice(0,2)))
  const element=header.find(line=>line.startsWith('element vertex '))
  assert(element,'PLY 缺 element vertex')
  const vertices=Number(element.split(/\s+/)[2])
  const colors=header.includes('property uchar red')
  const perVertex=12+(colors?3:0)
  const expected=endIndex+endMarker.length+vertices*perVertex
  assert(buffer.length===expected,`PLY 大小与头对不上：${buffer.length} != ${expected}`)
  const offset=endIndex+endMarker.length
  const first=vertices?[buffer.readFloatLE(offset),buffer.readFloatLE(offset+4),buffer.readFloatLE(offset+8)]:[]
  return {header,vertices,colors,first,bytes:buffer.length}
}
await check('writePly 的 PLY 真的可解析：与 GLB 同一批顶点、头里写死单位/轴与"不补背面"',async()=>{
  const runResult=await run({requestId:'syn-ply',images:[imageEntry()],anchors:{train:TRAIN_ANCHORS},params:{sampleStep:32,writePly:true}})
  assert(runResult.status==='completed','PLY 运行未完成: '+runResult.output.slice(0,300))
  const report=reportOf(runResult)
  const ply=await readPly(artifactOf(report,'geometry.meters.ply').path)
  const glb=await readGlb(artifactOf(report,'geometry.meters.glb').path)
  assert(ply.vertices===glb.primitives[0]!.count,'PLY 顶点数与 GLB 不一致: '+ply.vertices+' vs '+glb.primitives[0]!.count)
  assert(ply.colors,'PLY 丢了顶点颜色（photo 模式应带 uchar RGB）')
  assert(ply.header.some(line=>line.includes('units=meters')),'PLY 头没写单位: '+JSON.stringify(ply.header.slice(0,4)))
  assert(ply.header.some(line=>line.includes('up=Y (glTF)')),'PLY 头没写清轴约定: '+JSON.stringify(ply.header.slice(0,4)))
  assert(ply.header.some(line=>line.includes('no invented backside')),'PLY 头没写"不补背面"')
  const glbFirst=[glb.primitives[0]!.vertices[0]!,glb.primitives[0]!.vertices[1]!,glb.primitives[0]!.vertices[2]!]
  assert(ply.first.every((value,index)=>Math.abs(value-glbFirst[index]!)<1e-6),'PLY 第一个顶点与 GLB 不一致: '+JSON.stringify({ply:ply.first,glb:glbFirst}))
})
await check('锚点落在无深度证据的像元（天空相对值 0）→ ANCHOR_INVALID',async()=>{
  const runResult=await run({requestId:'syn-sky-anchor',images:[imageEntry()],anchors:{train:[{pixel:[320,40],depthM:5.0},{pixel:[100,300],depthM:8.0}]}})
  assert(runResult.status==='failed','天空锚点竟然被接受: '+runResult.output.slice(0,200))
  assert(errorCodeOf(runResult)==='ANCHOR_INVALID','错误码不是 ANCHOR_INVALID: '+errorCodeOf(runResult))
})
await check('K 带非零畸变系数 → DISTORTION_UNSUPPORTED；全零系数照常放行（不假装能去畸变）',async()=>{
  const runResult=await run({requestId:'syn-distortion',images:[imageEntry({distortion:{k1:0.12}})],anchors:{train:TRAIN_ANCHORS}})
  assert(runResult.status==='failed','畸变字典竟然被当成有效 K: '+runResult.output.slice(0,200))
  assert(errorCodeOf(runResult)==='INTRINSICS_INVALID','畸变必须是数字数组，字典应报 INTRINSICS_INVALID: '+errorCodeOf(runResult))
  const nonzero=await run({requestId:'syn-distortion-array',images:[imageEntry({distortion:[0.12,0,0,0,0]})],anchors:{train:TRAIN_ANCHORS}})
  assert(nonzero.status==='failed','非零畸变竟然成功: '+nonzero.output.slice(0,200))
  assert(errorCodeOf(nonzero)==='DISTORTION_UNSUPPORTED','错误码不是 DISTORTION_UNSUPPORTED: '+errorCodeOf(nonzero))
  const zero=await run({requestId:'syn-distortion-zero',images:[imageEntry({distortion:[0,0,0,0,0]})],params:{sampleStep:32}})
  assert(zero.status==='completed','全零畸变应照常运行: '+zero.output.slice(0,200))
})
await check('未实现参数与非法范围被拒（sampleStep=0 / minDepthM>=maxDepthM）',async()=>{
  const step=await run({requestId:'syn-step',images:[imageEntry()],anchors:{train:TRAIN_ANCHORS},params:{sampleStep:0}})
  assert(errorCodeOf(step)==='INVALID_PARAMS','sampleStep=0 应报 INVALID_PARAMS: '+errorCodeOf(step))
  const range=await run({requestId:'syn-range',images:[imageEntry()],anchors:{train:TRAIN_ANCHORS},params:{minDepthM:10,maxDepthM:2}})
  assert(errorCodeOf(range)==='INVALID_PARAMS','反深度范围应报 INVALID_PARAMS: '+errorCodeOf(range))
  const unknown=await run({requestId:'syn-unknown',images:[imageEntry()],anchors:{train:TRAIN_ANCHORS},params:{depth_output:'input'}})
  assert(errorCodeOf(unknown)==='UNSUPPORTED_CAPABILITY','未实现参数应报 UNSUPPORTED_CAPABILITY: '+errorCodeOf(unknown))
})
await check('旋转矩阵非正交 → CAMERA_INVALID（不放过坏外参）',async()=>{
  const entry=imageEntry()
  ;(entry.worldFromCamera as any).rotationMatrix=[[0.966,0,-0.259],[0,1,0],[0.259,0,0.966]]
  const runResult=await run({requestId:'syn-rotation',images:[entry],anchors:{train:TRAIN_ANCHORS}})
  assert(runResult.status==='failed','非正交旋转竟然成功: '+runResult.output.slice(0,200))
  assert(errorCodeOf(runResult)==='CAMERA_INVALID','错误码不是 CAMERA_INVALID: '+errorCodeOf(runResult))
})
await check('相对路径没有会话 cwd 时明确报 GEOMETRY_CWD_UNRESOLVED（不落进程 cwd）',async()=>{
  let code=''
  try{await run({requestId:'syn-relpath',images:[imageEntry({npy:'syn-depth.npy',metadata:'syn-depth-metadata.json'})]})}catch(error){code=String(error instanceof Error?error.message:String(error))}
  assert(code.includes('GEOMETRY_CWD_UNRESOLVED'),'相对路径应被明确拒绝: '+code.slice(0,300))
})

console.log('[7] 多图：先同坐标配准，才能合并（逐图各自标定）')
await check('两张图都没给 registration → REGISTRATION_REQUIRED（本工具不做配准）',async()=>{
  const runResult=await run({requestId:'syn-two-no-reg',images:[imageEntry(),imageEntryB({position:POSITION_2})],anchors:{train:TRAIN_ANCHORS}})
  assert(runResult.status==='failed','未配准的多图竟然成功: '+runResult.output.slice(0,200))
  assert(errorCodeOf(runResult)==='REGISTRATION_REQUIRED','错误码不是 REGISTRATION_REQUIRED: '+errorCodeOf(runResult))
})
await check('两张图 frameId 不一致 → REGISTRATION_MISMATCH（不同坐标系不能合并）',async()=>{
  const runResult=await run({requestId:'syn-two-mismatch',images:[imageEntry({registration:{frameId:'frame-a'}}),imageEntryB({position:POSITION_2,registration:{frameId:'frame-b'}})],anchors:{train:TRAIN_ANCHORS}})
  assert(runResult.status==='failed','不同 frameId 竟然合并了: '+runResult.output.slice(0,200))
  assert(errorCodeOf(runResult)==='REGISTRATION_MISMATCH','错误码不是 REGISTRATION_MISMATCH: '+errorCodeOf(runResult))
})
await check('同一 frameId、两张同 affine 图不同机位：各按自己的 worldFromCamera 变换，合并在一个坐标系',async()=>{
  // 逐图合同：每张图都要有自己的锚点（同一 affine 的两张图 → 同样的像素/深度锚点各配一份）。
  const forImage=(items:Array<{pixel:number[];depthM:number}>,index:number)=>items.map(anchor=>({...anchor,imageIndex:index}))
  const runResult=await run({requestId:'syn-two-merged',images:[imageEntry({registration:{frameId:'frame-same'}}),imageEntry({position:POSITION_2,registration:{frameId:'frame-same'}})],anchors:{train:[...forImage(TRAIN_ANCHORS,0),...forImage(TRAIN_ANCHORS,1)],check:[...forImage(CHECK_ANCHORS,0),...forImage(CHECK_ANCHORS,1)]},params:{sampleStep:16}})
  assert(runResult.status==='completed','同 frameId 合并未完成: '+runResult.output.slice(0,300))
  const report=reportOf(runResult)
  assert(report.images.length===2,'来源说明缺第二张图')
  assert(report.gaps.some((gap:string)=>gap.includes('REGISTRATION_TRUSTS_CALLER')),'没有写明"配准是调用方声明、本工具不验证": '+JSON.stringify(report.gaps))
  assert(report.gaps.some((gap:string)=>gap.includes('PER_IMAGE_CALIBRATION')),'没有写明"逐图独立标定、frameId 不代表尺度一致": '+JSON.stringify(report.gaps))
  const glb=await readGlb(artifactOf(report,'geometry.meters.glb').path)
  assert(glb.primitives.length===2,'合并 GLB 应有 2 个 primitive（每图一个）: '+String(glb.primitives.length))
  const first=glb.primitives[0]!,second=glb.primitives[1]!
  assert(first.count===second.count&&first.count>0,'两个 primitive 的顶点数应一致: '+JSON.stringify({first:first.count,second:second.count}))
  const byPixel=new Map<string,number[]>()
  for(let index=0;index<first.count;index++){
    const point=glbToWorld([first.vertices[index*3]!,first.vertices[index*3+1]!,first.vertices[index*3+2]!])
    const projected=projectToCamera(POSITION,point,ROTATION)
    byPixel.set(Math.round(projected.u)+':'+Math.round(projected.v),point)
  }
  let compared=0,worst=0
  for(let index=0;index<second.count;index++){
    const point=glbToWorld([second.vertices[index*3]!,second.vertices[index*3+1]!,second.vertices[index*3+2]!])
    const projected=projectToCamera(POSITION_2,point,ROTATION)
    const partner=byPixel.get(Math.round(projected.u)+':'+Math.round(projected.v))
    if(!partner)continue
    const delta=Math.hypot(point[0]!-partner[0]!-DELTA_POSITION[0]!,point[1]!-partner[1]!-DELTA_POSITION[1]!,point[2]!-partner[2]!-DELTA_POSITION[2]!)
    worst=Math.max(worst,delta);compared++
  }
  assert(compared>500,'同像元可比对的顶点太少: '+compared)
  assert(worst<=5e-3,'两图合并后同一像元的差值应等于声明位姿差: 最大偏差 '+worst+' m')
  console.log('      '+compared+' 个同像元顶点，与声明位姿差的最大偏差 '+(worst*1000).toFixed(3)+' mm')
})
console.log('[8] 真实 scene-kit 收件：import/mount 后按 Y-up 声明还原世界坐标（非原点三点 + 朝向）')
await check('真实 SceneOperations.import/mount：Y-up 声明、三点世界坐标、朝向；直接当 Z-up 用会显然错',async()=>{
  // 场景根是测试自己的产物目录（DATA_DIR 可能被重复使用）：先清掉上一轮的，保证用例可重跑。
  const sceneRoot=join(scratch,'scene-root')
  await rm(sceneRoot,{recursive:true,force:true})
  const operations=new SceneOperations(sceneRoot)
  const sceneId='geo-scene'
  const glbPath=artifactOf(syntheticReport!,'geometry.meters.glb').path
  await operations.create({sceneId})
  const imported=await operations.import({path:glbPath,sceneId,resourceId:'res_depth_geometry',entityId:'geo_root',physicalize:false})
  assert(imported.resource.parsed.kind==='mesh','收件方应把它当 mesh: '+String(imported.resource.parsed.kind))
  assert(imported.resource.parsed.source.upAxis==='Y','产品对 .glb 的轴声明必须是 Y-up: '+JSON.stringify(imported.resource.parsed.source))
  const snapshot=imported.snapshot
  assert(snapshot&&imported.entityId,'带 sceneId 的 import 必须挂载出场景实体')
  // 实体链就是产品真实建立的链：根 → 「源坐标转换」→ glTF 节点（glbEntities 建的，不是测试拼的）。
  const entities=new Map<string,Entity>()
  for(const entity of snapshot.entities)entities.set(entity.entityId,entity)
  const nodeEntity=[...entities.values()].find(entity=>entity.entityId.endsWith(':node:0'))
  assert(nodeEntity,'快照里没有 glTF 节点实体: '+[...entities.keys()].join(','))
  const chain:Entity[]=[]
  for(let cursor:Entity|undefined=nodeEntity;cursor;cursor=cursor.parentId?entities.get(cursor.parentId):undefined)chain.unshift(cursor)
  assert(chain.length===3,`实体链应为 根→源坐标转换→节点 三层，实际 ${chain.map(entity=>entity.entityId).join(' > ')}`)
  const localMatrix=(transform:Transform)=>new Matrix4().compose(new Vector3(...transform.position),new Quaternion(...transform.quaternion),new Vector3(...transform.scale))
  const worldMatrix=new Matrix4()
  for(const entity of chain)worldMatrix.multiply(localMatrix(entity.transform))
  approx(worldMatrix.determinant(),1,1e-6,'实体链的合成变换行列式（+1 表示没有镜像）')

  const glb=await readGlb(glbPath)
  const primitive=glb.primitives[0]!,indices=primitive.indices!
  // 顶点 → 它对应的采样像元（用产品世界系的投影判据，独立于 provider）。
  const pixelOf=new Map<number,string>()
  const rawOf=new Map<string,number>()
  for(let index=0;index<primitive.count;index++){
    const raw=[primitive.vertices[index*3]!,primitive.vertices[index*3+1]!,primitive.vertices[index*3+2]!]
    const projected=projectToCamera(POSITION,glbToWorld(raw),ROTATION)
    const key=Math.round(projected.u)+':'+Math.round(projected.v)
    pixelOf.set(index,key);rawOf.set(key,index)
  }
  // 三个**非原点**、真值已知的采样像元：天空以外、覆盖前景板与背景。
  const probes=[{u:0,v:80,d:BACKGROUND_M},{u:320,v:240,d:PANEL.depthM},{u:632,v:472,d:BACKGROUND_M}]
  let worst=0,checked=0
  for(const probe of probes){
    const index=rawOf.get(probe.u+':'+probe.v)
    assert(index!==undefined,`GLB 里没有像元 (${probe.u},${probe.v}) 的顶点（夹具/掩码变了？）`)
    const raw=[primitive.vertices[index*3]!,primitive.vertices[index*3+1]!,primitive.vertices[index*3+2]!]
    const composed=new Vector3(raw[0]!,raw[1]!,raw[2]!).applyMatrix4(worldMatrix)
    const expected=rotateToWorld(cameraPointOf(probe.u,probe.v,probe.d)).map((value,axis)=>value+POSITION[axis]!)
    const error=Math.hypot(composed.x-expected[0]!,composed.y-expected[1]!,composed.z-expected[2]!)
    worst=Math.max(worst,error);checked++
    assert(error<=0.05,`像元 (${probe.u},${probe.v}) 收件后的世界坐标 ${composed.toArray()} 与真值 ${JSON.stringify(expected)} 差 ${error} m`)
    assert(Math.hypot(raw[0]!,raw[1]!,raw[2]!)>1,`探针顶点是原点，测不出轴的问题: ${JSON.stringify(raw)}`)
  }
  assert(checked===3,'三个探针必须都比对到')
  console.log('      三点收件后与真值最大偏差 '+(worst*1000).toFixed(2)+' mm（GLB 顶点本身是 Y-up，产品链再转回 Z-up）')
  // 朝向：同一个三角面在收件世界里与解析真值的法线朝向必须一致（没有镜像/翻转）。
  const triangle=[indices[0]!,indices[1]!,indices[2]!]
  const composedPoints=triangle.map(index=>new Vector3(primitive.vertices[index*3]!,primitive.vertices[index*3+1]!,primitive.vertices[index*3+2]!).applyMatrix4(worldMatrix))
  const truthPoints=triangle.map(index=>{
    const key=pixelOf.get(index)!
    const [u,v]=key.split(':').map(Number) as [number,number]
    const depth=truthDepthM(u,v)
    assert(depth!==null,`探针三角面的像元 (${u},${v}) 没有真值`)
    return new Vector3(...rotateToWorld(cameraPointOf(u,v,depth!)).map((value,axis)=>value+POSITION[axis]!) as [number,number,number])
  })
  const normalOf=(points:Vector3[])=>new Vector3().subVectors(points[1]!,points[0]!).cross(new Vector3().subVectors(points[2]!,points[0]!))
  const centroidOf=(points:Vector3[])=>new Vector3().add(points[0]!).add(points[1]!).add(points[2]!).multiplyScalar(1/3)
  const camera=new Vector3(...POSITION as [number,number,number])
  const composedNormal=normalOf(composedPoints).normalize(),truthNormal=normalOf(truthPoints).normalize()
  const composedFacing=composedNormal.dot(new Vector3().subVectors(camera,centroidOf(composedPoints)))
  const truthFacing=truthNormal.dot(new Vector3().subVectors(camera,centroidOf(truthPoints)))
  assert(Math.sign(composedFacing)===Math.sign(truthFacing)&&Math.abs(composedFacing)>1e-3,'收件后的三角面朝向与真值不一致（镜像/翻转）: '+JSON.stringify({composedFacing,truthFacing}))
  // 负控：不做 (x,y,z)→(x,z,-y) 而直接按 Z-up 写出时，同样的三点会错得显然（>0.5 m）。
  let zupWorst=0
  for(const probe of probes){
    const index=rawOf.get(probe.u+':'+probe.v)!
    const raw=[primitive.vertices[index*3]!,primitive.vertices[index*3+1]!,primitive.vertices[index*3+2]!]
    const expected=rotateToWorld(cameraPointOf(probe.u,probe.v,probe.d)).map((value,axis)=>value+POSITION[axis]!)
    // 假装 GLB 里就是产品世界坐标（旧实现的行为）：不再经过轴转换。
    zupWorst=Math.max(zupWorst,Math.hypot(raw[0]!-expected[0]!,raw[1]!-expected[1]!,raw[2]!-expected[2]!))
  }
  assert(worst<=0.05&&zupWorst>0.5,'轴检查没有力度：Y-up 与 Z-up 两种读法的差别太小: '+JSON.stringify({yup:worst,zup:zupWorst}))
  console.log('      同三点若按 Z-up 直读会错到 '+zupWorst.toFixed(2)+' m（说明 Y-up 导出是实测过的，不是只写了字段）')
})

console.log('[9] 产物合同（TS 层只核对存在/归属/返回语义；完整数值与文件结构检查在测试的独立解析器里）')
await check('原封不动的产物目录通过合同核对（负控：核对不是永远报错）',async()=>{
  const report=syntheticReport!
  const copy=join(scratch,'contract-ok')
  await cp(join(report.outputDirectory,'artifacts'),copy,{recursive:true})
  const worker={artifacts:report.artifacts.map((item:any)=>({type:item.type,path:join(copy,item.path.split('/').pop()),bytes:item.bytes,note:item.note}))}
  const checked=await collectGeometryArtifacts(worker,copy)
  assert(checked.artifacts.length===report.artifacts.length,'核对后的产物数不一致')
  assert(checked.geometry.units==='meters'&&checked.geometry.metricImageIndexes.join(',')==='0','合同核对没有认出逐图米制: '+JSON.stringify(checked.geometry))
  assert(checked.geometry.combined&&checked.geometry.relativePreviews.length===0,'单米制图不应有相对预览')
})
async function tamper(name:string,report:Record<string,any>,mutate:(directory:string)=>Promise<void>,expectedCode:string){
  const copy=join(scratch,'tamper-'+name)
  await cp(join(report.outputDirectory,'artifacts'),copy,{recursive:true})
  await mutate(copy)
  const worker={artifacts:report.artifacts.map((item:any)=>({type:item.type,path:join(copy,item.path.split('/').pop()),bytes:item.bytes,note:item.note}))}
  let code=''
  try{await collectGeometryArtifacts(worker,copy)}catch(error){code=error instanceof DepthGeometryError?error.code:String(error)}
  assert(code===expectedCode,`篡改 ${name} 应被 ${expectedCode} 拒绝，实际 ${code}`)
}
const fileNamed=(report:Record<string,any>,type:string)=>((report.artifacts.find((item:any)=>item.type===type) as any).path as string).split('/').pop()!
await check('units 与逐图 metric 自相矛盾、掩码计数对不上、缺 check 却判 verified 都必须被拒',async()=>{
  const report=syntheticReport!
  await tamper('units',report,async directory=>{
    const path=join(directory,fileNamed(report,'geometry.metadata.json'))
    const metadata=JSON.parse(await readFile(path,'utf8')) as Record<string,any>
    metadata.geometry.units='relative'
    await writeFile(path,JSON.stringify(metadata))
  },'INVALID_GEOMETRY_METADATA')
  await tamper('mask',report,async directory=>{
    const path=join(directory,fileNamed(report,'geometry.metadata.json'))
    const metadata=JSON.parse(await readFile(path,'utf8')) as Record<string,any>
    metadata.mask.counts.ok+=1
    await writeFile(path,JSON.stringify(metadata))
  },'INVALID_GEOMETRY_METADATA')
  await tamper('verified-without-check',report,async directory=>{
    const path=join(directory,fileNamed(report,'geometry.calibration.json'))
    const calibration=JSON.parse(await readFile(path,'utf8')) as Record<string,any>
    calibration.images[0].check.count=0
    calibration.images[0].check.items=[]
    await writeFile(path,JSON.stringify(calibration))
  },'INVALID_GEOMETRY_METADATA')
})
await check('没有尺度的图出现米制 npy / 米制 GLB 混进未标定图 → 合同核对拒绝（不混单位）',async()=>{
  const report=mixedReport!
  const copy=join(scratch,'tamper-mixed')
  await cp(join(report.outputDirectory,'artifacts'),copy,{recursive:true})
  const declared=report.artifacts.map((item:any)=>({type:item.type,path:join(copy,item.path.split('/').pop()),bytes:item.bytes,note:item.note}))
  // 把图 B 的米制 npy 换成一个真实文件（内容无所谓：合同先看"这张图有没有自己的标定"）。
  const extra={type:'depth.metric.npy-i1',path:join(copy,fileNamed(report,'geometry.meters.glb')),bytes:1}
  let code=''
  try{await collectGeometryArtifacts({artifacts:[...declared,extra]},copy)}catch(error){code=error instanceof DepthGeometryError?error.code:String(error)}
  assert(code==='INVALID_GEOMETRY_METADATA','未标定图有米制 npy 应被拒: '+code)
  // 方向二：把「米制 GLB 只含自己有标定的图」改成两图都算进去（把图 B 也塞进米制世界）。
  const copyTwo=join(scratch,'tamper-combined-images')
  await cp(join(report.outputDirectory,'artifacts'),copyTwo,{recursive:true})
  const path=join(copyTwo,fileNamed(report,'geometry.metadata.json'))
  const metadata=JSON.parse(await readFile(path,'utf8')) as Record<string,any>
  metadata.geometry.combined.images=[0,1]
  await writeFile(path,JSON.stringify(metadata))
  code=''
  try{await collectGeometryArtifacts({artifacts:report.artifacts.map((item:any)=>({type:item.type,path:join(copyTwo,item.path.split('/').pop()),bytes:item.bytes}))},copyTwo)}catch(error){code=error instanceof DepthGeometryError?error.code:String(error)}
  assert(code==='INVALID_GEOMETRY_METADATA','米制 GLB 混进未标定的图应被拒: '+code)
})
await check('GLB 被截断：生产层按"声明字节数 vs 磁盘"拒绝；结构完整性由测试的独立解析器负责',async()=>{
  const report=syntheticReport!
  const copy=join(scratch,'tamper-glb')
  await cp(join(report.outputDirectory,'artifacts'),copy,{recursive:true})
  const glbPath=join(copy,fileNamed(report,'geometry.meters.glb'))
  const info=await stat(glbPath)
  await truncate(glbPath,info.size-4)
  const worker={artifacts:report.artifacts.map((item:any)=>({type:item.type,path:join(copy,item.path.split('/').pop()),bytes:item.bytes,note:item.note}))}
  let code=''
  try{await collectGeometryArtifacts(worker,copy)}catch(error){code=error instanceof DepthGeometryError?error.code:String(error)}
  assert(code==='INVALID_GEOMETRY_METADATA','截断文件与自述字节数不符应被拒: '+code)
  let parserRejected=false
  await readGlb(glbPath).then(()=>{},()=>{parserRejected=true})
  assert(parserRejected,'测试的独立 GLB 解析器必须抓到截断文件（结构检查不能没人做）')
})
await check('声称的产物文件不存在 → GEOMETRY_ARTIFACT_MISSING',async()=>{
  const report=syntheticReport!
  const copy=join(scratch,'contract-missing')
  await cp(join(report.outputDirectory,'artifacts'),copy,{recursive:true})
  const worker={artifacts:report.artifacts.map((item:any)=>({type:item.type,path:join(copy,item.path.split('/').pop()),bytes:item.bytes})).filter((item:any)=>item.type!=='geometry.meters.glb')}
  let code=''
  try{await collectGeometryArtifacts(worker,copy)}catch(error){code=error instanceof DepthGeometryError?error.code:String(error)}
  assert(code==='GEOMETRY_ARTIFACT_MISSING','缺几何产物应被拒: '+code)
})

console.log('[10] 运行协议（假脚本只验协议：错误信封 / 缺产物 / 取消）')
const stubDirectory=join(scratch,'stubs')
await mkdir(stubDirectory,{recursive:true})
const stubError=join(stubDirectory,'stub-error.py')
await writeFile(stubError,"import sys,json\nprint('LYAPUNOV_GEOMETRY_RESULT='+json.dumps({'error':{'code':'STUB_FAILURE','message':'夹具失败','detail':{'why':'stub'}}}))\nsys.exit(1)\n")
const stubEmpty=join(stubDirectory,'stub-empty.py')
await writeFile(stubEmpty,"import sys,json\nprint('LYAPUNOV_GEOMETRY_RESULT='+json.dumps({'artifacts':[],'report':{}}))\n")
const stubSleep=join(stubDirectory,'stub-sleep.py')
await writeFile(stubSleep,"import time\ntime.sleep(30)\n")
await check('脚本给出结构化错误信封 → status=failed 且错误码透传',async()=>{
  const runResult=await run({requestId:'stub-error',images:[imageEntry()]},{script:stubError})
  assert(runResult.status==='failed','应失败: '+runResult.output.slice(0,200))
  assert(errorCodeOf(runResult)==='STUB_FAILURE','错误码没有透传: '+runResult.output.slice(0,200))
})
await check('脚本声称成功但没有产物 → 合同核对直接拒绝（不交空产物）',async()=>{
  let code=''
  try{await run({requestId:'stub-empty',images:[imageEntry()]},{script:stubEmpty})}catch(error){code=error instanceof DepthGeometryError?error.code:String(error)}
  assert(code==='GEOMETRY_ARTIFACT_MISSING','应报 GEOMETRY_ARTIFACT_MISSING: '+code)
})
await check('已取消的信号在任何写操作前拒绝',async()=>{
  const controller=new AbortController();controller.abort()
  let rejected=false
  try{await run({requestId:'stub-aborted',images:[imageEntry()]},{script:stubSleep},controller.signal)}catch{rejected=true}
  assert(rejected,'已取消的信号没有拒绝')
})
await check('运行中取消 → status=killed，且不交付任何报告/产物',async()=>{
  const controller=new AbortController()
  const pending=run({requestId:'stub-cancel',images:[imageEntry()]},{script:stubSleep},controller.signal)
  await delay(400)
  controller.abort()
  const runResult=await pending
  assert(runResult.status==='killed','运行中取消应得 killed，实际 '+runResult.status)
  assert(runResult.report===undefined&&runResult.artifacts===undefined,'取消的运行不该交付报告/产物')
  assert(errorCodeOf(runResult)==='CANCELLED','取消的错误码不对: '+runResult.output.slice(0,200))
})
console.log('[11] 真实照片的相对深度产物（真实数组 + 真实照片）')
const realField=(await readNpy(realDepthNpy!)).float!
const REAL_WIDTH=3840,REAL_HEIGHT=2880
/** 无 EXIF：K 是**假定**值（约 62° 水平视场），报告里必须如实标注。 */
const REAL_FX=3200,REAL_FY=3200,REAL_CX=1919.5,REAL_CY=1439.5
function realImageEntry(options:{registration?:Record<string,unknown>}={}){
  return {
    relativeDepth:{path:realDepthNpy},
    metadata:{path:realMetadata},
    photo:{path:realPhoto},
    intrinsics:{fx:REAL_FX,fy:REAL_FY,cx:REAL_CX,cy:REAL_CY,width:REAL_WIDTH,height:REAL_HEIGHT},
    // 相机位姿也是假定的单位位姿（网络照片没有来源场景）：只用于验证几何链路，不代表真实机位。
    worldFromCamera:{positionM:[0,0,0],rotationMatrix:[[1,0,0],[0,1,0],[0,0,1]]},
    ...options.registration?{registration:options.registration}:{},
  }
}
await check('真实深度 npy 形状与 metadata 自述一致（独立读数）',async()=>{
  const read=await readNpy(realDepthNpy!)
  assert(read.shape[0]===REAL_HEIGHT&&read.shape[1]===REAL_WIDTH,'真实深度形状异常: '+JSON.stringify(read.shape))
  assert(read.dtype==='<f4','真实深度 dtype 异常: '+read.dtype)
  const metadata=JSON.parse(await readFile(realMetadata!,'utf8')) as Record<string,any>
  assert(metadata.schema==='lyapunov/depth-estimation/1'||metadata.schema==='lyapunov.depth-estimation/1','真实 metadata schema 不对: '+String(metadata.schema))
  assert(metadata.depth.relative===true,'真实 metadata 语义不对')
  assert(metadata.sizes.fullDepth.width===REAL_WIDTH&&metadata.sizes.fullDepth.height===REAL_HEIGHT,'真实 metadata 尺寸不对')
})
await check('真实照片（无锚点）→ 相对预览 GLB：顶点数=掩码通过格点数、近远顺序正确（越大越近）',async()=>{
  const runResult=await run({requestId:'real-relative',images:[realImageEntry()],params:{sampleStep:16}})
  assert(runResult.status==='completed','真实照片运行未完成: '+runResult.output.slice(0,400))
  const report=reportOf(runResult)
  assert(report.geometry.units==='relative'&&report.calibration.accepted===false&&report.geometry.combined===null,'无锚点的真实照片不该声称米制: '+JSON.stringify({units:report.geometry.units,accepted:report.calibration.accepted}))
  const glbArtifact=artifactOf(report,'geometry.relative.preview.glb-i0')
  const glb=await readGlb(glbArtifact.path)
  assert(glb.primitives.length===1,'单图应一个 primitive')
  assert(glb.extras.units==='relative'&&glb.extras.assumed===true&&glb.extras.calibrated===false,'GLB extras 必须标明是 assumed 的相对预览')
  assert(glb.extras.maskCodes?.['0']==='ok','GLB extras 没带掩码口径')
  assert(Array.isArray(glb.extras.limits)&&glb.extras.limits.length>=2,'GLB extras 没写限制（不补背面/照片只作颜色）')
  const mask=await readNpy(artifactOf(report,'depth.mask.npy-i0').path)
  let expected=0
  for(let v=0;v<REAL_HEIGHT;v+=16)for(let u=0;u<REAL_WIDTH;u+=16)if(mask.bytes![v*REAL_WIDTH+u]===0)expected++
  assert(glb.primitives[0]!.count===expected,'顶点数与掩码通过的格点数不一致: '+JSON.stringify({glb:glb.primitives[0]!.count,expected}))
  console.log('      GLB '+glb.primitives[0]!.count+' 顶点 / '+(glb.primitives[0]!.indices!.length/3)+' 三角面；掩码无效像元占比 '+Number(report.mask.invalidFraction).toFixed(4))
  // 原照片的颜色确实进了顶点（真实 JPEG 的颜色有变化，不是常量）。
  const colors=glb.primitives[0]!.colors
  assert(colors,'真实照片没有产生顶点颜色')
  const distinct=new Set<string>()
  const colorStep=glb.primitives[0]!.colorComponents
  for(let index=0;index<glb.primitives[0]!.count;index+=97)distinct.add([0,1,2].map(part=>colors[index*colorStep+part]).join(','))
  assert(distinct.size>20,'顶点颜色种类过少，不像来自真实照片: '+distinct.size)
  // 近远：真实数组上的顺序判据。这张图的 worldFromCamera 是**单位位姿**（无 EXIF，假定值），
  // 所以相机坐标就是 glbToWorld 出来的产品世界坐标，不能套用夹具里那台相机的旋转。
  const primitive=glb.primitives[0]!
  const pairs:Array<[number,number]>=[];let worst=0
  for(let index=0;index<primitive.count;index++){
    const camera=glbToWorld([primitive.vertices[index*3]!,primitive.vertices[index*3+1]!,primitive.vertices[index*3+2]!])
    const axial=-camera[2]!
    const u=REAL_CX+REAL_FX*camera[0]!/axial,v=REAL_CY-REAL_FY*camera[1]!/axial
    const relative=bilinear(realField,REAL_WIDTH,REAL_HEIGHT,u,v)
    assert(relative>0,'真实数组里出现了非正的相对值（掩码没挡住）: '+relative)
    worst=Math.max(worst,Math.abs(axial-1/relative)/(1/relative))
    pairs.push([relative,axial])
  }
  assert(worst<=0.01,'真实数据的相对预览顶点不等于 1/relative: 最大相对偏差 '+worst)
  pairs.sort((left,right)=>right[0]-left[0])
  let inversions=0
  for(let index=1;index<pairs.length;index++)if(pairs[index]![1]<pairs[index-1]![1]*(1-1e-4))inversions++
  assert(inversions===0,'真实数据上出现"相对值大却更远"的顺序颠倒: '+inversions+' 处')
  console.log('      真实数据 '+pairs.length+' 个顶点：与 1/relative 最大偏差 '+worst.toExponential(2)+'，顺序颠倒 0 处')
})
await check('真实照片 + 假定锚点（无独立 check）→ 米制产物给出但 verdict=unverified、accepted=false',async()=>{
  const samples:{relative:number;u:number;v:number}[]=[]
  for(let v=64;v<REAL_HEIGHT;v+=97)for(let u=64;u<REAL_WIDTH;u+=131){
    const relative=realField[v*REAL_WIDTH+u]!
    if(relative>0)samples.push({relative,u,v})
  }
  samples.sort((left,right)=>left.relative-right.relative)
  const far=samples[0]!,near=samples[samples.length-1]!
  console.log('      假定锚点：近处像元 ('+near.u+','+near.v+') 假定 1.0 m；远处像元 ('+far.u+','+far.v+') 假定 20.0 m（**测试假定，不是实测标定**）')
  const runResult=await run({requestId:'real-metric-assumed',images:[realImageEntry()],anchors:{train:[
    {pixel:[near.u,near.v],depthM:1.0,note:'测试假定（近距离像元），非实地测量'},
    {pixel:[far.u,far.v],depthM:20.0,note:'测试假定（远距离像元），非实地测量'},
  ]},params:{sampleStep:32}})
  assert(runResult.status==='completed','假定锚点运行未完成: '+runResult.output.slice(0,400))
  const report=reportOf(runResult),entry=imageCalibration(report,0)
  assert(report.geometry.units==='meters'&&entry.metric===true,'假定锚点应能给出米制产物: '+String(report.geometry.units))
  assert(entry.verdict==='unverified','没有独立 check 锚点时必须 unverified，实际 '+String(entry.verdict))
  assert(entry.accepted===false&&report.calibration.accepted===false,'没有独立核对的标定不得 accepted')
  assert(entry.check.count===0,'没有 check 锚点却报了 '+String(entry.check.count))
  const glb=await readGlb(artifactOf(report,'geometry.meters.glb').path)
  assert(glb.extras.accepted===false&&glb.extras.verdict==='unverified','GLB extras 必须带上未核对标记: '+JSON.stringify({accepted:glb.extras.accepted,verdict:glb.extras.verdict}))
  // 米制深度必须落在调用方声明的正深度范围内（不外推出负值/无穷）。
  const metric=await readNpy(artifactOf(report,'depth.metric.npy-i0').path)
  let min=Infinity,max=-Infinity,count=0
  for(let index=0;index<metric.float!.length;index+=53){
    const value=metric.float![index]!
    if(Number.isNaN(value))continue
    min=Math.min(min,value);max=Math.max(max,value);count++
  }
  assert(count>0&&min>=entry.validDepthRangeM.min&&max<=entry.validDepthRangeM.max,'米制深度越出声明范围: '+JSON.stringify({min,max,range:entry.validDepthRangeM}))
  console.log('      假定标定 scale='+Number(entry.scale).toExponential(3)+' shift='+Number(entry.shift).toExponential(3)+'；米制深度 '+min.toFixed(2)+'..'+max.toFixed(2)+' m')
})
await check('真实尺寸下采样过密 → TOO_MANY_POINTS（在采样前就拒绝，不产出半份几何）',async()=>{
  const runResult=await run({requestId:'real-too-many',images:[realImageEntry()],params:{sampleStep:2}})
  assert(runResult.status==='failed','过密采样竟然成功')
  assert(errorCodeOf(runResult)==='TOO_MANY_POINTS','错误码不是 TOO_MANY_POINTS: '+errorCodeOf(runResult))
})

console.log('[12] Tool / Command 装配（同一 operation）')
await check('depth_geometry 工具：结构化 report + 有界文本摘要，且两者是同一份事实',async()=>{
  const called=await callTool({request_json:JSON.stringify({requestId:'tool-calibrated',images:[imageEntry()],anchors:{train:TRAIN_ANCHORS,check:CHECK_ANCHORS},params:{sampleStep:16}})})
  assert(!called.isError,'工具调用失败: '+JSON.stringify(called.content).slice(0,400))
  const value=toolValue(called)!
  assert(value.report&&typeof value.result==='string'&&value.result.length>0,'工具返回缺 result/report')
  assert(value.result.length<4000,'result 摘要过长（'+value.result.length+' 字符），应是有界摘要')
  assert(value.result.includes('verified')&&value.result.includes('轴向'),'摘要没有写明判定与深度语义: '+value.result.slice(0,200))
  approx(Number(value.report.calibration.images[0].scale),SCALE_TRUTH,2e-3,'工具 report 的 scale')
  assert(value.report.artifacts.every((item:any)=>typeof item.path==='string'&&item.bytes>0),'report.artifacts 缺路径/字节数')
  // 返回值必须是可无损 JSON 化的（含 undefined/NaN 会让整次工具调用失效）。
  assert(JSON.parse(JSON.stringify(value.report)).requestId==='tool-calibrated','report 不能无损 JSON 化')
})
await check('工具的摘要逐图给出判定（米制图与只出相对预览的图分开说）',async()=>{
  const called=await callTool({request_json:JSON.stringify({requestId:'tool-mixed',images:[imageEntry({registration:{frameId:'frame-tool'}}),imageEntryB({registration:{frameId:'frame-tool'}})],anchors:{train:TRAIN_ANCHORS,check:CHECK_ANCHORS},params:{sampleStep:32}})})
  assert(!called.isError,'工具调用失败: '+JSON.stringify(called.content).slice(0,300))
  const value=toolValue(called)!
  assert(value.result.includes('图0')&&value.result.includes('图1'),'摘要必须逐图列出判定: '+value.result.slice(0,400))
  assert(value.result.includes('relative')&&value.result.includes('米制'),'摘要必须写清哪张图是相对预览、哪张是米制: '+value.result.slice(0,400))
  assert(value.result.includes('不混在一个文件')||value.result.includes('不合并'),'摘要必须写清米制与相对预览不混: '+value.result.slice(0,500))
  assert(value.report.calibration.images[1].metric===false,'工具 report 里图 1 不该有米制标定')
})
await check('工具的相对路径按会话 cwd 解析（会话工作目录优先于进程 cwd）',async()=>{
  const called=await callTool({request_json:JSON.stringify({requestId:'tool-relative',images:[imageEntry({npy:'syn-depth.npy',metadata:'syn-depth-metadata.json',photo:'syn-photo.png'})],params:{sampleStep:32}})})
  assert(!called.isError,'按会话 cwd 的相对路径被拒: '+JSON.stringify(called.content).slice(0,400))
  assert(toolValue(called)!.report.requestId==='tool-relative','结果 requestId 不对')
})
await check('工具的错误路径：独立核对失败会在文本里明确写出来（accepted=false）',async()=>{
  const called=await callTool({request_json:JSON.stringify({requestId:'tool-check-fail',images:[imageEntry()],anchors:{train:TRAIN_ANCHORS,check:[{pixel:[60,100],depthM:24.0}]}})})
  assert(!called.isError,'check 失败不该让工具整体报错（产物仍要交付并标注）: '+JSON.stringify(called.content).slice(0,300))
  const value=toolValue(called)!
  assert(value.result.includes('不得当标定通过'),'摘要没有写明不得当标定通过: '+value.result.slice(0,300))
  assert(value.report.calibration.accepted===false,'report.accepted 应为 false')
})
await check('工具的输入错误走 isError（锚点落在无深度像元 / 同点泄漏）',async()=>{
  const called=await callTool({request_json:JSON.stringify({requestId:'tool-bad-anchor',images:[imageEntry()],anchors:{train:[{pixel:[320,40],depthM:5.0},{pixel:[100,300],depthM:8.0}]}})})
  assert(called.isError,'坏锚点应让工具报错')
  assert(JSON.stringify(called.content).includes('ANCHOR_INVALID'),'错误文本没有稳定的错误码: '+JSON.stringify(called.content).slice(0,300))
  const leak=await callTool({request_json:JSON.stringify({requestId:'tool-leak',images:[imageEntry()],anchors:{train:TRAIN_ANCHORS,check:[TRAIN_ANCHORS[0]!]}})})
  assert(leak.isError,'同点泄漏应让工具报错')
  assert(JSON.stringify(leak.content).includes('ANCHOR_CHECK_NOT_INDEPENDENT'),'错误文本没有稳定的错误码: '+JSON.stringify(leak.content).slice(0,300))
})
await check('Command /depth_geometry 与 /depth_geometry_status 走同一 operation 且 status 只读',async()=>{
  const commandAgent={session:{header:{cwd:fixtures}}} as never
  const handler=ctx.commands.find(commandAgent,'depth_geometry')?.handler
  assert(handler,'/depth_geometry 未注册')
  const invoked=await handler!({commandId:'cmd-geometry',agent:commandAgent,rawInput:JSON.stringify({request_json:JSON.stringify({requestId:'command-run',images:[imageEntry()],params:{sampleStep:32}})}),attachments:[],signal:new AbortController().signal} as never)
  const invokedText=String(invoked.text??'')
  assert(invoked.kind==='success','Command 失败: '+JSON.stringify(invoked).slice(0,300))
  assert(invokedText.includes('相对单位'),'无锚点的 Command 摘要应说明是相对单位: '+invokedText.slice(0,200))
  assert(invokedText.includes('1/relative'),'Command 摘要应写清相对预览的假定: '+invokedText.slice(0,300))
  const statusHandler=ctx.commands.find(commandAgent,'depth_geometry_status')?.handler
  assert(statusHandler,'/depth_geometry_status 未注册')
  const status=await statusHandler!({commandId:'cmd-status',agent:commandAgent,rawInput:'',attachments:[],signal:new AbortController().signal} as never)
  const statusText=String(status.text??'')
  assert(status.kind==='success','status 失败: '+JSON.stringify(status).slice(0,200))
  const parsed=JSON.parse(statusText) as Record<string,any>
  assert(parsed.available===true&&parsed.paths.python===python,'status 未认出配置的解释器: '+statusText.slice(0,200))
  // 只读：status 不得创建输出根（这里用未创建的路径做对照）。
  const untouched=join(scratch,'outputs-untouched')
  const probe=await depthGeometryStatus({python,dataDirectory:untouched})
  assert(probe.outputRoot.exists===false&&probe.outputRoot.path===untouched,'只读 status 报告的输出根状态不对: '+JSON.stringify(probe.outputRoot))
  assert(!await stat(untouched).catch(()=>null),'只读 status 创建了输出根: '+untouched)
})
await check('装配兼容：深度估计插件的 config.pythonPath 原样传进来就能用（不必写适配对象）',async()=>{
  const probe=await depthGeometryStatus({pythonPath:python,dataDirectory:join(scratch,'outputs-alias')})
  assert(probe.paths.python===python&&probe.pythonSource==='config','pythonPath 别名没被识别: '+JSON.stringify({python:probe.paths.python,source:probe.pythonSource}))
  const precedence=await depthGeometryStatus({python:'/nonexistent/python',pythonPath:python})
  assert(precedence.paths.python==='/nonexistent/python'&&precedence.available===false,'显式 python 应优先于 pythonPath 别名: '+JSON.stringify({python:precedence.paths.python,available:precedence.available}))
})

await writeFile(join(scratch,'test-summary.json'),JSON.stringify({passed,failures,scratch},null,2))
console.log('\n通过 '+passed+' 项，失败 '+failures.length+' 项')
if(failures.length){for(const failure of failures)console.log(' - '+failure);await disposeGeometry();process.exit(1)}
console.log('全部真实用例通过（python '+python+'）')
await disposeGeometry()
process.exit(0)





