export const ROWS = 5, COLS = 15, VID = 0x4f53, PID = 0x4c49;
export class ConfigurationError extends Error {}
export const hex = value => `0x${value.toString(16).toUpperCase().padStart(4, '0')}`;
const ALIASES = {
  KC_NO:'비활성', KC_TRNS:'투명 ▽', KC_ENT:'Enter', KC_ESC:'Esc', KC_BSPC:'Backspace',
  KC_TAB:'Tab', KC_SPC:'Space', KC_CAPS:'Caps Lock', KC_MINS:'−', KC_EQL:'=', KC_LBRC:'[',
  KC_RBRC:']', KC_BSLS:'\\', KC_SCLN:';', KC_QUOT:"'", KC_GRV:'`', KC_COMM:',', KC_DOT:'.',
  KC_SLSH:'/', KC_LCTL:'왼쪽 Ctrl', KC_RCTL:'오른쪽 Ctrl', KC_LSFT:'왼쪽 Shift',
  KC_RSFT:'오른쪽 Shift', KC_LALT:'왼쪽 Alt', KC_RALT:'오른쪽 Alt', KC_LGUI:'왼쪽 Win',
  KC_RGUI:'오른쪽 Win', KC_DEL:'Delete', KC_PGUP:'Page Up', KC_PGDN:'Page Down', KC_HOME:'Home',
  KC_END:'End', KC_INS:'Insert', KC_RGHT:'→', KC_LEFT:'←', KC_DOWN:'↓', KC_UP:'↑',
  KC_LANG1:'한/영', KC_LANG2:'한자', KC_MUTE:'음소거', KC_VOLU:'볼륨 +', KC_VOLD:'볼륨 −',
  KC_MPLY:'재생 / 일시정지', KC_MNXT:'다음 곡', KC_MPRV:'이전 곡'
};
const LAYER_BASES = {MO:'_QK_MOMENTARY', TG:'_QK_TOGGLE_LAYER', TO:'_QK_TO',
  DF:'_QK_DEF_LAYER', OSL:'_QK_ONE_SHOT_LAYER', TT:'_QK_LAYER_TAP_TOGGLE'};
const MODS = {LCTL:1, LSFT:2, LALT:4, LGUI:8, RCTL:17, RSFT:18, RALT:20, RGUI:24};

export class KeyRegistry {
  constructor(tables, protocol=12, layers=4, macroCount=16, keycodesVersion=null) {
    Object.assign(this, {protocol, layers, macroCount, keycodesVersion});
    this.versionKnown = protocol !== 13 || Boolean(tables.versions?.[String(keycodesVersion)]);
    this.table = protocol === 13 && this.versionKnown ? tables.versions[String(keycodesVersion)] : tables[String(protocol)] ?? tables.default;
    this.reverse = new Map();
    for (const [name, code] of Object.entries(this.table)) {
      if (!name.startsWith('_') && !this.reverse.has(code)) this.reverse.set(code, name);
    }
    for (const name of Object.keys(ALIASES)) {
      if (name in this.table) this.reverse.set(this.table[name], name);
    }
  }
  parse(text) {
    text = String(text).replace(/\s+/g, '').toUpperCase();
    if (text in this.table && !text.startsWith('_')) return this.table[text];
    if (/^0X[\dA-F]{1,4}$/.test(text)) return parseInt(text.slice(2), 16);
    let match = /^(MO|TG|TO|DF|OSL|TT|MACRO)\((\d+)\)$/.exec(text);
    if (match) {
      const [, kind, value] = match, number = Number(value);
      if (kind === 'MACRO' && number < this.macroCount) return this.table._QK_MACRO + number;
      if (kind !== 'MACRO' && number < this.layers) return this.table[LAYER_BASES[kind]] + number;
      throw new ConfigurationError('현재 기기에 없는 레이어 또는 매크로 번호입니다.');
    }
    match = /^(LCTL|LSFT|LALT|LGUI|RCTL|RSFT|RALT|RGUI)\((.+)\)$/.exec(text);
    if (match) {
      const key = this.parse(match[2]), existing = (key >> 8) & 31, mod = MODS[match[1]];
      if (key > 0x1fff) throw new ConfigurationError('수정 키는 일반 키와 조합해 주세요.');
      if (existing && Boolean(existing & 16) !== Boolean(mod & 16))
        throw new ConfigurationError('왼쪽과 오른쪽 수정 키는 함께 조합할 수 없습니다.');
      return ((existing | mod) << 8) | (key & 255);
    }
    match = /^LT\((\d+),(.+)\)$/.exec(text);
    if (match) {
      const layer = Number(match[1]), key = this.parse(match[2]);
      if (layer >= Math.min(16, this.layers) || key > 255)
        throw new ConfigurationError('LT에는 유효한 레이어와 일반 키를 입력해 주세요.');
      return this.table._QK_LAYER_TAP | (layer << 8) | key;
    }
    throw new ConfigurationError('키코드를 확인해 주세요. 예: KC_ESC, MO(1), LCTL(KC_C)');
  }
  name(code) {
    if (!this.versionKnown) return hex(code);
    const macro = this.table._QK_MACRO;
    if (code >= macro && code < macro + this.macroCount) return `MACRO(${code - macro})`;
    if (this.reverse.has(code)) return this.reverse.get(code);
    for (const [kind, constant] of Object.entries(LAYER_BASES)) {
      const base = this.table[constant];
      if (code >= base && code < base + 32) return `${kind}(${code - base})`;
    }
    if (code >= 0x100 && code <= 0x1fff) {
      const mods = code >> 8, prefix = mods & 16 ? 'R' : 'L';
      let name = this.reverse.get(code & 255) ?? hex(code & 255);
      for (const [bit, suffix] of [[1,'CTL'],[2,'SFT'],[4,'ALT'],[8,'GUI']])
        if (mods & bit) name = `${prefix}${suffix}(${name})`;
      return name;
    }
    const base = this.table._QK_LAYER_TAP;
    if (code >= base && code <= base + 0xfff)
      return `LT(${(code >> 8) & 15},${this.reverse.get(code & 255) ?? hex(code & 255)})`;
    return hex(code);
  }
  label(code) {
    const name = this.name(code);
    return ALIASES[name] ?? (/^KC_[A-Z0-9]+$/.test(name) ? name.slice(3) : name);
  }
  caption(code) {
    const label = this.label(code);
    const compact = {'Backspace':'Bksp', 'Delete':'Del', 'Page Up':'PgUp', 'Page Down':'PgDn',
      'Caps Lock':'Caps', '왼쪽 Ctrl':'Ctrl', '오른쪽 Ctrl':'Ctrl', '왼쪽 Shift':'Shift',
      '오른쪽 Shift':'Shift', '왼쪽 Alt':'Alt', '오른쪽 Alt':'Alt', '왼쪽 Win':'Win',
      '오른쪽 Win':'Win', '비활성':'없음', '투명 ▽':'▽', '음소거':'Mute', '볼륨 +':'Vol+',
      '볼륨 −':'Vol−', '재생 / 일시정지':'Play', '다음 곡':'Next', '이전 곡':'Prev'};
    const name = this.name(code);
    const macro = /^MACRO\((\d+)\)$/.exec(name), fn = /^MO\((\d+)\)$/.exec(name);
    if (macro) return `M${macro[1]}`;
    if (fn) return `Fn${fn[1]}`;
    const short = compact[label] ?? label;
    return short.length>7 ? hex(code).slice(2) : short;
  }
  options(category) {
    if (category === 'layer') return Object.entries(LAYER_BASES).flatMap(([kind, base]) =>
      Array.from({length:this.layers}, (_, n) => [`${kind}(${n})`, this.table[base] + n]));
    if (category === 'macro') return Array.from({length:this.macroCount}, (_, n) =>
      [`MACRO(${n})`, this.table._QK_MACRO + n]);
    const seen = new Set(), result = [];
    for (const [name, code] of Object.entries(this.table)) {
      if (!name.startsWith('KC_') || seen.has(code)) continue;
      const basic = code <= 0x73 || (code >= 0xe0 && code <= 0xe7);
      if ((category === 'basic') !== basic) continue;
      seen.add(code); result.push([this.reverse.get(code) ?? name, code]);
    }
    return result;
  }
}

export class MacroCodec {
  constructor(registry) { this.registry = registry; }
  split(buffer, count) {
    const parts = []; let start = 0;
    for (let i=0; i<buffer.length && parts.length<count; i++) {
      if (buffer[i] === 0) { parts.push(buffer.slice(start, i)); start = i + 1; }
    }
    if (parts.length !== count) throw new ConfigurationError('매크로 구분자가 올바르지 않습니다. 원본은 유지됩니다.');
    return parts;
  }
  compose(parts, size) {
    const used = parts.reduce((n, part) => n + part.length + 1, 0);
    if (used >= size) throw new ConfigurationError(`매크로 저장 공간이 부족합니다. ${used} / ${size-1}바이트`);
    const buffer = new Uint8Array(size); let offset = 0;
    for (const part of parts) { buffer.set(part, offset); offset += part.length + 1; }
    return buffer;
  }
  decode(data) {
    let output = '';
    for (let i=0; i<data.length;) {
      const byte = data[i];
      if (byte === 1) {
        if (i+2 >= data.length) throw new ConfigurationError('편집할 수 없는 매크로 형식입니다. 원본은 유지됩니다.');
        const action = data[i+1];
        if (action === 4) {
          let end = i+2;
          while (end<data.length && data[end] !== 124) end++;
          const number = String.fromCharCode(...data.slice(i+2, end));
          if (end === data.length || !/^\d{1,4}$/.test(number)) throw new ConfigurationError('대기 시간 형식이 올바르지 않습니다.');
          output += `{${number}}`; i = end+1; continue;
        }
        const name = this.registry.reverse.get(data[i+2]);
        if (![1,2,3].includes(action) || !name) throw new ConfigurationError('편집할 수 없는 매크로 동작입니다. 원본은 유지됩니다.');
        output += `{${action === 2 ? '+' : action === 3 ? '-' : ''}${name}}`; i+=3;
      } else if (byte>=32 && byte<=126) {
        const char = String.fromCharCode(byte); output += '\\{}'.includes(char) ? `\\${char}` : char; i++;
      } else throw new ConfigurationError('편집할 수 없는 문자 형식입니다. 원본은 유지됩니다.');
    }
    return output;
  }
  encode(expression) {
    const bytes = [], held = new Set();
    for (let i=0; i<expression.length; i++) {
      const char = expression[i];
      if (char === '\\') {
        if (++i >= expression.length || !'\\{}'.includes(expression[i]))
          throw new ConfigurationError('역슬래시는 \\, {, } 앞에서만 사용할 수 있습니다.');
        bytes.push(expression.charCodeAt(i));
      } else if (char === '{') {
        const end = expression.indexOf('}', i+1);
        if (end<0) throw new ConfigurationError('매크로의 중괄호를 닫아 주세요.');
        const token = expression.slice(i+1,end).replace(/\s+/g,'').toUpperCase();
        if (/^\d+$/.test(token)) {
          const delay = Number(token);
          if (delay>9999) throw new ConfigurationError('대기 시간은 0~9999ms 범위입니다.');
          bytes.push(1,4,...String(delay).split('').map(c=>c.charCodeAt(0)),124);
        } else {
          const action = /^[+-]/.test(token) ? token[0] : '';
          const keys = (action ? token.slice(1) : token).split(',').filter(Boolean).map(name=>this.registry.parse(name));
          if (!keys.length || keys.some(key=>key<1 || key>255) || (action && keys.length !== 1))
            throw new ConfigurationError('매크로에는 일반 키를 사용해 주세요. 예: {KC_ENT}, {KC_LCTL,KC_C}');
          if (action) {
            const key = keys[0];
            if (action === '+') {
              if (held.has(key)) throw new ConfigurationError('이미 누른 키입니다.');
              held.add(key);
            } else {
              if (!held.has(key)) throw new ConfigurationError('누르지 않은 키를 놓을 수 없습니다.');
              held.delete(key);
            }
            bytes.push(1,action === '+' ? 2 : 3,key);
          } else if (keys.length === 1) bytes.push(1,1,keys[0]);
          else {
            if (keys.some(key=>held.has(key))) throw new ConfigurationError('이미 누른 키를 중복 사용할 수 없습니다.');
            for (const key of keys) bytes.push(1,2,key);
            for (const key of [...keys].reverse()) bytes.push(1,3,key);
          }
        }
        i = end;
      } else if (char === '}') throw new ConfigurationError('문자 }를 입력하려면 \\}를 사용해 주세요.');
      else if (char === '\n' || char === '\t') bytes.push(1,1,char === '\n' ? 0x28 : 0x2b);
      else if (char.charCodeAt(0)>=32 && char.charCodeAt(0)<=126) bytes.push(char.charCodeAt(0));
      else throw new ConfigurationError('문자는 영문·숫자·기호를 지원합니다. 특수 키는 {KC_ENT}처럼 입력해 주세요.');
    }
    if (held.size) throw new ConfigurationError('누른 키를 모두 놓아 주세요. 예: {+KC_LCTL}c{-KC_LCTL}');
    return Uint8Array.from(bytes);
  }
}

export const cloneSnapshot = snapshot => ({info:{...snapshot.info}, keymap:snapshot.keymap.map(layer=>[...layer]),
  macros:Uint8Array.from(snapshot.macros), layoutOptions:snapshot.layoutOptions});
export const equalBytes = (a,b) => a.length === b.length && a.every((value,index)=>value === b[index]);
export const sameSnapshot = (a,b) => a.keymap.length === b.keymap.length &&
  a.keymap.every((row,i)=>equalBytes(row,b.keymap[i])) && equalBytes(a.macros,b.macros) &&
  (b.layoutOptions == null || a.layoutOptions === b.layoutOptions);
export function toBackup(snapshot) {
  const i = snapshot.info;
  return {format:'link65-control-backup',version:1,created_at:new Date().toISOString(),
    device:{vid:VID,pid:PID,rows:ROWS,cols:COLS,name:i.name,protocol:i.protocol,layers:i.layers,
      macro_count:i.macroCount,macro_size:i.macroSize,writable:i.writable,keycodes_version:i.keycodesVersion??null},
    keymap:snapshot.keymap.map(layer=>[...layer]),
    macro_buffer_base64:btoa(String.fromCharCode(...snapshot.macros)),layout_options:snapshot.layoutOptions};
}
export function fromBackup(doc, info) {
  const fail = () => { throw new ConfigurationError('현재 Link65와 호환되는 설정 백업을 선택해 주세요.'); };
  const d = doc?.device;
  if (doc?.format !== 'link65-control-backup' || doc.version !== 1 || !d ||
      d.vid !== VID || d.pid !== PID || d.rows !== ROWS || d.cols !== COLS ||
      d.protocol !== info.protocol || d.layers !== info.layers ||
      d.macro_count !== info.macroCount || d.macro_size !== info.macroSize ||
      (info.protocol === 13 && d.keycodes_version !== info.keycodesVersion)) fail();
  if (!Array.isArray(doc.keymap) || doc.keymap.length !== info.layers ||
      doc.keymap.some(layer=>!Array.isArray(layer) || layer.length !== ROWS*COLS ||
        layer.some(code=>!Number.isInteger(code) || code<0 || code>65535))) fail();
  let macros;
  try { macros = Uint8Array.from(atob(doc.macro_buffer_base64), char=>char.charCodeAt(0)); } catch { fail(); }
  if (macros.length !== info.macroSize || (macros.length && macros.at(-1) !== 0)) fail();
  const layoutOptions = doc.layout_options ?? null;
  if (layoutOptions !== null && (!Number.isInteger(layoutOptions) || layoutOptions<0 || layoutOptions>0xffffffff)) fail();
  return {info:{...info},keymap:doc.keymap.map(layer=>[...layer]),macros,layoutOptions};
}

export function migrateBackup(doc, info, tables) {
  if (doc?.device?.protocol === info.protocol) return fromBackup(doc,info);
  const d=doc?.device;
  if (!d || d.protocol !== 12 || info.protocol !== 13 || info.keycodesVersion !== 9 ||
      d.layers !== info.layers || d.macro_count !== info.macroCount)
    throw new ConfigurationError('이 백업은 새 펌웨어로 자동 변환할 수 없습니다. 원래 기기에서 내보낸 백업을 확인해 주세요.');
  const sourceInfo={protocol:d.protocol,layers:d.layers,macroCount:d.macro_count,macroSize:d.macro_size,writable:true};
  const before=fromBackup(doc,sourceInfo),source=new KeyRegistry(tables,12,info.layers,info.macroCount),
    target=new KeyRegistry(tables,13,info.layers,info.macroCount,info.keycodesVersion);
  const convert=code=>{
    if(code>=0x100 && code<=0x1fff){
      const modifiers=code>>8,prefix=modifiers&16?'R':'L';let name=source.name(code&255);
      for(const [bit,suffix] of [[1,'CTL'],[2,'SFT'],[4,'ALT'],[8,'GUI']])if(modifiers&bit)name=`${prefix}${suffix}(${name})`;
      return target.parse(name);
    }
    if(code>=0x2000 && code<=0x3fff)return target.table._QK_MOD_TAP|(code&0x1f00)|convert(code&255);
    const name=source.name(code);
    if(name.startsWith('0x'))throw new ConfigurationError(`변환할 수 없는 키코드 ${name}가 있습니다. 원본 백업은 유지됩니다.`);
    try{return target.parse(name);}catch{throw new ConfigurationError(`새 펌웨어에서 지원하는 이름을 확인해야 합니다: ${name}`);}
  };
  const oldCodec=new MacroCodec(source),newCodec=new MacroCodec(target);
  const parts=oldCodec.split(before.macros,sourceInfo.macroCount).map((part,index)=>{
    try{return newCodec.encode(oldCodec.decode(part));}catch{throw new ConfigurationError(`매크로 ${index}를 자동 변환할 수 없습니다. 원본 백업은 유지됩니다.`);}
  });
  return {info:{...info},keymap:before.keymap.map(layer=>layer.map(convert)),
    macros:newCodec.compose(parts,info.macroSize),layoutOptions:before.layoutOptions};
}

export class KeyTestState {
  constructor(indices) { this.indices = new Set(indices); this.held = new Set(); this.seen = new Set(); this.count = 0; this.primed = false; this.last = []; }
  update(matrix) {
    const current = new Set([...matrix].filter(index=>this.indices.has(index)));
    if (!this.primed) { this.held = current; this.primed = true; return new Set(); }
    const pressed = new Set([...current].filter(index=>!this.held.has(index)));
    this.held = current;
    if (pressed.size) { for (const index of pressed) this.seen.add(index); this.count += pressed.size; this.last = [...pressed].sort((a,b)=>a-b); }
    return pressed;
  }
  suspend() { this.held.clear(); this.primed = false; }
  clear() { this.seen.clear(); this.count = 0; this.last = []; }
}
