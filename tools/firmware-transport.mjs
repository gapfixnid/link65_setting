import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {ConnectionError,UnsupportedCommand} from '../dist/protocol.mjs';

export class BridgeTransport {
  constructor({python='python',firmwareDir}={}) {
    if(!firmwareDir)throw new Error('Supply an explicit firmwareDir for the emulator.');
    this.closed=false;this.invalidated=false;this.sequence=0;this.pending=new Map();this.tail=Promise.resolve();
    this.child=spawn(python,[resolve(firmwareDir,'tools/bridge.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.errors='';this.child.stderr.on('data',chunk=>{this.errors+=chunk;});
    createInterface({input:this.child.stdout}).on('line',line=>{
      const data=JSON.parse(line),waiter=this.pending.get(data.id);if(!waiter)return;this.pending.delete(data.id);
      if(data.error)waiter.reject(data.error==='UnsupportedCommand'?new UnsupportedCommand(data.message):new ConnectionError(data.message));
      else if(data.value[0]===255)waiter.reject(new UnsupportedCommand('이 명령은 지원되지 않습니다.'));
      else waiter.resolve(Uint8Array.from(data.value));
    });
    this.child.on('exit',code=>{for(const item of this.pending.values())item.reject(new ConnectionError(`HID bridge stopped (${code}). ${this.errors}`));this.pending.clear();});
  }
  send(message) {
    const operation=this.tail.then(()=>{
      if(this.closed||this.invalidated)throw new ConnectionError('새 연결이 필요합니다.');
      return new Promise((resolve,reject)=>{const id=++this.sequence;this.pending.set(id,{resolve,reject});this.child.stdin.write(JSON.stringify({...message,id})+'\n');});
    });
    this.tail=operation.catch(error=>{if(!(error instanceof UnsupportedCommand)){this.invalidated=true;this.child.stdin.end();}});
    return operation;
  }
  exchange(command,args=[]){return this.send({command,args:Array.from(args)});}
  setMatrix(rows){return this.send({op:'matrix',rows});}
  async close(){if(this.closed)return;this.closed=true;this.child.stdin.end();}
}
