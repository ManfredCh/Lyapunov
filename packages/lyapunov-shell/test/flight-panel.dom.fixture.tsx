import React from 'react'
import {createRoot} from 'react-dom/client'
import {FlightControlPanel} from '../src/flight-control-panel.tsx'
const data=await fetch('/data').then(r=>r.json());const trace:any[]=[];(window as any).flightTrace=trace
const root=createRoot(document.getElementById('root')!);let status='idle'
const command=async(name:string,input:any)=>{trace.push({name,input});if(input.operation==='status')return {status};if(input.operation==='stop'){status='idle';return {stopped:true}};if(input.operation==='reset')return {world:{...data.world,worldGeneration:data.world.worldGeneration+1}};status='running';return {status,jobId:'isolated-dom-flight'}}
const render=(valid=true)=>root.render(<FlightControlPanel entity={data.entity} description={valid?data.description:{...data.description,bodyWrench:{available:false,reason:'MISSING_CONTROL_CONFIG'}}} observation={data.observation} world={data.world} ready command={command} tr={(zh)=>zh} onWorldReset={world=>{(window as any).flightReset=world}}/>);(window as any).flightRender=render;render()
