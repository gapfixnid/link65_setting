import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FirmwareUI} from '../dist/firmware-ui.mjs';
import {FakeUSB,MemoryStorage,destructiveTransfers} from './webusb-helpers.mjs';
import {fixture,tables} from './helpers.mjs';
const binary=new Uint8Array(await readFile(new URL('../dist/firmware/link65-v1.0.2-rc1.bin',import.meta.url)));
const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');

test('UI never starts a firmware transfer when loading a file, backing up, probing or cancelling final confirmation',async()=>{
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([,id])=>[id,{disabled:false,checked:false,dataset:{},files:[],open:false,
    showModal(){this.open=true;},close(){this.open=false;},focus(){}}]));
  const device=new FakeUSB(),errors=[],downloads=[],{client}=await fixture();client.info.firmwareVersion=0x10002;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{usb:{requestDevice:async()=>device,addEventListener(){}}}});
  globalThis.document={getElementById:id=>{assert.ok(elements.has(id),`Unknown real HTML element ${id}`);return elements.get(id);}};
  globalThis.localStorage=new MemoryStorage();globalThis.isSecureContext=true;
  globalThis.fetch=async()=>({ok:true,arrayBuffer:async()=>binary.buffer});
  const ui=new FirmwareUI({getClient:()=>client,tables,saveAutomatic:async()=>{},download:(doc,reason)=>downloads.push({doc,reason}),
    connectKnown:async()=>{},notify:(message,error)=>{if(error)errors.push(message);},run:async(_,operation)=>{try{await operation();}catch(error){errors.push(error.message);}}});
  const el=id=>elements.get(id),settle=async()=>{while(ui.busy)await new Promise(resolve=>setImmediate(resolve));};
  await ui.initialize();
  el('firmware-load-release').onclick();await settle();assert.ok(ui.image);assert.ok(el('firmware-write').disabled);
  el('firmware-backup').onclick();await settle();assert.ok(ui.session.hasConfiguration);assert.equal(downloads[0].reason,'before-firmware');
  el('firmware-dfu-connect').onclick();await settle();assert.ok(ui.dfu?.compatible);assert.equal(errors.length,0);
  assert.ok(el('firmware-write').disabled);assert.equal(destructiveTransfers(device).length,0);
  el('firmware-consent').checked=true;el('firmware-consent').onchange();assert.equal(el('firmware-write').disabled,false);
  el('firmware-write').onclick();assert.equal(el('firmware-write-dialog').open,true);assert.equal(destructiveTransfers(device).length,0);
  el('firmware-write-cancel').onclick();assert.equal(el('firmware-write-dialog').open,false);assert.equal(destructiveTransfers(device).length,0);
  // Revoking consent before final confirmation cannot race into a write.
  el('firmware-consent').checked=false;el('firmware-write-confirm').onclick();await settle();assert.equal(destructiveTransfers(device).length,0);
  const corrupt=binary.slice();corrupt[50]^=1;el('firmware-file').files=[{size:corrupt.length,arrayBuffer:async()=>corrupt.buffer}];
  el('firmware-file').onchange();await settle();assert.equal(ui.image,null);assert.ok(el('firmware-write').disabled);assert.equal(destructiveTransfers(device).length,0);
  assert.equal(errors.length,1);
});
