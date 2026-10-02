import {describe,expect,test} from "bun:test"
import {appSidePanelGeometry} from "../src/app-side.ts"

describe("应用层工具面板的工作台边界",()=>{
 test("1070×863 窗口内的已知 Camera 点击点位于面板右侧",()=>{
  // 旧 GUI 真实按钮坐标；工作台右界取按钮左界作为保守夹具，不冒充实测工作台 DOMRect。
  const camera={x:919.078125,y:164,width:35,height:36.5},viewport={width:1070,height:863}
  const point={x:camera.x+camera.width/2,y:camera.y+camera.height/2}
  const legacy={left:viewport.width-44-300,right:viewport.width-44,top:0,bottom:viewport.height}
  expect(point.x>legacy.left&&point.x<legacy.right&&point.y>legacy.top&&point.y<legacy.bottom).toBe(true)
  const panel=appSidePanelGeometry({left:280, right:camera.x,top:38,bottom:572},viewport,300)
  const right=viewport.width-panel.right
  expect(right).toBeLessThanOrEqual(camera.x)
  expect(point.x).toBeGreaterThan(right)
  expect(panel).toEqual({top:38,right:150.921875,width:300,height:534})
 })

 test("正常宽度按工作台边界定位，保留工具轨的全部宽度",()=>{
  const viewport={width:1440,height:1000}
  for(const railWidth of [44,46,64]){
   const frame={left:400,right:1320-railWidth,top:60,bottom:900}
   const panel=appSidePanelGeometry(frame,viewport,300),right=viewport.width-panel.right
   expect(right).toBe(frame.right)
   expect(right-panel.width).toBeGreaterThanOrEqual(frame.left)
   expect(panel.top+panel.height).toBe(frame.bottom)
   expect(right).toBeLessThan(1320)
  }
 })

 test("窄工作面让面板收缩，不以最小宽度侵入工具轨或左侧区域",()=>{
  const frame={left:720,right:900,top:80,bottom:700}
  const panel=appSidePanelGeometry(frame,{width:1070,height:863},300)
  expect(panel.width).toBe(180)
  expect(1070-panel.right-panel.width).toBe(frame.left)
  expect(1070-panel.right).toBe(frame.right)
 })

 test("工作台超出窗口或尚未可见时不生成窗口外面板",()=>{
  expect(appSidePanelGeometry({left:-20,right:920,top:-10,bottom:900},{width:1070,height:863},300)).toEqual({top:0,right:150,width:300,height:863})
  expect(appSidePanelGeometry({left:1070,right:1250,top:0,bottom:0},{width:1070,height:863},300)).toEqual({top:0,right:0,width:0,height:0})
 })
})
