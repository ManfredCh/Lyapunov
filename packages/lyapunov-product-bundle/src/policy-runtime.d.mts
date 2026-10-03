export interface PolicyPythonResolution {python:string;source:'env-override'|'package-default'}
export declare const POLICY_CPU_PACKAGE_PATH:string
export declare const POLICY_CPU_WHEEL:{name:string;url:string;bytes:number;sha256:string}
export declare function resolvePolicyPython(root:string,env?:NodeJS.ProcessEnv,options?:{managed?:boolean}):PolicyPythonResolution
export interface PolicyRuntimeCandidate {python:string;provider:'policy-configured'|'policy-cpu'|'mujoco'|'isaac';source:'env-override'|'saved-preference'|'package-default'}
export declare function policyRuntimeCandidates(root:string,env?:NodeJS.ProcessEnv):PolicyRuntimeCandidate[]
export declare function ensurePolicyCpuWheel(root:string):Promise<string>
export declare function checkPolicyCpu(root:string,env?:NodeJS.ProcessEnv,options?:{managed?:boolean}):Record<string,unknown>
