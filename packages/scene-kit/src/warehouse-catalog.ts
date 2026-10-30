import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {gunzipSync} from 'node:zlib'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import type {SimreadyFetch} from './simready-assets.ts'

export const WAREHOUSE_REPO='nvidia/PhysicalAI-SimReady-Warehouse-01'
export const WAREHOUSE_REVISION='c7fe115cb79c7ddbd0532630d7768b5736b0ecc4'
export const WAREHOUSE_CSV='physical_ai_simready_warehouse_01.csv'
export const warehouseMirror=(path:string,route='resolve')=>`https://hf-mirror.com/datasets/${WAREHOUSE_REPO}/${route}/${WAREHOUSE_REVISION}/${path.split('/').map(encodeURIComponent).join('/')}`
export const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
export const gitBlob=(bytes:Uint8Array)=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
export interface WarehouseFile {path:string;size:number;gitBlob:string;lfsSha256?:string}
export interface WarehouseRow {name:string;catalogPath:string;classification:string;label:string;qCode:string;declaredMass:number|null;massUnit:'unspecified';thumbnailPath?:string}
export interface WarehouseCatalog {rows:WarehouseRow[];files:Map<string,WarehouseFile>;pins:Record<string,any>;csv:Uint8Array;readme:Uint8Array;catalogState:'PINNED_SNAPSHOT'|'MIRROR_VERIFIED';refreshFailure?:string}
export function warehousePath(path:string):string {
 if(!path||path.startsWith('/')||path.includes('\\')||path.includes(':')||path.includes('\0')||path.split('/').some(segment=>segment==='..'||segment==='.'||!segment))throw Error('WAREHOUSE_PATH_UNSAFE: '+path)
 return path
}
/** CSV字段严格按源头解析，支持引号/逗号/换行，不把官方preview URL当浏览器自动请求地址。 */
export function parseWarehouseCsv(text:string):WarehouseRow[]{
 const records:string[][]=[];let row:string[]=[],field='',quoted=false
 for(let i=0;i<text.length;i++){const c=text[i]!
  if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++}else quoted=!quoted}
  else if(c===','&&!quoted){row.push(field);field=''}
  else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(Boolean))records.push(row);row=[];field=''}
  else field+=c
 }
 if(quoted)throw Error('WAREHOUSE_CSV_UNCLOSED_QUOTE')
 if(field||row.length){row.push(field);records.push(row)}
 const header=records.shift()?.map(field=>field.replace(/^\uFEFF/,'').trim())??[]
 for(const field of ['asset_name','relative_path','classification','label','q_code','mass','thumbnail_path'])if(!header.includes(field))throw Error('WAREHOUSE_CSV_COLUMN_MISSING: '+field)
 const rows=records.map(fields=>{if(fields.length!==header.length)throw Error('WAREHOUSE_CSV_ROW_LENGTH_INVALID');const value=Object.fromEntries(header.map((key,index)=>[key,fields[index]!.trim()])),mass=value.mass?Number(value.mass):null
  if(!value.asset_name||mass!==null&&!Number.isFinite(mass))throw Error('WAREHOUSE_CSV_ROW_INVALID')
  return {name:value.asset_name,catalogPath:warehousePath(value.relative_path!),classification:value.classification!,label:value.label!,qCode:value.q_code!,declaredMass:mass===0?0:mass,massUnit:'unspecified' as const,...value.thumbnail_path?{thumbnailPath:warehousePath(value.thumbnail_path)}:{}}
 })
 if(new Set(rows.map(row=>row.catalogPath)).size!==rows.length)throw Error('WAREHOUSE_DUPLICATE_ENTRY')
 return rows
}
export async function loadWarehouseCatalog(options:{refresh?:boolean;fetchBytes?:SimreadyFetch;signal?:AbortSignal}={}):Promise<WarehouseCatalog>{
 const root=resolve(process.env.LYAPUNOV_PRODUCT_ROOT??fileURLToPath(new URL('../../../',import.meta.url)),'packages/scene-kit/source-catalogs/warehouse-01')
 const pins=JSON.parse(await readFile(resolve(root,'pins.json'),'utf8'))
 if(pins.repoId!==WAREHOUSE_REPO||pins.revision!==WAREHOUSE_REVISION)throw Error('WAREHOUSE_SNAPSHOT_REVISION_MISMATCH')
 let csv=await readFile(resolve(root,'catalog.csv'));const readme=await readFile(resolve(root,'README.upstream.md')),compressed=await readFile(resolve(root,'files.json.gz'))
 if(sha256(csv)!==pins.catalogSha256||gitBlob(csv)!==pins.catalogGitBlob||sha256(readme)!==pins.readmeSha256||gitBlob(readme)!==pins.readmeGitBlob||sha256(compressed)!==pins.filesGzipSha256)throw Error('WAREHOUSE_SNAPSHOT_HASH_MISMATCH')
 const raw=gunzipSync(compressed);if(sha256(raw)!==pins.filesSha256)throw Error('WAREHOUSE_FILE_INDEX_HASH_MISMATCH')
 const index=JSON.parse(raw.toString('utf8'));if(index.repoId!==WAREHOUSE_REPO||index.revision!==WAREHOUSE_REVISION||!Array.isArray(index.files))throw Error('WAREHOUSE_FILE_INDEX_REVISION_MISMATCH')
 const files=new Map<string,WarehouseFile>()
 for(const file of index.files){warehousePath(file.path);if(!Number.isSafeInteger(file.size)||file.size<0||!/^[a-f0-9]{40}$/.test(file.gitBlob)||file.lfsSha256&&!/^[a-f0-9]{64}$/.test(file.lfsSha256))throw Error('WAREHOUSE_FILE_IDENTITY_INVALID');files.set(file.path,file)}
 let catalogState:WarehouseCatalog['catalogState']='PINNED_SNAPSHOT',refreshFailure:string|undefined
 if(options.refresh)try{if(!options.fetchBytes)throw Error('WAREHOUSE_FETCH_UNAVAILABLE');const fresh=await options.fetchBytes(warehouseMirror(WAREHOUSE_CSV,'raw'),{signal:options.signal,maxBytes:2*1024*1024});if(sha256(fresh)!==pins.catalogSha256||gitBlob(fresh)!==pins.catalogGitBlob)throw Error('WAREHOUSE_REFRESH_IDENTITY_MISMATCH');csv=Buffer.from(fresh);catalogState='MIRROR_VERIFIED'}catch(error){options.signal?.throwIfAborted();refreshFailure=String(error)}
 const rows=parseWarehouseCsv(csv.toString('utf8'));if(rows.length!==pins.catalogRows)throw Error('WAREHOUSE_CATALOG_COUNT_MISMATCH')
 return {rows,files,pins,csv,readme,catalogState,...refreshFailure?{refreshFailure}:{}}
}
export function warehouseEntry(catalog:WarehouseCatalog,path:string):{row:WarehouseRow;file:WarehouseFile}{
 warehousePath(path)
 const row=catalog.rows.find(row=>row.catalogPath===path)??catalog.rows.find(row=>!/[.]usd[acz]?$/i.test(row.catalogPath)&&['.usd','.usda','.usdc','.usdz'].some(extension=>row.catalogPath+extension===path)&&catalog.files.has(path));if(!row)throw Error('WAREHOUSE_ENTRY_NOT_IN_CATALOG: '+path)
 const names=/\.(usd|usda|usdc|usdz)$/i.test(row.catalogPath)?[row.catalogPath]:['.usd','.usda','.usdc','.usdz'].map(extension=>row.catalogPath+extension)
 const matches=names.flatMap(name=>{const file=catalog.files.get(name);return file?[file]:[]})
 if(matches.length!==1)throw Error('WAREHOUSE_ENTRY_UNRESOLVED: '+row.catalogPath)
 return {row,file:matches[0]!}
}
export function verifyWarehouseFile(bytes:Uint8Array,file:WarehouseFile):void {
 const actual=file.lfsSha256?sha256(bytes):gitBlob(bytes),expected=file.lfsSha256??file.gitBlob
 if(bytes.length!==file.size||actual!==expected)throw Error('WAREHOUSE_FILE_IDENTITY_MISMATCH: '+file.path)
}
