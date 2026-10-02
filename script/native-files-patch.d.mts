export function applySignedFilesPatch(root:string,upstream:string,patch:{file:string;package:string}):{file:string;package:string;status:'applied'|'already-applied';verifiedComposition?:string}
