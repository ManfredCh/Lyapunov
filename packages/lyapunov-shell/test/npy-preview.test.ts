/**
 * P7A2：NPY 显示辅助的回归（`npy-preview.ts`）。
 *
 * 只钉三件事：①解码只认实际原生形状（`<f4`/`<f8`、little-endian、二维、C 顺序），
 * 其余**显式失败**——尤其大端不许被静默换序；②有限/NaN/±Inf 如实统计；③颜色规则按通道具名、
 * 可从原数组复算，无返回像素用独立颜色而不是 0 米。
 *
 * 已知几何取自 P7A 真实产物回执（`.rc-evidence/p7a-camera/fixtures/receipt.json`：forward 8.9 m、
 * east 3.9 m、向下 45° 到地板 1.6970562748477138 m、无返回 NaN）。原生 fixture 在盘上就直接解它，
 * 否则用同一组记录值构造等价的 NPY 正文字节——两条路径断言同一几何，不会因证据目录不在而静默跳过。
 */
import {describe,expect,test} from 'bun:test'
import {existsSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {CAMERA_DEPTH_COLOR_RULE,LIDAR_RANGE_COLOR_RULE,NPY_INVALID_RGBA,NpyFormatError,colorizeNpy,decodeNpy,npyHostIsLittleEndian,npyStats} from '../src/npy-preview.ts'

type BuildOptions={descr?:string;shape?:number[];values?:number[];fortran?:boolean;version?:1|2;magic?:string;declaredShape?:string}
const itemsizeOf=(descr:string):number=>{const match=/[a-z](\d+)$/.exec(descr);return match?Number(match[1]):1}
/** 手工拼一份小端 NPY（含 64 字节对齐填充），与 `np.save` 的头部形状一致。 */
function buildNpy(options:BuildOptions={}):Uint8Array{
 const descr=options.descr??'<f4',shape=options.shape??[1],values=options.values??[0],version=options.version??1
 const count=shape.reduce((a,b)=>a*b,1)
 const shapeText=options.declaredShape??`(${shape.join(', ')}${shape.length===1?',':''})`
 const headerPadding=version===1?10:12
 let header=`{'descr': '${descr}', 'fortran_order': ${options.fortran?'True':'False'}, 'shape': ${shapeText}, }`
 while((headerPadding+header.length+1)%64!==0)header+=' '
 header+='\n'
 const headerBytes=new TextEncoder().encode(header),itemSize=itemsizeOf(descr)
 const total=headerPadding+headerBytes.length+count*itemSize
 const out=new Uint8Array(total)
 const magic=options.magic??'\x93NUMPY'
 for(let i=0;i<6;i++)out[i]=magic.charCodeAt(i)
 out[6]=version;out[7]=0
 const view=new DataView(out.buffer,out.byteOffset,out.byteLength)
 if(version===1)view.setUint16(8,headerBytes.length,true);else view.setUint32(8,headerBytes.length,true)
 out.set(headerBytes,headerPadding)
 const start=headerPadding+headerBytes.length
 for(let i=0;i<count;i++){
  const value=values[i]??0,offset=start+i*itemSize
  if(descr.includes('f')&&itemSize===4)view.setFloat32(offset,value,true)
  else if(descr.includes('f')&&itemSize===8)view.setFloat64(offset,value,true)
  else for(let byte=0;byte<itemSize;byte++)out[offset+byte]=Math.round(value)&0xff
 }
 return out
}
const codeOf=(fn:()=>unknown):string|undefined=>{try{fn();return undefined}catch(error){return error instanceof NpyFormatError?error.code:String(error)}}
const rgbaOf=(image:ReturnType<typeof colorizeNpy>,pixel:number)=>Array.from(image.rgba.slice(pixel*4,pixel*4+4))

const fixtureDir=join(import.meta.dir,'../../../.rc-evidence/p7a-camera/fixtures')
const readFixtureOr=(name:string,fallback:()=>Uint8Array):Uint8Array=>{const path=join(fixtureDir,name);return existsSync(path)?new Uint8Array(readFileSync(path)):fallback()}
/** 与真实 range fixture 同形同值的等价正文：ch0 地板 1.697、ch1 前方 8.9/东墙 3.9、ch2 全无返回。 */
function syntheticRange():Uint8Array{
 const width=181,values=new Array<number>(3*width).fill(NaN)
 for(let s=0;s<width;s++)values[s]=1.6970562748477138
 values[1*width+90]=8.9;values[1*width+180]=3.9
 return buildNpy({descr:'<f8',shape:[3,width],values})
}

describe('P7A2 NPY 解码：只认实际原生小端 float32/64 二维 C 顺序',()=>{
 test('float32 二维 C 顺序，逐元素索引按 row*width+column',()=>{
  const decoded=decodeNpy(buildNpy({descr:'<f4',shape:[2,3],values:[1,2,3,4,5,6]}))
  expect(decoded.dtype).toBe('f4');expect(decoded.shape).toEqual([2,3]);expect(decoded.height).toBe(2);expect(decoded.width).toBe(3)
  expect(decoded.declaredShape).toBe('(2, 3)')
  expect(Array.from(decoded.values)).toEqual([1,2,3,4,5,6])
 })
 test('float64 且保留 NaN/Inf，不把它压成 0',()=>{
  const decoded=decodeNpy(buildNpy({descr:'<f8',shape:[1,4],values:[0,Number.NaN,Infinity,-Infinity]}))
  expect(decoded.dtype).toBe('f8')
  expect(decoded.values[0]).toBe(0)
  expect(Number.isNaN(decoded.values[1])).toBe(true)
  expect(decoded.values[2]).toBe(Infinity)
  expect(decoded.values[3]).toBe(-Infinity)
 })
 test('NPY v2（4 字节头长）也能解',()=>{
  const decoded=decodeNpy(buildNpy({descr:'<f4',shape:[1,2],values:[7,8],version:2}))
  expect(Array.from(decoded.values)).toEqual([7,8])
 })
 test('大端 dtype 显式失败，绝不静默换序冒充真实米数',()=>{
  expect(codeOf(()=>decodeNpy(buildNpy({descr:'>f4',shape:[1,2],values:[1,2]})))).toBe('NPY_BIG_ENDIAN')
 })
 test('不支持的 dtype（整型 / 半精度 / 本机序）显式失败',()=>{
  for(const descr of ['<i4','<f2','=f4','|u1'])expect(codeOf(()=>decodeNpy(buildNpy({descr,shape:[1,2],values:[1,2]})))).toBe('NPY_DTYPE_UNSUPPORTED')
 })
 test('fortran_order=True / 一维 / 三维显式失败',()=>{
  expect(codeOf(()=>decodeNpy(buildNpy({descr:'<f4',shape:[2,2],values:[1,2,3,4],fortran:true})))).toBe('NPY_FORTRAN_ORDER')
  expect(codeOf(()=>decodeNpy(buildNpy({descr:'<f4',shape:[3],values:[1,2,3]})))).toBe('NPY_SHAPE_UNSUPPORTED')
  expect(codeOf(()=>decodeNpy(buildNpy({descr:'<f4',shape:[1,1,3],values:[1,2,3]})))).toBe('NPY_SHAPE_UNSUPPORTED')
  expect(codeOf(()=>decodeNpy(buildNpy({descr:'<f4',shape:[0,3],values:[],declaredShape:'(0, 3)'})))).toBe('NPY_SHAPE_UNSUPPORTED')
 })
 test('坏魔数 / 截断正文 / 头越界显式失败',()=>{
  expect(codeOf(()=>decodeNpy(buildNpy({magic:'NOTNPY',shape:[1,1],values:[1]})))).toBe('NPY_MAGIC_INVALID')
  const full=buildNpy({descr:'<f4',shape:[2,3],values:[1,2,3,4,5,6]})
  expect(codeOf(()=>decodeNpy(full.slice(0,full.length-4)))).toBe('NPY_TRUNCATED')
  expect(codeOf(()=>decodeNpy(new Uint8Array([0x93,0x4e,0x55,0x4d,0x50,0x59,1,0,0xff,0xff])))).toBe('NPY_HEADER_INVALID')
 })
})

describe('P7A2 NPY 统计：有限值算范围，无效值分开计数',()=>{
 test('min/max/mean 只取有限值，NaN/±Inf 各自计数',()=>{
  const stats=npyStats(new Float64Array([1,2,3,Number.NaN,Infinity,-Infinity]))
  expect(stats).toMatchObject({count:6,finiteCount:3,nanCount:1,posInfCount:1,negInfCount:1,min:1,max:3,mean:2})
 })
 test('全无有限值时 min/max/mean 缺省，不拿 0 冒充',()=>{
  const stats=npyStats(new Float64Array([Number.NaN,Infinity]))
  expect(stats.finiteCount).toBe(0);expect(stats.min).toBeUndefined();expect(stats.max).toBeUndefined();expect(stats.mean).toBeUndefined()
 })
})

describe('P7A2 NPY 上色：规则具名、数值可复算、无返回独立成色',()=>{
 test('相机 Depth 灰度：有限值线性映射，近白远黑',()=>{
  const image=colorizeNpy(decodeNpy(buildNpy({descr:'<f4',shape:[1,3],values:[0,5,10]})),CAMERA_DEPTH_COLOR_RULE)
  expect(image.ruleId).toBe('camera-axial-z-gray')
  expect(image.spanMin).toBe(0);expect(image.spanMax).toBe(10);expect(image.invalid).toBe(0)
  expect(rgbaOf(image,0)).toEqual([255,255,255,255])
  expect(rgbaOf(image,1)).toEqual([128,128,128,255])
  expect(rgbaOf(image,2)).toEqual([0,0,0,255])
 })
 test('相机 Depth 近端 >0 时按对数映射，近景层次可复算',()=>{
  const image=colorizeNpy(decodeNpy(buildNpy({descr:'<f8',shape:[1,3],values:[1,4,16]})),CAMERA_DEPTH_COLOR_RULE)
  expect(rgbaOf(image,0)).toEqual([255,255,255,255])
  expect(rgbaOf(image,1)).toEqual([128,128,128,255])
  expect(rgbaOf(image,2)).toEqual([0,0,0,255])
 })
 test('相机 Depth 的 NaN 用独立洋红，不是 0 米黑/白',()=>{
  const image=colorizeNpy(decodeNpy(buildNpy({descr:'<f4',shape:[1,3],values:[0,Number.NaN,10]})),CAMERA_DEPTH_COLOR_RULE)
  expect(image.invalid).toBe(1)
  expect(rgbaOf(image,1)).toEqual([...NPY_INVALID_RGBA])
  expect(rgbaOf(image,0)).not.toEqual([...NPY_INVALID_RGBA])
 })
 test('LiDAR range：按声明量程 t=range/span 复算 R/G，无返回仍独立色',()=>{
  const image=colorizeNpy(decodeNpy(buildNpy({descr:'<f8',shape:[1,3],values:[0,5,10]})),LIDAR_RANGE_COLOR_RULE,{spanM:10})
  expect(image.ruleId).toBe('lidar-range-euclidean-ratio');expect(image.spanMin).toBe(0);expect(image.spanMax).toBe(10)
  expect(rgbaOf(image,0)).toEqual([0,255,64,255])
  expect(rgbaOf(image,1)).toEqual([128,128,64,255])
  expect(rgbaOf(image,2)).toEqual([255,0,64,255])
  const noReturn=colorizeNpy(decodeNpy(buildNpy({descr:'<f8',shape:[1,2],values:[0,Number.NaN]})),LIDAR_RANGE_COLOR_RULE,{spanM:10})
  expect(rgbaOf(noReturn,1)).toEqual([...NPY_INVALID_RGBA]);expect(rgbaOf(noReturn,1)).not.toEqual(rgbaOf(noReturn,0))
 })
 test('两类量的颜色规则 id 不同：不共用一个图例',()=>{
  expect(CAMERA_DEPTH_COLOR_RULE.id).not.toBe(LIDAR_RANGE_COLOR_RULE.id)
 })
})

describe('P7A2 已知几何：真实原生 fixture（在盘时）或等价记录值',()=>{
 test('LiDAR range 3×181：前方 8.9、东墙 3.9、向下 45° 地板 1.697、无返回是 NaN',()=>{
  const decoded=decodeNpy(readFixtureOr('a3ea41c9-eeb6-4331-b4e1-82dc8d6f12e4-range.npy',syntheticRange))
  expect(decoded.dtype).toBe('f8');expect(decoded.shape).toEqual([3,181])
  expect(decoded.values[0*181+0]).toBeCloseTo(1.6970562748477138,9)
  expect(Number.isNaN(decoded.values[1*181+0])).toBe(true)
  expect(decoded.values[1*181+90]).toBeCloseTo(8.9,9)
  expect(decoded.values[1*181+180]).toBeCloseTo(3.9,9)
 })
 test('相机 Depth 240×320 float32 全有限；小端宿主下解码路径成立',()=>{
  const decoded=decodeNpy(readFixtureOr('b7c66412-6a29-4176-9a78-b8ef6f917ec5-depth.npy',()=>buildNpy({descr:'<f4',shape:[240,320],values:new Array(240*320).fill(8.9)})))
  expect(decoded.dtype).toBe('f4');expect(decoded.shape).toEqual([240,320]);expect(decoded.width).toBe(320);expect(decoded.height).toBe(240)
  expect(npyStats(decoded.values).finiteCount).toBe(240*320)
  expect(npyHostIsLittleEndian()).toBe(true)
 })
})
