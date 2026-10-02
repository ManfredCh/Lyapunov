import {expect,test} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {SCENE_COORDINATES,identityTransform,type SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'
import {collisionBindingParameters,explicitBindingMotion,physicsBindingControlKey,bindingMotionChecked,scopedBindingMotion,DEFAULT_COLLISION_BINDING_SETTINGS,FULL_POINT_CLOUD_SETTINGS,FULL_POINT_CLOUD_SURFACE_SETTINGS} from '../src/physics-binding-settings.ts'
import {PhysicsControls,PhysicsProgressReadback} from '../src/physics-controls.tsx'
import {FULL_POINT_CLOUD_TILING} from '../../scene-kit/src/physicalization-parameters.ts'
test('人工明确full方案等于NL同operation参数，默认不暗选full或.1m',()=>{
 expect(collisionBindingParameters(DEFAULT_COLLISION_BINDING_SETTINGS,'environment').voxelSizeM).toBeUndefined()
 expect(collisionBindingParameters(DEFAULT_COLLISION_BINDING_SETTINGS,'environment').pointCloudTiling).toBeUndefined()
 expect(collisionBindingParameters(FULL_POINT_CLOUD_SETTINGS,'environment')).toEqual({strategy:'voxel_boxes',voxelSizeM:.1,maxBoxes:10000,maxOccupiedVoxels:1000000,pointCloudTiling:FULL_POINT_CLOUD_TILING})
 expect(collisionBindingParameters(FULL_POINT_CLOUD_SURFACE_SETTINGS,'environment')).toMatchObject({strategy:'triangle_mesh',voxelSizeM:.1,pointCloudTiling:FULL_POINT_CLOUD_TILING})
 expect(()=>collisionBindingParameters(FULL_POINT_CLOUD_SETTINGS,'dynamic')).toThrow('POINT_CLOUD_TILING_USAGE_INVALID')
 expect(()=>collisionBindingParameters({...FULL_POINT_CLOUD_SETTINGS,maxBoxes:10001},'environment')).toThrow('PHYSICALIZATION_BUDGET_INVALID')
 expect(explicitBindingMotion(false)).toEqual({});expect(explicitBindingMotion(true)).toEqual({type:'static'})
})
test('真实splat实例可人工选择full，空实体不冒充可绑定，本体不重写',()=>{
 const scene:SceneSnapshot={sceneId:'s',revision:2,coordinates:SCENE_COORDINATES,entities:[{entityId:'cloud',name:'cloud',transform:identityTransform(),resources:[{resourceId:'cloud',version:1,original:{uri:'file:///cloud.ply',mimeType:'application/ply'},representations:[],source:{units:'m',upAxis:'Z',handedness:'right'}}],components:{visual:{kind:'splat'}}}]}
 const render=()=>renderToStaticMarkup(<PhysicsControls scene={scene} selected="cloud" tr={cn=>cn} bind={async()=>{}} update={async()=>{}} openLibrary={()=>{}}/>)
 const html=render();expect(html).toContain('全域0.1m采样体素盒');expect(html).toContain('全域0.1m采样表面 · Isaac静态');expect(html).toContain('精度选择');expect(html).toContain('生成并绑定真实碰撞');expect(html).toContain('不自动切换引擎')
 expect(html).toContain('同时固定这个物体');expect(html).not.toContain('checked=""')
 expect(html).not.toContain('生成并绑定真实碰撞</button><button disabled')
 scene.entities[0]!.resources=[];expect(render()).toContain('disabled=""')
 scene.entities[0]!.components={visual:{kind:'robot'},mujoco:{sourcePath:'/local/model.xml'}}
 expect(render()).not.toContain('全域0.1m采样体素盒');expect(render()).toContain('本体约束由原生模型定义')
})
test('回执只按真实阶段/计数显示，资源ok不能冒充世界已可碰撞，失败与取消可读',()=>{
 const render=(value:any)=>renderToStaticMarkup(<PhysicsProgressReadback value={value} tr={cn=>cn}/>)
 const pending=render({status:'pending',progress:{mode:'voxel',facts:{stage:'full-tiled-merge',temporaryBoxes:796633,totalTiles:1024},at:'t'}})
 expect(pending).toContain('全域分块合并');expect(pending).toContain('796633');expect(pending).not.toContain('物理就绪')
 const failed=render({status:'failed',error:'POINT_CLOUD_BOX_BUDGET: 796633 > 10000',errorDetails:{requiredBoxesAtLeast:796633,maxBoxes:10000}})
 expect(failed).toContain('本次未发布碰撞');expect(failed).toContain('796633');expect(failed).toContain('10000')
 expect(render({status:'ok'})).toContain('物理就绪仍需绑定与首帧')
 expect(render({status:'failed',error:'已取消本次碰撞生成'})).toContain('已取消本次碰撞生成')
})
test('明确固定草稿仅属当前Scene/物理实体；跨选择与切回不复用，同key普通revision保留',()=>{
 const selectedA={key:'scene:A',fixed:true}
 expect(bindingMotionChecked(selectedA,'scene:A')).toBe(true);expect(scopedBindingMotion(selectedA,'scene:A')).toEqual({type:'static'})
 expect(bindingMotionChecked(selectedA,'scene:B')).toBe(false);expect(scopedBindingMotion(selectedA,'scene:B')).toEqual({})
 expect(scopedBindingMotion(selectedA,'other:A')).toEqual({})
 const resetB={key:'scene:B',fixed:false}
 expect(scopedBindingMotion(resetB,'scene:A')).toEqual({});expect(scopedBindingMotion(resetB,'scene:B')).toEqual({})
 // revision不属于授权key；同实体收到普通新版本时不清用户草稿。
 expect(scopedBindingMotion(selectedA,'scene:A')).toEqual({type:'static'})
 expect(scopedBindingMotion({...resetB,fixed:true},'scene:B')).toEqual({type:'static'})
 expect(physicsBindingControlKey('scene:a','b')).not.toBe(physicsBindingControlKey('scene','a:b'))
 expect(physicsBindingControlKey('scene','A')).toBe(physicsBindingControlKey('scene','A'))
})
