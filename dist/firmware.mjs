// Link65-only DfuSe transport. No mass erase, protection commands or bootloader writes.
import {equalBytes,fromBackup,toBackup,sameSnapshot,migrateBackup} from './model.mjs';

export const DFU = Object.freeze({vid:0x1688,pid:0x2220,configuration:1,interface:0,alternate:0,
  application:0x08006000,applicationEnd:0x0800f000,settings:0x0800f000,end:0x08010000,
  pageSize:1024,transferSize:1024,memoryName:'@Internal Flash /0x08000000/22*001Ka,106*001Kg'});
export const RELEASE = Object.freeze({version:'1.0.2-rc1',firmwareVersion:0x00010002,
  file:'./firmware/link65-v1.0.2-rc1.bin',bytes:23864,payloadBytes:23848,
  sha256:'c33fdae03fe7e41e358c69ca560c54299c52e1d5d9b4a0cd95017332ac148285'});
export const UPDATE_KEY='link65-studio-firmware-session-v1';
const KNOWN_APPLICATIONS=[
  {version:'1.0.2-rc1',firmwareVersion:0x10002,bytes:23848,sha256:'666fcf59536767f2f92415a151884a1d140d7e2ac49d7ba7a58b390a6a2c88b1'},
  {version:'1.0.1',firmwareVersion:0x10001,bytes:23856,sha256:'3c969ce3dc4cbd53e3cc8e8f8de1a71921b8a0492bc7e8646b4655f837ac8a22'},
  {version:'Owlab VIA V3',firmwareVersion:0,bytes:25668,sha256:'1ebc20d79464701ac98d5d7a16436434be95183ff1ecd4fcc430eead1837ad04'}
];
export class FirmwareError extends Error {}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const bytes=data=>data instanceof Uint8Array?data.slice():new Uint8Array(data).slice();
const view=data=>new DataView(data.buffer,data.byteOffset,data.byteLength);
export const hex32=n=>`0x${n.toString(16).toUpperCase().padStart(8,'0')}`;
export async function sha256(data){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('');}
const encode=data=>btoa(String.fromCharCode(...data));
const decode=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
const symmetricSnapshot=(a,b)=>sameSnapshot(a,b)&&sameSnapshot(b,a);

function checkRange(address,length,write=false){
  if(!Number.isSafeInteger(address)||!Number.isSafeInteger(length)||length<=0||address<DFU.application||
    address+length>(write?DFU.applicationEnd:DFU.end))throw new FirmwareError('허용된 Link65 메모리 범위를 벗어났습니다.');
}
function checkVector(data){
  if(data.length<8)throw new FirmwareError('펌웨어 벡터가 없습니다.');
  const v=view(data),sp=v.getUint32(0,true),reset=v.getUint32(4,true);
  if(sp<0x20000000||sp>0x20005000||sp%8||!(reset&1)||(reset&~1)<DFU.application||
    (reset&~1)>=DFU.applicationEnd)throw new FirmwareError('Link65 애플리케이션의 시작 주소가 올바르지 않습니다.');
}
function crc32(data){let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return crc>>>0;}
export async function validateImage(input){
  const file=bytes(input);
  if(file.length!==RELEASE.bytes||await sha256(file)!==RELEASE.sha256)
    throw new FirmwareError('검증된 Link65 Studio 펌웨어 파일과 일치하지 않습니다.');
  const suffix=file.subarray(-16),s=view(suffix);
  if(String.fromCharCode(...suffix.subarray(8,11))!=='UFD'||suffix[11]!==16||
    s.getUint32(12,true)!==crc32(file.subarray(0,-4)))throw new FirmwareError('DFU 파일의 꼬리표 또는 CRC가 올바르지 않습니다.');
  const payload=file.slice(0,-16);checkRange(DFU.application,payload.length,true);checkVector(payload);
  return {release:RELEASE,payload,sha256:RELEASE.sha256};
}

function selectInterface(device){
  if(device.vendorId!==DFU.vid||device.productId!==DFU.pid)throw new FirmwareError('Link65 업데이트 장치를 선택해 주세요.');
  const config=device.configurations?.find(c=>c.configurationValue===DFU.configuration);
  const intf=config?.interfaces.find(i=>i.interfaceNumber===DFU.interface);
  const alt=intf?.alternates.find(a=>a.alternateSetting===DFU.alternate);
  if(!alt||alt.interfaceClass!==0xfe||alt.interfaceSubclass!==1||alt.interfaceProtocol!==2||
    (alt.interfaceName!=null&&alt.interfaceName.replace(/\s+/g,'')!==DFU.memoryName.replace(/\s+/g,'')))
    throw new FirmwareError('기대하는 Link65 DfuSe 인터페이스와 메모리 구성이 아닙니다.');
  return alt;
}
function functionalDescriptor(data){
  let selected=false,interfaceStringIndex=0;
  for(let offset=0;offset+2<=data.length;){
    const length=data[offset];if(length<2||offset+length>data.length)break;
    if(data[offset+1]===4&&length===9){selected=data[offset+2]===0&&data[offset+3]===0&&data[offset+5]===0xfe&&data[offset+6]===1&&data[offset+7]===2;interfaceStringIndex=data[offset+8];}
    if(selected&&data[offset+1]===0x21&&length===9){const v=view(data.subarray(offset,offset+length));
      if((data[offset+2]&3)!==3||v.getUint16(5,true)!==DFU.transferSize||v.getUint16(7,true)!==0x011a)
        throw new FirmwareError('읽기·쓰기 지원, 전송 크기 또는 DfuSe 버전을 확인할 수 없습니다.');
      return {transferSize:DFU.transferSize,version:'1.1a',canUpload:true,canDownload:true,interfaceStringIndex};
    }
    offset+=length;
  }
  throw new FirmwareError('DFU 기능 설명자를 찾지 못했습니다.');
}

export class Link65DFU {
  #compatible=null; #busy=false; #invalid=false; #permitWrite=false;
  constructor(device,{timeout=5000,sleep=wait}={}){
    this.device=device;this.timeout=timeout;this.sleep=sleep;this.descriptor=null;
    this.audit={controlTransfers:0,addressCommands:0,uploadedBytes:0,erasedPages:0,downloadedBytes:0,leaveCommands:0};
  }
  static request(usb=navigator.usb){return usb.requestDevice({filters:[{vendorId:DFU.vid,productId:DFU.pid}]});}
  get compatible(){return Boolean(this.#compatible&&!this.#invalid&&this.device.opened);}
  async #io(promise){
    let timer;
    try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{
      this.#invalid=true;this.#compatible=null;reject(new FirmwareError('USB 응답 시간이 초과됐습니다. 장치를 다시 연결해 주세요.'));},this.timeout);})]);}
    catch(error){this.#invalid=true;this.#compatible=null;throw new FirmwareError(`WebUSB 통신 실패: ${error.message}`);}
    finally{clearTimeout(timer);}
  }
  #ready(){if(this.#invalid||!this.device.opened)throw new FirmwareError('DFU 연결을 새로 열어 주세요.');}
  async #in(request,value,length,standard=false,language=0){
    this.#ready();this.audit.controlTransfers++;
    const result=await this.#io(this.device.controlTransferIn({requestType:standard?'standard':'class',
      recipient:standard?'device':'interface',request,value,index:standard?language:DFU.interface},length));
    if(result.status!=='ok'||!result.data)throw new FirmwareError('USB 읽기 응답이 올바르지 않습니다.');
    return new Uint8Array(result.data.buffer,result.data.byteOffset,result.data.byteLength).slice();
  }
  async #out(request,value=0,data=new Uint8Array()){
    this.#ready();this.audit.controlTransfers++;
    // DFU_DNLOAD also carries the harmless DfuSe address-pointer command.
    if(request===1){
      if(value===0&&data.length===5&&data[0]===0x21)this.audit.addressCommands++;
      else if(!this.#permitWrite)throw new FirmwareError('읽기 검증 중에는 삭제·기록·실행 명령을 보낼 수 없습니다.');
      else if(value===0&&data.length===5&&data[0]===0x41){
        const address=view(data).getUint32(1,true);checkRange(address,DFU.pageSize,true);
        if(address%DFU.pageSize)throw new FirmwareError('삭제 주소가 페이지 경계에 맞지 않습니다.');this.audit.erasedPages++;
      }else if(value===2&&data.length)this.audit.downloadedBytes+=data.length;
      else if(value===2&&!data.length)this.audit.leaveCommands++;
      else throw new FirmwareError('허용하지 않는 DfuSe 기록 명령입니다.');
    }else if(![4,6].includes(request))throw new FirmwareError('허용하지 않는 DFU 제어 명령입니다.');
    const result=await this.#io(this.device.controlTransferOut({requestType:'class',recipient:'interface',request,value,index:DFU.interface},data));
    if(result.status!=='ok'||result.bytesWritten!==data.length)throw new FirmwareError('USB 전송이 끝까지 완료되지 않았습니다.');
  }
  async #status(){const data=await this.#in(3,0,6);if(data.length!==6)throw new FirmwareError('DFU 상태 응답 길이가 올바르지 않습니다.');
    if(data[0])throw new FirmwareError(`부트로더가 DFU 오류 ${data[0]}를 응답했습니다.`);
    return {state:data[4],poll:data[1]|data[2]<<8|data[3]<<16};}
  async #idle(){const status=await this.#status();if(status.state===2)return;
    if(![5,9].includes(status.state))throw new FirmwareError(`DFU 대기 상태가 아닙니다 (${status.state}). USB를 다시 연결해 주세요.`);
    await this.#out(6);if((await this.#status()).state!==2)throw new FirmwareError('DFU 대기 상태로 전환하지 못했습니다.');}
  async #downloadDone(){
    const deadline=Date.now()+15000;
    for(let count=0;count<80;count++){
      if(Date.now()>deadline)break;
      const status=await this.#status();if(status.state===5)return;
      if(![3,4].includes(status.state)||status.poll>5000)throw new FirmwareError('DfuSe 명령 처리 상태가 예상과 다릅니다.');
      await this.sleep(Math.max(1,status.poll));
    }
    throw new FirmwareError('DfuSe 명령 완료를 확인하지 못했습니다.');
  }
  async #command(command,address){
    const data=new Uint8Array(5);data[0]=command;view(data).setUint32(1,address,true);
    await this.#out(1,0,data);await this.#downloadDone();
  }
  async open(){
    const alternate=selectInterface(this.device);
    try{
      if(!this.device.opened)await this.#io(this.device.open());
      if(this.device.configuration?.configurationValue!==DFU.configuration)await this.#io(this.device.selectConfiguration(DFU.configuration));
      await this.#io(this.device.claimInterface(DFU.interface));
      await this.#io(this.device.selectAlternateInterface(DFU.interface,DFU.alternate));
      const header=await this.#in(6,0x0200,9,true);
      if(header.length!==9)throw new FirmwareError('USB 구성 설명자를 읽지 못했습니다.');
      const length=view(header).getUint16(2,true);if(length<18||length>4096)throw new FirmwareError('USB 구성 설명자 길이가 올바르지 않습니다.');
      const descriptor=await this.#in(6,0x0200,length,true);
      if(descriptor.length!==length)throw new FirmwareError('USB 구성 설명자가 잘렸습니다.');
      this.descriptor=functionalDescriptor(descriptor);
      if(alternate.interfaceName==null){
        const index=this.descriptor.interfaceStringIndex;if(!index)throw new FirmwareError('DFU 메모리 이름을 확인할 수 없습니다.');
        const languages=await this.#in(6,0x0300,255,true);
        if(languages.length<4||languages[1]!==3)throw new FirmwareError('USB 문자열 언어 설명자가 올바르지 않습니다.');
        const language=view(languages).getUint16(2,true),name=await this.#in(6,0x0300|index,255,true,language);
        if(name.length<2||name[1]!==3||name[0]!==name.length||name.length%2)throw new FirmwareError('DFU 메모리 문자열이 올바르지 않습니다.');
        const text=new TextDecoder('utf-16le').decode(name.subarray(2));
        if(text.replace(/\s+/g,'')!==DFU.memoryName.replace(/\s+/g,''))throw new FirmwareError('기대하는 Link65 메모리 구성이 아닙니다.');
      }
      await this.#idle();return this;
    }catch(error){await this.close();throw error;}
  }
  async #exclusive(operation){
    if(this.#busy)throw new FirmwareError('다른 DFU 작업이 진행 중입니다.');this.#busy=true;
    try{return await operation();}catch(error){this.#compatible=null;throw error;}finally{this.#permitWrite=false;this.#busy=false;}
  }
  async #read(address,length,progress=()=>{}){
    checkRange(address,length);await this.#idle();await this.#command(0x21,address);await this.#idle();
    const output=new Uint8Array(length);
    for(let offset=0,block=2;offset<length;offset+=DFU.transferSize,block++){
      const size=Math.min(DFU.transferSize,length-offset),part=await this.#in(2,block,size);
      if(part.length!==size)throw new FirmwareError('Flash 읽기가 중간에 끝났습니다. 다시 연결해 주세요.');
      output.set(part,offset);this.audit.uploadedBytes+=size;progress(offset+size,length);
    }
    await this.#idle();return output;
  }
  inspect(progress=()=>{}){return this.#exclusive(async()=>{
    this.#compatible=null;const auditBefore={...this.audit},result={};
    for(const [name,address,length] of [['application',DFU.application,DFU.applicationEnd-DFU.application],['settings',DFU.settings,DFU.end-DFU.settings]]){
      const first=await this.#read(address,length,(done,total)=>progress(name,1,done,total));
      const second=await this.#read(address,length,(done,total)=>progress(name,2,done,total));
      if(!equalBytes(first,second))throw new FirmwareError(`${name==='application'?'펌웨어':'설정'} 영역의 두 번 읽기 결과가 다릅니다.`);
      result[name]=first;result[`${name}Sha256`]=await sha256(first);
    }
    checkVector(result.application);
    if(this.audit.erasedPages!==auditBefore.erasedPages||this.audit.downloadedBytes!==auditBefore.downloadedBytes||this.audit.leaveCommands!==auditBefore.leaveCommands)
      throw new FirmwareError('읽기 전용 검증에서 기록 명령이 감지됐습니다.');
    let installedImage=null;
    for(const known of KNOWN_APPLICATIONS)if(await sha256(result.application.subarray(0,known.bytes))===known.sha256){installedImage={version:known.version,firmwareVersion:known.firmwareVersion};break;}
    const report={format:'link65-webusb-compatibility',version:1,at:new Date().toISOString(),passed:true,installedImage,
      device:{vid:DFU.vid,pid:DFU.pid,configuration:1,interface:0,alternate:0},descriptor:this.descriptor,
      application:{address:hex32(DFU.application),bytes:result.application.length,sha256:result.applicationSha256,readsEqual:true},
      settings:{address:hex32(DFU.settings),bytes:result.settings.length,sha256:result.settingsSha256,readsEqual:true},
      audit:{...this.audit},firmwareWritten:false};
    this.#compatible={...result,report};return {...result,report};
  });}
  async readApplication(){return this.#exclusive(()=>this.#read(DFU.application,DFU.applicationEnd-DFU.application));}
  async flash(input,{confirmed=false,session,progress=()=>{}}={}){return this.#exclusive(async()=>{
    if(!confirmed||!this.compatible||!(session instanceof UpdateSession)||session.phase!=='read-verified'||!session.hasConfiguration||!session.hasFlashBackup)
      throw new FirmwareError('설정 백업, Flash 백업, 읽기 검증과 최종 확인을 먼저 완료해 주세요.');
    const image=await validateImage(input),before=this.#compatible;
    if(!await session.matchesFlash(before))throw new FirmwareError('저장한 Flash 백업과 현재 DFU 검증 결과가 다릅니다.');
    if(!before.report.installedImage||before.report.installedImage.firmwareVersion!==session.summary.sourceFirmwareVersion)
      throw new FirmwareError('기존 펌웨어가 Link65용으로 확인되지 않거나 정상 모드 백업의 버전과 다릅니다. 기록을 중단했습니다.');
    // Re-read immediately before the first destructive command, even after a passed probe.
    if(!equalBytes(await this.#read(DFU.application,before.application.length),before.application)||
      !equalBytes(await this.#read(DFU.settings,before.settings.length),before.settings))
      throw new FirmwareError('읽기 검증 이후 기기 내용이 바뀌었습니다. 다시 검증해 주세요.');
    await session.mark('writing',{targetVersion:RELEASE.version,targetFirmwareVersion:RELEASE.firmwareVersion,writeAttempted:true});
    this.#compatible=null;this.#permitWrite=true;
    const eraseLength=Math.ceil(image.payload.length/DFU.pageSize)*DFU.pageSize;checkRange(DFU.application,eraseLength,true);
    for(let offset=0;offset<eraseLength;offset+=DFU.pageSize){await this.#idle();await this.#command(0x41,DFU.application+offset);progress('erase',offset+DFU.pageSize,eraseLength);}
    for(let offset=0;offset<image.payload.length;offset+=DFU.transferSize){
      await this.#idle();await this.#command(0x21,DFU.application+offset);
      const part=image.payload.slice(offset,offset+DFU.transferSize);await this.#out(1,2,part);await this.#downloadDone();
      progress('write',offset+part.length,image.payload.length);
    }
    const after=await this.#read(DFU.application,image.payload.length),settings=await this.#read(DFU.settings,before.settings.length);
    if(!equalBytes(after,image.payload))throw new FirmwareError('기록한 펌웨어의 다시 읽기 결과가 다릅니다. DFU 상태를 유지합니다.');
    if(!equalBytes(settings,before.settings))throw new FirmwareError('설정 Flash가 백업과 다릅니다. DFU 상태를 유지합니다.');
    const report={at:new Date().toISOString(),firmwareWritten:true,payloadReadbackEqual:true,settingsFlashPreserved:true,
      version:RELEASE.version,sha256:image.sha256,audit:{...this.audit}};
    await session.mark('written-verified',{writeReport:report});return report;
  });}
  async leave({confirmed=false,session}={}){return this.#exclusive(async()=>{
    if(!confirmed||!session?.hasConfiguration||!['read-verified','written-verified'].includes(session.phase))
      throw new FirmwareError('검증과 백업이 끝난 뒤 정상 모드로 돌아갈 수 있습니다.');
    // Command-only DfuSe leave, matching the previously verified native sequence.
    await this.#idle();await this.#command(0x21,DFU.application);this.#permitWrite=true;
    await session.mark('awaiting-normal',{firmwareWritten:session.phase==='written-verified'});
    let transportMessage=null;
    try{await this.#out(1,2);await this.#status();}catch(error){transportMessage=error.message;}
    finally{this.#compatible=null;await this.close();}
    return {transportMessage,normalModeStillNeedsVerification:true};
  });}
  async close(){this.#compatible=null;this.#invalid=true;try{if(this.device.opened)await this.device.close();}catch{}}
}

// Contains private keymaps and Flash bytes. Browser-local storage only, never fetched or uploaded.
export class UpdateSession {
  #data=null;
  constructor(storage=localStorage){this.storage=storage;}
  get phase(){return this.#data?.phase??'idle';}
  get hasConfiguration(){return Boolean(this.#data?.configuration);}
  get hasFlashBackup(){return Boolean(this.#data?.flash);}
  get summary(){return this.#data?{phase:this.phase,at:this.#data.at,sourceFirmwareVersion:this.#data.sourceFirmwareVersion,
    compatibility:this.#data.compatibility,postCheck:this.#data.postCheck,writeReport:this.#data.writeReport,
    firmwareWritten:Boolean(this.#data.firmwareWritten||this.#data.writeReport),writeAttempted:Boolean(this.#data.writeAttempted)}:null;}
  async #persist(data){
    const payload=JSON.stringify(data),envelope=JSON.stringify({payload,sha256:await sha256(new TextEncoder().encode(payload))});
    try{this.storage.setItem(UPDATE_KEY,envelope);if(this.storage.getItem(UPDATE_KEY)!==envelope)throw Error();}
    catch{throw new FirmwareError('업데이트 백업을 브라우저에 보관하지 못했습니다. 기록은 시작하지 않습니다.');}
    this.#data=JSON.parse(payload);
  }
  async load(){
    let raw;try{raw=this.storage.getItem(UPDATE_KEY);}catch{throw new FirmwareError('업데이트 백업 저장소에 접근할 수 없습니다.');}if(!raw)return false;
    try{const envelope=JSON.parse(raw);if(await sha256(new TextEncoder().encode(envelope.payload))!==envelope.sha256)throw Error();
      const data=JSON.parse(envelope.payload);if(data.format!=='link65-firmware-session'||data.version!==1)throw Error();
      this.#validateBackup(data.configuration);this.#data=data;return true;
    }catch{throw new FirmwareError('보관한 업데이트 백업이 손상됐습니다. 다운로드한 백업을 확인해 주세요.');}
  }
  async import(data){
    if(data?.format!=='link65-firmware-session'||data.version!==1||!Number.isInteger(data.sourceFirmwareVersion)||
      !['prepared','read-verified','writing','written-verified','awaiting-normal','complete','needs-attention'].includes(data.phase))
      throw new FirmwareError('Link65 업데이트 복구 백업 파일을 선택해 주세요.');
    this.#validateBackup(data.configuration);
    if(data.flash){
      const application=decode(data.flash.application),settings=decode(data.flash.settings);
      if(application.length!==0x9000||settings.length!==0x1000||await sha256(application)!==data.compatibility?.application?.sha256||
        await sha256(settings)!==data.compatibility?.settings?.sha256)throw new FirmwareError('복구 백업의 Flash 길이 또는 해시가 다릅니다.');
    }
    await this.#persist(data);
  }
  #validateBackup(backup){const d=backup?.device;
    if(!d||!Number.isInteger(d.protocol)||d.protocol<7||d.protocol>13||d.layers!==4||d.macro_count!==16||
      !Number.isInteger(d.macro_size)||d.macro_size<16||d.macro_size>32768||
      (d.protocol===13&&(d.keycodes_version!==9||d.macro_size!==1407)))
      throw new FirmwareError('지원하는 Link65 설정 백업 형식이 아닙니다.');
    return fromBackup(backup,{protocol:d?.protocol,keycodesVersion:d?.keycodes_version,
    layers:d?.layers,macroCount:d?.macro_count,macroSize:d?.macro_size,writable:true});}
  async prepare(client){
    if(!client?.info?.writable)throw new FirmwareError('키보드를 정상 모드로 연결한 뒤 현재 설정을 백업해 주세요.');
    const first=await client.snapshot(),second=await client.snapshot();
    if(!symmetricSnapshot(first,second))throw new FirmwareError('두 번 읽은 설정이 다릅니다. 다른 설정 앱을 닫고 다시 시도해 주세요.');
    const configuration=toBackup(first);this.#validateBackup(configuration);
    await this.#persist({format:'link65-firmware-session',version:1,at:new Date().toISOString(),phase:'prepared',
      sourceFirmwareVersion:client.info.firmwareVersion??0,configuration});return configuration;
  }
  async storeInspection(inspection){
    if(!this.hasConfiguration||!inspection.report.passed)throw new FirmwareError('현재 설정 백업을 먼저 준비해 주세요.');
    if(await sha256(inspection.application)!==inspection.report.application.sha256||await sha256(inspection.settings)!==inspection.report.settings.sha256)
      throw new FirmwareError('Flash 백업의 해시가 일치하지 않습니다.');
    await this.#persist({...this.#data,phase:'read-verified',compatibility:inspection.report,
      flash:{application:encode(inspection.application),settings:encode(inspection.settings)}});
  }
  async matchesFlash(inspection){return this.hasFlashBackup&&equalBytes(decode(this.#data.flash.application),inspection.application)&&
    equalBytes(decode(this.#data.flash.settings),inspection.settings);}
  async mark(phase,extra={}){if(!this.hasConfiguration)throw new FirmwareError('설정 백업이 없습니다.');await this.#persist({...this.#data,...extra,phase});}
  export(){if(!this.#data)throw new FirmwareError('내보낼 업데이트 백업이 없습니다.');return JSON.parse(JSON.stringify(this.#data));}
  async checkNormal(client,tables){
    if(!this.hasConfiguration||!client?.info)throw new FirmwareError('업데이트 전 설정 백업과 정상 모드 키보드 연결이 필요합니다.');
    const desired=migrateBackup(this.#data.configuration,client.info,tables),first=await client.snapshot(),second=await client.snapshot();
    if(!symmetricSnapshot(first,second))throw new FirmwareError('재연결 후 설정의 두 번 읽기 결과가 다릅니다.');
    const preserved=symmetricSnapshot(first,desired),firmwareWritten=Boolean(this.#data.writeReport);
    const versionMatches=!this.#data.writeAttempted||Boolean(this.#data.writeReport&&client.info.firmwareVersion===this.#data.targetFirmwareVersion);
    const report={at:new Date().toISOString(),settingsPreserved:preserved,versionMatches,firmwareWritten,
      firmwareVersion:client.info.firmwareVersion,keymapCells:desired.keymap.flat().length,macroBytes:desired.macros.length,configurationWrites:0,writeAttempted:Boolean(this.#data.writeAttempted)};
    await this.mark(preserved&&versionMatches?'complete':'needs-attention',{postCheck:report});return {report,current:first,desired};
  }
  async restore(client,tables,backup){
    const {current,desired}=await this.checkNormal(client,tables);
    if(!this.#data.postCheck.versionMatches)throw new FirmwareError('설치한 펌웨어 버전이 예상과 달라 자동 복원을 중단했습니다.');
    if(symmetricSnapshot(current,desired))return {report:this.#data.postCheck,current,desired};
    await client.apply(current,desired,backup);const result=await this.checkNormal(client,tables);
    result.report.restorationPerformed=true;await this.mark(this.phase,{postCheck:result.report});return result;
  }
}
