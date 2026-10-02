/**
 * G19 的辅助读取器：真读一个 GLB 并报告动画事实。
 *
 * 为什么单独一个文件：Three.js 的 GLTFLoader 必须在**模块**里用（门主体是 node 下的 Cordis 树，
 * 直接内联会让两者耦合）。它只读文件、只报读数，不写任何东西。
 *
 * 输出一行 JSON：`{clips:[{name,duration,tracks,roots}], node?, midAngleDeg?}`
 *  · `clips` —— glTF 里真实的 animation 数组；
 *  · `midAngleDeg` —— 用 AnimationMixer 把 clip 推进到中点后，**被驱动节点相对起点的实际转角**。
 *    这一项才是"动画真能驱动对象"的证据；只看 clips 非空说明不了这一点。
 */
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as THREE from 'three'
import { readFile } from 'node:fs/promises'

const buf = await readFile(process.argv[2])
const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '')
const clips = gltf.animations
const out = {
  clips: clips.map(clip => ({
    name: clip.name,
    duration: Number(clip.duration.toFixed(3)),
    tracks: clip.tracks.length,
    roots: [...new Set(clip.tracks.map(track => track.name.split('.')[0]))],
  })),
}
if (clips.length > 0) {
  const clip = clips[0]
  const names = new Set(clip.tracks.map(track => track.name.split('.')[0]))
  let target = null
  gltf.scene.traverse(object => { if (!target && object.name && names.has(object.name)) target = object })
  if (target) {
    const mixer = new THREE.AnimationMixer(gltf.scene)
    mixer.clipAction(clip).play()
    mixer.setTime(0); const start = target.quaternion.clone()
    mixer.setTime(clip.duration / 2)
    out.midAngleDeg = Number((target.quaternion.angleTo(start) * 180 / Math.PI).toFixed(3))
    out.node = target.name
  }
}
console.log(JSON.stringify(out))
