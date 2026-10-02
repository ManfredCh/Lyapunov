import {join,resolve} from "node:path"

/** Resolve one desktop instance's private data root without touching the filesystem. */
export function resolveDesktopDataRoot(input:{configured?:string|null;packaged:boolean;defaultUserData:string;productRoot:string;mode:"formal"|"developer"}):string {
  const configured=input.configured?.trim()
  return resolve(configured || (input.packaged ? input.defaultUserData : join(input.productRoot,".runtime/desktop",input.mode)))
}
