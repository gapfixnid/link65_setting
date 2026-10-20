import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {BridgeTransport} from './firmware-transport.mjs';
import {Link65Client,UnsupportedCommand} from '../dist/protocol.mjs';
import {KeyRegistry,MacroCodec,cloneSnapshot,sameSnapshot,toBackup,fromBackup,migrateBackup} from '../dist/model.mjs';

const option=process.argv.indexOf('--firmware-dir');
if(option<0||!process.argv[option+1])throw new Error('Usage: node tools/verify-firmware.mjs --firmware-dir PATH');
const firmwareDir=resolve(process.argv[option+1]);
const tables=JSON.parse(readFileSync(new URL('../dist/assets/keycode-tables.json',import.meta.url)));
const factory=JSON.parse(readFileSync(resolve(firmwareDir,'firmware/factory-keymap.json')));
const transport=new BridgeTransport({firmwareDir}),client=new Link65Client(transport),checks=[];
try {
  const info=await client.identify();
  assert.deepEqual([info.protocol,info.keycodesVersion,info.layers,info.macroCount,info.macroSize],[13,9,4,16,1407]);
  assert.equal(info.writable,true);assert.equal(info.firmwareVersion,0x10002);assert.deepEqual(info.capabilities,{matrix:true,bootloader:false,schema:1});
  checks.push('negotiated protocol, keycodes, capacity, capabilities');
  await assert.rejects(client.enterBootloader(),UnsupportedCommand);
  checks.push('unsupported bootloader entry is refused before sending a command');
  const before=await client.snapshot();assert.deepEqual(before.keymap,factory);assert.ok(before.macros.every(n=>n===0));
  checks.push('all 300 factory keycodes match compiled firmware');
  const registry=new KeyRegistry(tables,13,4,16,9),codec=new MacroCodec(registry),desired=cloneSnapshot(before),backups=[];
  desired.keymap[0][0]=registry.parse('LCTL(KC_C)');desired.keymap[2][30]=registry.parse('MO(2)');
  desired.macros=codec.compose([codec.encode('hello {KC_ENT}{500}{+KC_LCTL}c{-KC_LCTL}')],info.macroSize);
  const after=await client.apply(before,desired,async(s,r)=>backups.push({s,r}));
  assert.ok(sameSnapshot(after,desired));assert.equal(backups.length,1);assert.ok(sameSnapshot(backups[0].s,before));
  checks.push('actual compiled VIA key and macro writes, backups and readback');
  assert.ok(sameSnapshot(fromBackup(toBackup(after),info),after));
  checks.push('modern backup round trip');
  for(let index=0;index<75;index++){const rows=[0,0,0,0,0];rows[Math.floor(index/15)]=1<<(index%15);await transport.setMatrix(rows);assert.deepEqual(await client.readMatrix(),new Set([index]));}
  await transport.setMatrix([0x7fff,0x7fff,0x7fff,0x7fff,0x7fff]);assert.equal((await client.readMatrix()).size,75);
  checks.push('all 75 matrix cells and full matrix in actual compiled custom handler');
  const reset=await client.factoryReset(after,async(s,r)=>backups.push({s,r}));
  assert.deepEqual(reset.keymap,factory);assert.ok(reset.macros.every(n=>n===0));assert.equal(reset.layoutOptions,0);
  checks.push('factory reset uses compiled defaults and clears macros');
  const legacy=JSON.parse(readFileSync(new URL('../dist/assets/factory-keymap.json',import.meta.url)));
  const doc={format:'link65-control-backup',version:1,device:{vid:0x4f53,pid:0x4c49,rows:5,cols:15,protocol:12,layers:4,macro_count:16,macro_size:386},keymap:legacy,macro_buffer_base64:Buffer.alloc(386).toString('base64'),layout_options:0};
  const migrated=migrateBackup(doc,info,tables);assert.deepEqual(migrated.keymap,factory);
  assert.ok(sameSnapshot(await client.apply(reset,migrated,async()=>{}),migrated));
  checks.push('legacy backup migration and restore against compiled firmware');
  const result={physicalDeviceAccessed:false,transport:'Unicorn with EEPROM boundary stubs; actual compiled Cortex-M3 VIA dispatch',info,checks,passed:checks.length};
  mkdirSync('.test-results',{recursive:true});
  writeFileSync(resolve('.test-results/firmware-compatibility.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await transport.close();}
