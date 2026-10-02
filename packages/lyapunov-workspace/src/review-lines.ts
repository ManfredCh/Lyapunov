export interface ReviewLine {text:string;oldLine?:number;newLine?:number;kind:'meta'|'add'|'remove'|'context'}
/** 只解析实际git unified diff的行号，点击旧/新行时沿用Git坐标。 */
export function reviewLines(diff:string):ReviewLine[]{
  let oldLine=0,newLine=0,inHunk=false
  return diff.split('\n').map(text=>{
    const hunk=text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if(hunk){oldLine=Number(hunk[1]);newLine=Number(hunk[2]);inHunk=true;return {text,kind:'meta'}}
    if(text.startsWith('diff --git'))inHunk=false
    if(!inHunk||text.startsWith('\\')||!text)return {text,kind:'meta'}
    if(text.startsWith('+'))return {text,kind:'add',newLine:newLine++}
    if(text.startsWith('-'))return {text,kind:'remove',oldLine:oldLine++}
    if(text.startsWith(' '))return {text,kind:'context',oldLine:oldLine++,newLine:newLine++}
    return {text,kind:'meta'}
  })
}
