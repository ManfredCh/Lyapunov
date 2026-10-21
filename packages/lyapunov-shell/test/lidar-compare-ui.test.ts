/**
 * P7A：LiDAR 比较面板的**可见性判据**（`visibleLidarResult`）回归。
 *
 * 主控在真实 LidarScanPanel 组件上复现：换机位 A→B 后，world 身份没变，旧 A 的 scan 仍被显示成 B 的
 * 当前量测。判据必须同时核对**世界身份**（adoptableReceipt：Scene/world/代次）**与相机身份**。
 * 本文件只跑判据函数，不冒充浏览器/原生传感器验收。
 */
import {describe,expect,test} from 'bun:test'
import {visibleLidarResult} from '../src/lidar-scan-panel.tsx'
import type {CameraWorldIdentity} from '../src/capture-panel.tsx'

const identity:CameraWorldIdentity={sceneId:'s',sceneRevision:3,worldId:'w',worldGeneration:2}
const receipt=(over:Record<string,unknown>={})=>({sceneId:'s',sceneRevision:3,worldId:'w',worldGeneration:2,cameraName:'arm/cam-a',resolvedCameraName:'arm/cam-a',rangeMinM:1,...over})

describe('P7A LiDAR比较面板可见性判据',()=>{
  test('同机位且同世界身份可见',()=>{
    expect(visibleLidarResult(receipt(),identity,'arm/cam-a')).toBeDefined()
  })
  test('换机位后旧机位A的scan不得显示为B的当前量测（world身份相同也不行）',()=>{
    expect(visibleLidarResult(receipt(),identity,'arm/cam-b')).toBeUndefined()
  })
  test('本地名与完整解析名都算同一台机位',()=>{
    const row=receipt({cameraName:'cam-a',resolvedCameraName:'entity/arm/cam-a'})
    expect(visibleLidarResult(row,identity,'cam-a')).toBeDefined()
    expect(visibleLidarResult(row,identity,'entity/arm/cam-a')).toBeDefined()
  })
  test('旧world/旧代次的回执作废',()=>{
    expect(visibleLidarResult(receipt({worldGeneration:1}),identity,'arm/cam-a')).toBeUndefined()
    expect(visibleLidarResult(receipt({sceneRevision:2}),identity,'arm/cam-a')).toBeUndefined()
    expect(visibleLidarResult(receipt({worldId:'other'}),identity,'arm/cam-a')).toBeUndefined()
  })
  test('没有选中机位时不显示任何回执',()=>{
    expect(visibleLidarResult(receipt(),identity,undefined)).toBeUndefined()
  })
})
