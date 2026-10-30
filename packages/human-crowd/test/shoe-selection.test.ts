import { test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

test('显式鞋选择保留整个最低连通部件及UV缝点，排除高权重衣摆；同高歧义拒绝', () => {
  const code = `
import sys,json
sys.path.insert(0,sys.argv[1])
from rocketbox_shoe_selection import lowest_shoe_component
# 两件独立拓扑；低鞋与高衣摆都有高foot权重。鞋四个UV重复点须归回同一分量。
shoe=[[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0],[-1,-1,.1],[1,-1,.1],[1,1,.1],[-1,1,.1]]
cloth=[[x,y,z+.3] for x,y,z in shoe]
points=shoe+cloth+shoe[:4]
faces=[[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7],[16,17,18],[16,18,19]]
faces += [[i+8 for i in face] for face in faces[:8]]
selected,report=lowest_shoe_component(points,faces,range(len(points)),points)
assert selected==list(range(8))+list(range(16,20)),selected
assert [row['count']for row in report['components']]==[12,8]
try:
 two=shoe+[[x+5,y,z]for x,y,z in shoe]
 lowest_shoe_component(two,faces[:8]+[[i+8 for i in f]for f in faces[:8]],range(16),two)
except AssertionError as error:
 assert 'SHOE_LOWEST_COMPONENT_AMBIGUOUS'in str(error)
else:raise AssertionError('同高度独立部件不能猜鞋')
print(json.dumps({'selected':selected,'indicesSha256':report['selectedVertexIndicesSha256']}))
`
  const result = spawnSync('python3', ['-c', code, resolve(import.meta.dirname, '../scripts')], { encoding: 'utf8', timeout: 10_000 })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).selected).toEqual([...Array(8).keys(), 16, 17, 18, 19])
})
