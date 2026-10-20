import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DFU,RELEASE,Link65DFU,UpdateSession,validateImage,UPDATE_KEY} from '../dist/firmware.mjs';
import {FakeUSB,MemoryStorage,destructiveTransfers} from './webusb-helpers.mjs';
import {fixture,tables} from './helpers.mjs';
const file=new Uint8Array(await readFile(new URL('../dist/firmware/link65-v1.0.2-rc1.bin',import.meta.url)));
const open=async device=>{const dfu=new Link65DFU(device,{sleep:async()=>{}});await dfu.open();return dfu;};
async function prepared(){const config=await fixture(),storage=new MemoryStorage(),session=new UpdateSession(storage);config.client.info.firmwareVersion=0x10002;await session.prepare(config.client);return{...config,session,storage};}
async function inspected(){const p=await prepared(),device=new FakeUSB(),dfu=await open(device),inspection=await dfu.inspect();await p.session.storeInspection(inspection);return{...p,device,dfu,inspection};}

test('approved binary is hash checked and its 16-byte DFU suffix is excluded from Flash',async()=>{
  const image=await validateImage(file);assert.equal(image.payload.length,RELEASE.payloadBytes);assert.equal(file.length-image.payload.length,16);
  const corrupt=file.slice();corrupt[100]^=1;await assert.rejects(validateImage(corrupt),/일치/);
  await assert.rejects(validateImage(file.subarray(16)),/일치/);
});
test('wrong VID/PID, DFU class, memory map and transfer descriptor fail before any erase',async()=>{
  for(const change of [d=>d.vendorId=0x0483,d=>d.productId=0xdf11,d=>d.configurations[0].interfaces[0].alternates[0].interfaceClass=3,
    d=>d.configurations[0].interfaces[0].alternates[0].interfaceName='@Other Flash',d=>d.descriptor[24]=2]){
    const device=new FakeUSB();change(device);await assert.rejects(open(device));assert.equal(destructiveTransfers(device).length,0);
  }
});
test('compatibility reads application 36KiB and settings 4KiB twice, without erase/download/leave',async()=>{
  const device=new FakeUSB(),dfu=await open(device),result=await dfu.inspect();
  assert.equal(result.application.length,0x9000);assert.equal(result.settings.length,0x1000);
  assert.equal(result.report.audit.uploadedBytes,2*0xa000);assert.equal(result.report.audit.addressCommands,4);
  assert.equal(result.report.firmwareWritten,false);assert.equal(destructiveTransfers(device).length,0);assert.ok(dfu.compatible);
});
test('an omitted cached interface name is read from the USB string descriptor before accepting the memory map',async()=>{
  const device=new FakeUSB();device.configurations[0].interfaces[0].alternates[0].interfaceName=null;
  const dfu=await open(device);assert.ok(dfu.descriptor.canUpload);
  assert.ok(device.transfers.some(t=>t.value===0x0301&&t.index===0x0409));assert.equal(destructiveTransfers(device).length,0);
});
test('short reads, changing reads and invalid application vectors refuse compatibility',async()=>{
  for(const change of [d=>d.shortRead=true,d=>d.mutate=true,d=>d.memory.fill(0xff,0x6000,0x6008)]){
    const device=new FakeUSB(),dfu=await open(device);change(device);await assert.rejects(dfu.inspect());assert.equal(dfu.compatible,false);
    assert.equal(destructiveTransfers(device).length,0);
  }
});
test('concurrent DFU operations cannot share an address pointer',async()=>{
  const dfu=await open(new FakeUSB()),inspection=dfu.inspect();await assert.rejects(dfu.inspect(),/진행/);await inspection;
});
test('transfer timeouts invalidate the session and do not allow a later write',async()=>{
  const device=new FakeUSB(),dfu=await open(device);dfu.timeout=10;device.controlTransferIn=()=>new Promise(()=>{});
  await assert.rejects(dfu.inspect(),/초과/);assert.equal(dfu.compatible,false);assert.equal(destructiveTransfers(device).length,0);
});
test('configuration backup is made from stable actual reads and survives a page reload',async()=>{
  const {session,storage,baseline}=await prepared();const reloaded=new UpdateSession(storage);await reloaded.load();
  assert.ok(reloaded.hasConfiguration);assert.deepEqual(reloaded.export().configuration.keymap,baseline.keymap);assert.equal(reloaded.phase,'prepared');
});
test('storage errors and corrupted persisted backups fail closed',async()=>{
  const {client,storage,session}=await prepared();storage.fail=true;await assert.rejects(session.prepare(client),/보관/);
  storage.fail=false;storage.setItem(UPDATE_KEY,JSON.stringify({payload:'{}',sha256:'000'}));await assert.rejects(new UpdateSession(storage).load(),/손상/);
});
test('configuration changing between backup reads does not create a prepared session',async()=>{
  const {client}=await fixture();const read=client.snapshot.bind(client);let count=0;client.snapshot=async()=>{const s=await read();s.keymap[0][0]=++count;return s;};
  const session=new UpdateSession(new MemoryStorage());await assert.rejects(session.prepare(client),/두 번/);assert.equal(session.hasConfiguration,false);
});
test('Flash backups persist exact bytes and report hashes, without network operations',async()=>{
  const {session,storage,inspection}=await inspected();assert.ok(session.hasFlashBackup);const other=new UpdateSession(storage);await other.load();
  assert.ok(await other.matchesFlash(inspection));assert.ok(other.summary.compatibility.passed);
});
test('downloaded recovery backup can be reimported, but does not authorize a new DFU connection to write',async()=>{
  const {session,inspection}=await inspected(),fresh=new UpdateSession(new MemoryStorage());await fresh.import(session.export());
  assert.ok(await fresh.matchesFlash(inspection));assert.ok(fresh.hasConfiguration);
  const device=new FakeUSB(),dfu=await open(device);await assert.rejects(dfu.flash(file,{confirmed:true,session:fresh}),/최종 확인/);
  assert.equal(destructiveTransfers(device).length,0);
  const corrupt=session.export();corrupt.flash.application=corrupt.flash.settings;
  await assert.rejects(fresh.import(corrupt),/해시/);
});
test('an interrupted unverified write never passes post-update version verification',async()=>{
  const {session,client}=await prepared();await session.mark('writing',{writeAttempted:true,targetFirmwareVersion:client.info.firmwareVersion});
  const result=await session.checkNormal(client,tables);assert.equal(result.report.versionMatches,false);assert.equal(session.phase,'needs-attention');
});
test('flash is blocked without an explicit confirmation, configuration backup or current passed probe',async()=>{
  const {dfu,session,device}=await inspected();
  await assert.rejects(dfu.flash(file,{session}),/최종 확인/);
  // Failed preconditions invalidate the old probe, requiring a fresh read.
  await assert.rejects(dfu.flash(file,{confirmed:true,session}),/최종 확인/);
  assert.equal(destructiveTransfers(device).length,0);
});
test('changed Flash after a passed probe prevents all erase and firmware downloads',async()=>{
  const {dfu,session,device}=await inspected();device.memory[0x6100]^=1;
  await assert.rejects(dfu.flash(file,{confirmed:true,session}),/바뀌었/);assert.equal(destructiveTransfers(device).length,0);
});
test('an unknown application using the same DFU VID/PID is readable but cannot be flashed',async()=>{
  const {session}=await prepared(),device=new FakeUSB();device.memory[0x6120]^=1;
  const dfu=await open(device),inspection=await dfu.inspect();await session.storeInspection(inspection);
  assert.equal(inspection.report.installedImage,null);await assert.rejects(dfu.flash(file,{confirmed:true,session}),/Link65용/);
  assert.equal(destructiveTransfers(device).length,0);
});
test('a source firmware version different from the normal-mode backup blocks all writes',async()=>{
  const {session,client}=await prepared();client.info.firmwareVersion=0x10001;await session.prepare(client);
  const device=new FakeUSB(),dfu=await open(device);await session.storeInspection(await dfu.inspect());
  await assert.rejects(dfu.flash(file,{confirmed:true,session}),/버전/);assert.equal(destructiveTransfers(device).length,0);
});
test('backup persistence failure before writing prevents all destructive transfers',async()=>{
  const {dfu,session,device,storage}=await inspected();storage.fail=true;
  await assert.rejects(dfu.flash(file,{confirmed:true,session}),/보관/);assert.equal(destructiveTransfers(device).length,0);
});
test('simulated update writes only approved application pages and preserves bootloader and settings',async()=>{
  const {dfu,session,device}=await inspected(),before=device.memory.slice();
  const result=await dfu.flash(file,{confirmed:true,session});assert.equal(result.payloadReadbackEqual,true);
  assert.equal(result.settingsFlashPreserved,true);assert.equal(session.phase,'written-verified');
  assert.deepEqual(device.memory.slice(0,0x6000),before.slice(0,0x6000));assert.deepEqual(device.memory.slice(0xf000),before.slice(0xf000));
  assert.deepEqual(device.memory.slice(0x6000,0x6000+RELEASE.payloadBytes),file.slice(0,-16));
  const erase=destructiveTransfers(device).filter(t=>t.value===0);assert.equal(erase.length,24);
  assert.ok(erase.every(t=>t.data.length===5&&t.data[0]===0x41));assert.equal(result.audit.downloadedBytes,RELEASE.payloadBytes);
  assert.equal(destructiveTransfers(device).filter(t=>t.value===2&&!t.data.length).length,0);
});
test('firmware readback mismatch leaves the device in DFU and blocks normal-mode leave',async()=>{
  const {dfu,session,device}=await inspected();device.badReadback=true;
  await assert.rejects(dfu.flash(file,{confirmed:true,session}),/다시 읽기/);
  await assert.rejects(dfu.leave({confirmed:true,session}),/검증/);assert.equal(device.opened,true);
});
test('read-only probe can leave via command-only DfuSe without sending firmware bytes',async()=>{
  const {dfu,session,device}=await inspected();await dfu.leave({confirmed:true,session});
  assert.equal(session.phase,'awaiting-normal');assert.equal(session.summary.firmwareWritten,false);
  const destructive=destructiveTransfers(device);assert.equal(destructive.length,1);assert.equal(destructive[0].data.length,0);
});
test('normal reconnect verifies every configuration byte and issues no configuration writes',async()=>{
  const {session,client,transport}=await prepared();const start=transport.commands.length;
  const {report}=await session.checkNormal(client,tables);assert.ok(report.settingsPreserved);assert.equal(report.configurationWrites,0);
  assert.equal(session.phase,'complete');assert.equal(transport.commands.slice(start).filter(([c])=>[3,5,6,15,16].includes(c)).length,0);
});
test('changed settings can be explicitly restored with a new backup and final readback',async()=>{
  const {session,client,transport}=await prepared();transport.keys[7]=41;let backups=0;
  const before=await session.checkNormal(client,tables);assert.equal(before.report.settingsPreserved,false);
  const after=await session.restore(client,tables,async()=>{backups++;});assert.ok(after.report.settingsPreserved);assert.equal(backups,1);
});
