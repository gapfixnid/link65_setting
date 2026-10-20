import {readFileSync} from 'node:fs';
import {Link65Client,ConnectionError,UnsupportedCommand} from '../dist/protocol.mjs';
export const tables=JSON.parse(readFileSync(new URL('../dist/assets/keycode-tables.json',import.meta.url)));
export const layout=JSON.parse(readFileSync(new URL('../dist/assets/physical-layout.json',import.meta.url)));
export class FakeTransport {
  constructor(protocol=12,keycodesVersion=null){this.protocol=protocol;this.keycodesVersion=keycodesVersion;this.keys=new Uint16Array(300).fill(4);this.macros=new Uint8Array(386);this.layout=0x1234;this.rows=[0,0,0,0,0];this.commands=[];this.failWrite=false;this.failReset=false;}
  async exchange(command,args=[]){
    args=Array.from(args);this.commands.push([command,args]);const r=new Uint8Array(32);r.set([command,...args]);
    const view=new DataView(r.buffer),offset=(args[0]<<8)|args[1];
    if(command===1)view.setUint16(1,this.protocol,false);
    else if(command===17)r[1]=4;
    else if(command===12)r[1]=16;
    else if(command===13)view.setUint16(1,386,false);
    else if(command===2&&args[0]===2)view.setUint32(2,this.layout,false);
    else if(command===2&&args[0]===6&&this.keycodesVersion!==null)view.setUint32(2,this.keycodesVersion,false);
    else if(command===2&&args[0]===3)this.rows.forEach((n,i)=>view.setUint16(3+i*2,n,false));
    else if(command===3)this.layout=((args[1]<<24)|(args[2]<<16)|(args[3]<<8)|args[4])>>>0;
    else if(command===18){const data=new Uint8Array(600),v=new DataView(data.buffer);this.keys.forEach((n,i)=>v.setUint16(i*2,n,false));r.set(data.slice(offset,offset+args[2]),4);}
    else if(command===14)r.set(this.macros.slice(offset,offset+args[2]),4);
    else if(command===5){this.keys[args[0]*75+args[1]*15+args[2]]=(args[3]<<8)|args[4];if(this.failWrite){this.failWrite=false;throw new ConnectionError('Lost ACK');}}
    else if(command===15)this.macros.set(args.slice(3,3+args[2]),offset);
    else if(command===6)this.keys.fill(41);
    else if(command===16){if(this.failReset){this.failReset=false;throw new ConnectionError('Reset failed');}this.macros.fill(0);}
    else throw new UnsupportedCommand('Unknown command');
    return r;
  }
  async close(){}
}
export async function fixture(protocol=12){const transport=new FakeTransport(protocol),client=new Link65Client(transport);await client.identify();const baseline=await client.snapshot(),backups=[];return{transport,client,baseline,backups,backup:async(snapshot,reason)=>backups.push({snapshot,reason})};}
