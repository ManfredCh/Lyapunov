import {expect,test} from "bun:test"
import {DesktopAccountController} from "../src/account-controller.ts"

test("游客冷入口不读保存账户、不发请求、不造formal账号",async()=>{
  let reads=0,deleted=0,requests=0,guest=0
  const controller=new DesktopAccountController({apiUrl:"https://fixture.invalid",store:{get:async()=>{reads++;return null},set:async()=>{},delete:()=>{deleted++}},openExternal:async()=>{},startHost:async()=>{throw new Error("formal must not start")},startGuestHost:async()=>{guest++},stopHost:async()=>{},changed:()=>{},fetcher:async()=>{requests++;throw new Error("network forbidden")}})
  await controller.enterGuest()
  expect(controller.view()).toMatchObject({status:"guest"})
  expect(controller.view().user).toBeUndefined()
  expect(controller.view().balances).toBeUndefined()
  expect({reads,deleted,requests,guest}).toEqual({reads:0,deleted:0,requests:0,guest:1})
  await controller.logout();expect(deleted).toBe(0)
})
test("游客切换撤销在途账户验证；迟到formal结果不覆盖游客",async()=>{
  let resolveMe!:(value:Response)=>void,signal:AbortSignal|undefined,formal=0
  const response=new Promise<Response>(resolve=>{resolveMe=resolve})
  const controller=new DesktopAccountController({apiUrl:"https://fixture.invalid",store:{get:async()=>JSON.stringify({apiUrl:"https://fixture.invalid",token:"fixture-only"}),set:async()=>{},delete:()=>{throw new Error("saved account must remain")}},openExternal:async()=>{},startHost:async()=>{formal++},startGuestHost:async()=>{},stopHost:async()=>{},changed:()=>{},fetcher:async(_input,init)=>{signal=init?.signal as AbortSignal;return response}})
  const restoring=controller.restore();await Promise.resolve();await Promise.resolve()
  await controller.enterGuest();expect(signal?.aborted).toBe(true)
  resolveMe(Response.json({user:{id:"fixture",email:"fixture@example.test"}}));await restoring
  expect(formal).toBe(0);expect(controller.view().status).toBe("guest")
  await expect(controller.commerce()).rejects.toThrow("AUTH_REQUIRED")
})
test("active guest login/restore/commerce拒在store/API之前，显式leave后formal恢复入口保持",async()=>{
  let reads=0,requests=0,stops=0
  const controller=new DesktopAccountController({apiUrl:"https://fixture.invalid",store:{get:async()=>{reads++;return null},set:async()=>{},delete:()=>{}},openExternal:async()=>{},startHost:async()=>{},startGuestHost:async()=>{},stopHost:async()=>{stops++},changed:()=>{},fetcher:async()=>{requests++;throw Error("no product network")}})
  await controller.enterGuest()
  await expect(controller.restore()).rejects.toThrow("GUEST_PRODUCT_SERVICE_FORBIDDEN")
  await expect(controller.login()).rejects.toThrow("GUEST_PRODUCT_SERVICE_FORBIDDEN")
  await expect(controller.commerce()).rejects.toThrow("AUTH_REQUIRED")
  expect({reads,requests}).toEqual({reads:0,requests:0});expect(controller.view().status).toBe("guest")
  await controller.leaveGuest();await controller.restore()
  expect({reads,requests,stops}).toEqual({reads:1,requests:0,stops:1});expect(controller.view().status).toBe("signed-out")
})
test("guest启动失败仍保游客owner，不因error文案自动恢复账户；显式leave后才可读store",async()=>{
  let reads=0,requests=0
  const controller=new DesktopAccountController({apiUrl:"https://fixture.invalid",store:{get:async()=>{reads++;return null},set:async()=>{},delete:()=>{}},openExternal:async()=>{},startHost:async()=>{},startGuestHost:async()=>{throw Error("fixture guest startup failure")},stopHost:async()=>{},changed:()=>{},fetcher:async()=>{requests++;throw Error("no product network")}})
  await controller.enterGuest();expect(controller.view().status).toBe("error")
  await expect(controller.restore()).rejects.toThrow("GUEST_PRODUCT_SERVICE_FORBIDDEN")
  await expect(controller.login()).rejects.toThrow("GUEST_PRODUCT_SERVICE_FORBIDDEN")
  expect({reads,requests}).toEqual({reads:0,requests:0})
  await controller.leaveGuest();await controller.restore();expect(reads).toBe(1)
})

test('游客error返回登录清错误并正常停Host，不读账号/恢复/服务器/删除存储',async()=>{
 let reads=0,requests=0,deletes=0,stops=0
 const controller=new DesktopAccountController({apiUrl:'https://fixture.invalid',store:{get:async()=>{reads++;return null},set:async()=>{},delete:()=>{deletes++}},openExternal:async()=>{},startHost:async()=>{},startGuestHost:async()=>{},stopHost:async()=>{stops++},changed:()=>{},fetcher:async()=>{requests++;throw Error('network forbidden')}})
 await controller.enterGuest();controller.workspaceFailed('client activation failed')
 expect(controller.view().status).toBe('error');await controller.returnToLogin()
 expect(controller.view()).toEqual({status:'signed-out'});expect({reads,requests,deletes,stops}).toEqual({reads:0,requests:0,deletes:0,stops:1})
})

test('未验证身份的error返回登录只清在途/错误，不访问服务器或删除凭据',async()=>{
 let deletes=0,requests=0
 const controller=new DesktopAccountController({apiUrl:'https://fixture.invalid',store:{get:async()=>null,set:async()=>{},delete:()=>{deletes++}},openExternal:async()=>{},startHost:async()=>{},stopHost:async()=>{},changed:()=>{},fetcher:async()=>{requests++;throw Error('network forbidden')}})
 controller.workspaceFailed('client load failed');await controller.returnToLogin()
 expect(controller.view()).toEqual({status:'signed-out'});expect({deletes,requests}).toEqual({deletes:0,requests:0})
})
