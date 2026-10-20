import {ROWS,COLS,VID,PID,ConfigurationError,equalBytes,sameSnapshot} from './model.mjs';
export class ConnectionError extends Error {}
export class UnsupportedCommand extends ConnectionError {}
const be16 = n => [n>>8,n&255];
const u16 = (data,offset) => (data[offset]<<8)|data[offset+1];
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
export const isLink65 = device => device.vendorId === VID && device.productId === PID &&
  device.collections?.some(collection=>collection.usagePage === 0xff60 && collection.usage === 0x61);

export class WebHIDTransport {
  constructor(device, timeout=1500) {
    this.device = device; this.timeout = timeout; this.closed = false; this.invalidated = false;
    this.tail = Promise.resolve(); this.pending = null;
    this.onInput = event => {
      if (event.reportId !== 0 || !this.pending) return;
      const data = new Uint8Array(event.data.buffer,event.data.byteOffset,event.data.byteLength).slice();
      if (data.length !== 32) return;
      if (data[0] === 0xff) this.finish(new UnsupportedCommand('현재 펌웨어에서 이 명령을 지원하지 않습니다.'));
      else if (this.pending.prefix.every((byte,index)=>data[index] === byte)) this.finish(null,data);
    };
    device.addEventListener('inputreport', this.onInput);
  }
  static async open(device) {
    if (!isLink65(device)) throw new ConnectionError('Link65 Hotswap의 설정 인터페이스를 선택해 주세요.');
    try { if (!device.opened) await device.open(); }
    catch { throw new ConnectionError('기기를 열 수 없습니다. 데스크톱 앱과 VIA를 닫고 다시 연결해 주세요.'); }
    return new WebHIDTransport(device);
  }
  finish(error, value, pending=this.pending) {
    if (!pending || this.pending !== pending) return;
    this.pending = null; clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(value);
  }
  invalidate(error,pending) {
    if (this.pending !== pending) return;
    this.invalidated = true;
    this.finish(error,null,pending);
    this.device.removeEventListener('inputreport',this.onInput);
  }
  exchange(command,args=[]) {
    args=Array.from(args);
    const operation = this.tail.then(async()=>{
      if (this.closed || this.invalidated) throw new ConnectionError('키보드 연결을 새로 열어야 합니다. 다시 연결해 주세요.');
      if (!Number.isInteger(command) || command<0 || command>255 || args.length>31 ||
          args.some(n=>!Number.isInteger(n)||n<0||n>255)) throw new ConfigurationError('HID 명령 형식이 올바르지 않습니다.');
      const prefix = Uint8Array.from([command,...args]), report = new Uint8Array(32);
      report.set(prefix);
      let pending;
      const response = new Promise((resolve,reject)=>{
        pending = {prefix,resolve,reject,timer:setTimeout(()=>this.invalidate(
          new ConnectionError('키보드 응답이 없습니다. 다른 설정 앱을 닫고 다시 연결해 주세요.'),pending),this.timeout)};
        this.pending = pending;
      });
      // WebHID takes report ID separately: exactly 32 payload bytes, without
      // HIDAPI's leading zero. Install the waiter before sending the report.
      try {
        Promise.resolve(this.device.sendReport(0,report)).catch(()=>this.invalidate(
          new ConnectionError('키보드와 통신하지 못했습니다. USB 연결을 확인해 주세요.'),pending));
      } catch { this.invalidate(new ConnectionError('키보드로 명령을 전송하지 못했습니다. 다시 연결해 주세요.'),pending); }
      return response;
    });
    this.tail = operation.catch(()=>{});
    return operation;
  }
  async close() {
    this.closed = true;
    this.finish(new ConnectionError('키보드 연결이 종료됐습니다.'));
    this.device.removeEventListener('inputreport',this.onInput);
    try { if (this.device.opened) await this.device.close(); } catch {}
  }
}

const sameInfo = (a,b) => ['protocol','layers','macroCount','macroSize'].every(key=>a[key] === b[key]) &&
  (a.keycodesVersion??null) === (b.keycodesVersion??null);
export class Link65Client {
  constructor(transport) { this.transport = transport; this.info = null; }
  async identify(name='LINK Hotswap') {
    const protocol = u16(await this.transport.exchange(1),1);
    if (protocol<7 || protocol>13) throw new ConnectionError(`지원 범위를 벗어난 VIA 버전입니다: ${protocol}`);
    let layers=4, macroCount=0, macroSize=0;
    try { layers = (await this.transport.exchange(0x11))[1]; } catch (e) { if (!(e instanceof UnsupportedCommand)) throw e; }
    try {
      macroCount = (await this.transport.exchange(0x0c))[1];
      macroSize = u16(await this.transport.exchange(0x0d),1);
    } catch (e) { if (!(e instanceof UnsupportedCommand)) throw e; }
    if (layers<1 || layers>32 || macroCount>128 || macroSize>32768 || (macroCount && macroSize<macroCount))
      throw new ConnectionError('기기가 올바르지 않은 설정 용량을 응답했습니다.');
    let keycodesVersion=null,firmwareVersion=0,capabilities=null;
    if (protocol===13) {
      try {
        const data=await this.transport.exchange(2,[6]);
        const version=new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(2,false);
        if(version && Array.from(data.slice(2,6)).every(byte=>(byte>>4)<=9 && (byte&15)<=9))keycodesVersion=version;
      } catch(error) { if(!(error instanceof UnsupportedCommand))throw error; }
      try { const data=await this.transport.exchange(2,[4]);firmwareVersion=new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(2,false); }
      catch(error) { if(!(error instanceof UnsupportedCommand))throw error; }
      try {
        const data=await this.transport.exchange(2,[0x7e]);
        if(String.fromCharCode(...data.slice(2,6))==='L65S' && data[6]===1)
          capabilities={matrix:Boolean(data[7]&1),bootloader:Boolean(data[7]&2),schema:data[6]};
      } catch(error) { if(!(error instanceof UnsupportedCommand))throw error; }
    }
    this.info = {name,protocol,layers,macroCount,macroSize,keycodesVersion,firmwareVersion,capabilities,
      writable:protocol<=12 || (protocol===13 && keycodesVersion===9)};
    return this.info;
  }
  async readKeymap() {
    const total = this.info.layers*ROWS*COLS*2, data = new Uint8Array(total);
    try {
      for (let offset=0; offset<total; offset+=28) {
        const size = Math.min(28,total-offset);
        const reply = await this.transport.exchange(0x12,[...be16(offset),size]);
        data.set(reply.slice(4,4+size),offset);
      }
    } catch (error) {
      if (!(error instanceof UnsupportedCommand)) throw error;
      for (let layer=0; layer<this.info.layers; layer++) for (let index=0; index<ROWS*COLS; index++) {
        const reply = await this.transport.exchange(4,[layer,Math.floor(index/COLS),index%COLS]);
        data.set(reply.slice(4,6),(layer*ROWS*COLS+index)*2);
      }
    }
    return Array.from({length:this.info.layers},(_,layer)=>
      Array.from({length:ROWS*COLS},(_,index)=>u16(data,(layer*ROWS*COLS+index)*2)));
  }
  async readMacros() {
    const data = new Uint8Array(this.info.macroSize);
    for (let offset=0; offset<data.length; offset+=28) {
      const size = Math.min(28,data.length-offset);
      const reply = await this.transport.exchange(0x0e,[...be16(offset),size]);
      data.set(reply.slice(4,4+size),offset);
    }
    return data;
  }
  async snapshot() {
    let layoutOptions = null;
    try {
      const data = await this.transport.exchange(2,[2]);
      layoutOptions = new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(2,false);
    } catch (error) { if (!(error instanceof UnsupportedCommand)) throw error; }
    return {info:{...this.info},keymap:await this.readKeymap(),macros:await this.readMacros(),layoutOptions};
  }
  async readMatrix() {
    const data = await this.transport.exchange(2,[3,0]), pressed = new Set();
    if (data.length !== 32 || data[0] !== 2 || data[1] !== 3 || data[2] !== 0)
      throw new ConnectionError('키 테스트 응답 형식이 올바르지 않습니다.');
    for (let row=0; row<ROWS; row++) {
      const mask = u16(data,3+row*2);
      for (let col=0; col<COLS; col++) if (mask & (1<<col)) pressed.add(row*COLS+col);
    }
    return pressed;
  }
  validate(snapshot) {
    if (!this.info.writable) throw new ConfigurationError('이 펌웨어 버전은 읽기 전용으로 연결됩니다.');
    if (!sameInfo(snapshot.info,this.info) || snapshot.keymap.length !== this.info.layers ||
        snapshot.keymap.some(layer=>layer.length !== ROWS*COLS || layer.some(code=>!Number.isInteger(code) || code<0 || code>65535)) ||
        snapshot.macros.length !== this.info.macroSize || (snapshot.macros.length && snapshot.macros.at(-1) !== 0) ||
        (snapshot.layoutOptions != null && (!Number.isInteger(snapshot.layoutOptions) || snapshot.layoutOptions<0 || snapshot.layoutOptions>0xffffffff)))
      throw new ConfigurationError('현재 기기와 설정 정보가 다르거나 저장할 수 없는 값입니다.');
  }
  async writeKey(layer,index,code) {
    await this.transport.exchange(5,[layer,Math.floor(index/COLS),index%COLS,...be16(code)]);
  }
  async writeLayout(value) {
    await this.transport.exchange(3,[2,(value>>>24)&255,(value>>>16)&255,(value>>>8)&255,value&255]);
  }
  async writeMacros(data) {
    if (!data.length) return;
    const end = data.length-1;
    await this.transport.exchange(15,[...be16(end),1,255]);
    for (let offset=0; offset<end; offset+=28) {
      const part = data.slice(offset,Math.min(end,offset+28));
      await this.transport.exchange(15,[...be16(offset),part.length,...part]);
    }
    await this.transport.exchange(15,[...be16(end),1,data[end]]);
  }
  async apply(baseline,desired,backup,progress=()=>{}) {
    this.validate(desired);
    const before = await this.snapshot();
    if (!sameInfo(baseline.info,this.info) || !sameSnapshot(before,baseline))
      throw new ConfigurationError('다른 곳에서 기기 설정이 변경됐습니다. 현재 편집본을 백업한 뒤 다시 읽어 주세요.');
    await backup(before,'before-apply');
    const written = [], changes = [];
    before.keymap.forEach((layer,l)=>layer.forEach((code,i)=>{if (code !== desired.keymap[l][i]) changes.push([l,i,desired.keymap[l][i]]);}));
    const macrosChanged = !equalBytes(before.macros,desired.macros);
    const layoutChanged = desired.layoutOptions != null && before.layoutOptions !== desired.layoutOptions;
    try {
      for (const [layer,index,code] of changes) {
        written.push([layer,index]); // The write may succeed even if its ACK is lost.
        await this.writeKey(layer,index,code); progress(written.length,changes.length);
      }
      if (macrosChanged) await this.writeMacros(desired.macros);
      if (layoutChanged) await this.writeLayout(desired.layoutOptions);
      const after = await this.snapshot();
      if (!sameSnapshot(after,desired)) throw new ConnectionError('기기에서 다시 읽은 값이 저장 요청과 다릅니다.');
      return after;
    } catch (error) {
      let recovered = false;
      try {
        for (const [layer,index] of written.reverse()) await this.writeKey(layer,index,before.keymap[layer][index]);
        if (macrosChanged) await this.writeMacros(before.macros);
        if (layoutChanged && before.layoutOptions != null) await this.writeLayout(before.layoutOptions);
        recovered = sameSnapshot(await this.snapshot(),before);
      } catch {}
      throw new ConnectionError(`저장하지 못했습니다. ${recovered ? '변경 전 설정으로 복구했습니다.' : '다시 연결한 뒤 자동 백업에서 복원해 주세요.'} ${error.message}`);
    }
  }
  async factoryReset(baseline,backup) {
    this.validate(baseline);
    const before = await this.snapshot();
    if (!sameSnapshot(before,baseline) || !sameInfo(before.info,baseline.info))
      throw new ConfigurationError('기기 설정이 변경됐습니다. 다시 읽은 후 초기화해 주세요.');
    await backup(before,'before-reset');
    try {
      await this.transport.exchange(6);
      if (this.info.macroSize) await this.transport.exchange(16);
      if (before.layoutOptions != null) await this.writeLayout(0);
      const after = await this.snapshot();
      if (after.macros.some(Boolean) || (after.layoutOptions != null && after.layoutOptions !== 0) ||
          !sameSnapshot(await this.snapshot(),after)) throw new ConnectionError('초기화 결과를 확인하지 못했습니다.');
      return after;
    } catch (error) {
      let recovered = false;
      try {
        const current = await this.snapshot();
        for (let layer=0; layer<before.keymap.length; layer++) for (let index=0; index<ROWS*COLS; index++)
          if (before.keymap[layer][index] !== current.keymap[layer][index]) await this.writeKey(layer,index,before.keymap[layer][index]);
        if (!equalBytes(before.macros,current.macros)) await this.writeMacros(before.macros);
        if (before.layoutOptions != null && before.layoutOptions !== current.layoutOptions) await this.writeLayout(before.layoutOptions);
        recovered = sameSnapshot(await this.snapshot(),before);
      } catch {}
      throw new ConnectionError(`초기화하지 못했습니다. ${recovered ? '초기화 전 설정으로 복구했습니다.' : '다시 연결한 뒤 초기화 전 자동 백업을 복원해 주세요.'} ${error.message}`);
    }
  }
  async ping() {
    if (u16(await this.transport.exchange(1),1) !== this.info.protocol) throw new ConnectionError('펌웨어가 변경됐습니다. 다시 연결해 주세요.');
  }
  async enterBootloader() {
    if(!this.info?.capabilities?.bootloader)throw new UnsupportedCommand('이 펌웨어는 명령으로 업데이트 모드에 진입하는 기능을 제공하지 않습니다.');
    await this.transport.exchange(0x0b,[0x4c,0x36,0x35,0x42]);
    await this.close();
  }
  close() { return this.transport.close(); }
}

export {delay};
