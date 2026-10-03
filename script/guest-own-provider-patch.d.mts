export function verifiedGuestOwnProviderComposition(root:string,upstream:string):false|'own'|'root'
export function applySignedGuestOwnProviderPatch<T extends {file:string;package:string}>(root:string,upstream:string,patch:T):T&{status:'applied'|'already-applied';verifiedComposition:string}
