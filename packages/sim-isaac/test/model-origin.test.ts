import {describe,expect,test} from 'bun:test'
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'

const root=resolve(import.meta.dir,'..')
const python=process.env.LYAPUNOV_ISAAC_PY??process.env.TESTCI_PYTHON??'python3'
const available=spawnSync(python,['-c','from pxr import Gf,Usd,UsdGeom,UsdPhysics; import numpy'],{encoding:'utf8'}).status===0

describe('Isaac Resource origin and native-body pose',()=>{
  test.skipIf(!available)('real USD translation/rotation/scale/anchors preserve the resource origin and native body state',()=>{
    const result=spawnSync(python,['-B',resolve(import.meta.dir,'model-origin-fixture.py'),root],{encoding:'utf8',timeout:30000})
    expect(result.status,result.stderr+result.stdout).toBe(0)
    const report=JSON.parse(result.stdout)
    expect(report.status).toBe('REAL_USD_ORIGIN_CONTRACT_PASS')
    expect(report.cases).toHaveLength(9)
    expect(report.cases[0].rawNativePositionM[2]).toBeCloseTo(.793,8)
    expect(report.cases[0].modelPositionM[2]).toBeCloseTo(0,8)
    expect(report.cases[5].rootMismatchRejected).toBe(true)
    expect(report.cases[6].tensorReadsDuringSnapshot).toBe(0)
    expect(report.cases[6].nativeRootFromOrderedLinks).toBe(true)
    expect(report.cases[7].authoredAnchorRestored).toBe(true)
    expect(report.cases[8].errorCode).toBe('ENTITY_ORIGIN_UNVERIFIED')
  })
})
