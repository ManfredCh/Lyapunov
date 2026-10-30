import { test } from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm}from'node:fs/promises'
import {existsSync}from'node:fs'
import {resolve,join}from'node:path'
import {tmpdir}from'node:os'
import {spawnSync}from'node:child_process'
const assets=process.env.LYAPUNOV_EXTERNAL_HUMAN_ASSETS,python=process.env.LYAPUNOV_MUJOCO_PYTHON,enabled=Boolean(assets&&python&&existsSync(join(assets,'CesiumMan.glb'))&&existsSync(python)),root=resolve(import.meta.dirname,'../../..')
test('官方CesiumMan固定字节/许可→57通道导入→保存重开→真实MuJoCo路径与髋部起伏',{skip:!enabled,timeout:60000},async()=>{const out=await mkdtemp(join(tmpdir(),'external-human-'));try{const r=spawnSync(process.execPath,['--experimental-transform-types',join(root,'packages/human-crowd/scripts/external-character.ts'),'--assets',assets!,'--out',out],{cwd:root,encoding:'utf8',timeout:55000,env:process.env});assert.equal(r.status,0,(r.stderr??'')+(r.stdout??''));const receipt=JSON.parse(await readFile(join(out,'receipt.json'),'utf8'));assert.equal(receipt.status,'PASSED');assert.equal(receipt.closed,true);assert.equal(receipt.import.clip.rotations,19);assert.equal(receipt.import.clip.translations,19);assert.equal(receipt.import.clip.normalizedUnitScales,19);assert.ok(receipt.motion.pelvisMaxM-receipt.motion.pelvisMinM>.05)}finally{await rm(out,{recursive:true,force:true})}})
