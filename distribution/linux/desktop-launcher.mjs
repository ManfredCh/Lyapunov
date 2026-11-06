import {spawn} from 'node:child_process'
const [electron,...args]=process.argv.slice(2)
const child=spawn(electron,args,{stdio:['inherit','inherit','inherit','ipc']})
const terminate=signal=>{if(child.connected)child.send({type:'lyapunov:terminate',signal},error=>{if(error)child.kill(signal)});else child.kill(signal)}
process.on('SIGINT',()=>terminate('SIGINT'));process.on('SIGTERM',()=>terminate('SIGTERM'))
process.exitCode=await new Promise(resolve=>{child.once('error',error=>{console.error(error);resolve(1)});child.once('exit',code=>resolve(code??1))})
