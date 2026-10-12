import type {SceneSnapshot} from '../../lyapunov-contracts/src/types.ts'

/** 点击打开副本即显式选择新场景身份；普通打开保留原有冲突合同。 */
export async function openProjectFile(
 path:string,
 asCopy:boolean,
 command:(input:{path:string;sceneId?:string})=>Promise<SceneSnapshot>,
):Promise<SceneSnapshot>{
 const input=asCopy?{path,sceneId:`scene_${crypto.randomUUID()}`}:{path}
 return command(input)
}
