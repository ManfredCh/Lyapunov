import {test,expect} from 'bun:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SceneOperations} from '../../scene-kit/src/operations.ts'
import {openProjectFile} from '../src/project-open.ts'

test('真实工程保存后冲突，显式打开副本保留原场景、实体组件与资源身份',async()=>{
 const root=await mkdtemp(join(tmpdir(),'project-reopen-'))
 try{
  const ops=new SceneOperations(join(root,'data')),file=join(root,'saved.scene.json')
  let original=await ops.create({sceneId:'original',template:'physics-workspace'})
  const mesh=join(root,'triangle.glb')
  const json=Buffer.from(JSON.stringify({asset:{version:'2.0'},scenes:[{nodes:[]}],scene:0})),chunk=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)])
  const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(20+chunk.length,8);header.writeUInt32LE(chunk.length,12);header.writeUInt32LE(0x4e4f534a,16)
  await writeFile(mesh,Buffer.concat([header,chunk]))
  await ops.import({sceneId:original.sceneId,path:mesh,physicalize:false})
  original=await ops.inspect(original.sceneId)
  await ops.save(original.sceneId,file,{portable:true})
  const first=await openProjectFile(file,false,input=>ops.open(input.path,input))
  expect(first?.sceneId).toBe(original.sceneId)
  // 保存后目录中的同 ID 场景已有另一个版本：原保护必须拒绝覆盖。
  const changed=await ops.scene.commit({sceneId:original.sceneId,expectedRevision:original.revision,patch:[{op:'update',entityId:original.entities[0]!.entityId,changes:{name:'用户当前编辑'}}]})
  await expect(openProjectFile(file,false,input=>ops.open(input.path,input))).rejects.toThrow('SCENE_ALREADY_EXISTS')
  const copy=await openProjectFile(file,true,input=>ops.open(input.path,input))
  expect(copy?.sceneId).not.toBe(original.sceneId)
  expect(copy?.entities).toEqual(first?.entities)
  expect(copy?.entities.flatMap(entity=>entity.resources).length).toBeGreaterThan(0)
  expect(copy?.entities.flatMap(entity=>entity.resources)).toEqual(first?.entities.flatMap(entity=>entity.resources))
  expect(await ops.inspect(original.sceneId)).toEqual(changed)
  expect((await ops.list()).map(scene=>scene.sceneId).sort()).toEqual([original.sceneId,copy!.sceneId].sort())
 }finally{await rm(root,{recursive:true,force:true})}
})
test('其他错误原样传播',async()=>{
 const error=new Error('PATH_OUTSIDE_WORKSPACE')
 await expect(openProjectFile('scene.json',true,async()=>{throw error})).rejects.toBe(error)
})
