import {DFU} from '../dist/firmware.mjs';
import {readFileSync} from 'node:fs';
export class FakeUSB {
  constructor(){
    this.vendorId=DFU.vid;this.productId=DFU.pid;this.opened=false;this.state=2;this.pointer=DFU.application;
    this.memory=new Uint8Array(0x10000).fill(0xff);this.transfers=[];this.shortRead=false;this.mutate=false;this.badReadback=false;
    this.configurations=[{configurationValue:1,interfaces:[{interfaceNumber:0,alternates:[{alternateSetting:0,
      interfaceClass:0xfe,interfaceSubclass:1,interfaceProtocol:2,interfaceName:DFU.memoryName}]}]}];
    this.configuration=null;
    this.descriptor=Uint8Array.from([9,2,27,0,1,1,0,0x80,50,9,4,0,0,0,0xfe,1,2,1,9,0x21,3,0,0,0,4,0x1a,1]);
    this.memory.set(readFileSync(new URL('../dist/firmware/link65-v1.0.2-rc1.bin',import.meta.url)).subarray(0,-16),0x6000);
    this.memory.fill(0x5a,0xf000);
  }
  async open(){this.opened=true;}
  async close(){this.opened=false;}
  async selectConfiguration(value){this.configuration=this.configurations.find(c=>c.configurationValue===value);}
  async claimInterface(value){if(value!==0)throw Error('wrong interface');}
  async selectAlternateInterface(intf,alt){if(intf!==0||alt!==0)throw Error('wrong alternate');}
  async controlTransferIn(setup,length){
    this.transfers.push({direction:'in',...setup,length});let data;
    if(setup.requestType==='standard'){
      if(setup.value===0x0300)data=Uint8Array.from([4,3,9,4]);
      else if((setup.value>>8)===3){const encoded=Buffer.from(DFU.memoryName,'utf16le');data=Uint8Array.from([encoded.length+2,3,...encoded]);}
      else data=this.descriptor.slice(0,length);
    }
    else if(setup.request===3){data=Uint8Array.from([0,0,0,0,this.state,0]);if(this.state===4)this.state=5;}
    else if(setup.request===2){
      const address=this.pointer+(setup.value-2)*1024-0x08000000;
      data=this.memory.slice(address,address+length-(this.shortRead?1:0));this.state=9;
      if(this.mutate&&address===0x6000){data[15]^=1;this.mutate=false;}
      if(this.badReadback&&this.written&&address===0x6000)data[15]^=1;
    }else throw Error('Unexpected IN');
    return {status:'ok',data:new DataView(data.buffer,data.byteOffset,data.byteLength)};
  }
  async controlTransferOut(setup,input){
    const data=new Uint8Array(input);this.transfers.push({direction:'out',...setup,data:Array.from(data)});
    if(setup.request===6){this.state=2;return {status:'ok',bytesWritten:0};}
    if(setup.request!==1)throw Error('Unexpected OUT');
    if(setup.value===0&&data[0]===0x21){this.pointer=new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(1,true);this.state=4;}
    else if(setup.value===0&&data[0]===0x41){const address=new DataView(data.buffer).getUint32(1,true)-0x08000000;
      this.memory.fill(0xff,address,address+1024);this.state=4;}
    else if(setup.value===2&&data.length){this.memory.set(data,this.pointer-0x08000000);this.state=4;this.written=true;}
    else if(setup.value===2&&!data.length){this.opened=false;throw Error('NetworkError: device disconnected');}
    else throw Error('Unexpected DNLOAD');
    return {status:'ok',bytesWritten:data.length};
  }
}
export class MemoryStorage {
  constructor(){this.map=new Map();this.fail=false;}
  getItem(key){return this.map.get(key)??null;}
  setItem(key,value){if(this.fail)throw Error('Quota');this.map.set(key,value);}
}
export function destructiveTransfers(device){return device.transfers.filter(t=>t.direction==='out'&&t.request===1&&
  !(t.value===0&&t.data.length===5&&t.data[0]===0x21));}
