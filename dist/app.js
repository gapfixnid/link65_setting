import {COLS,VID,PID,KeyRegistry,MacroCodec,KeyTestState,ConfigurationError,
  cloneSnapshot,sameSnapshot,equalBytes,toBackup,migrateBackup,hex} from './model.mjs';
import {WebHIDTransport,Link65Client,UnsupportedCommand,ConnectionError,delay,isLink65} from './protocol.mjs';

const $ = id=>document.getElementById(id);
const views = {keymap:['키맵','익숙한 배열에, 나만의 동작을 더하세요.'],
  tester:['키 테스트','하나하나 눌러 보고, 확실하게 확인하세요.'],
  macros:['매크로','반복되는 동작을, 한 번의 키 입력으로.'],
  settings:['백업 및 설정','지금의 설정을 보관하고, 편하게 관리하세요.']};
const state = {client:null,baseline:null,draft:null,deviceBaseline:false,busy:false,view:'keymap',
  selected:null,layer:0,category:'basic',macro:0,macroTexts:new Map(),macroEditable:true,
  pollGeneration:0,pollTask:null,testWanted:true,testUnavailable:false,flashes:new Map(),
  boardButtons:new Map(),testButtons:new Map(),connected:false};
let tables,layout,factory,registry,testRegistry,tester,toastTimer,audio;
const HISTORY_KEY = 'link65-studio-backups-v1';
const safePreference = (key,value) => { try { if(value === undefined) return localStorage.getItem(key); localStorage.setItem(key,value); } catch {} };
const storedTheme = safePreference('link65-studio-theme');
let theme = storedTheme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function setTheme() { document.documentElement.dataset.theme = theme; $('theme-label').textContent = theme === 'dark' ? '다크' : '라이트'; }
setTheme();

function notify(message,error=false) {
  clearTimeout(toastTimer); const toast=$('toast');
  toast.textContent=message; toast.classList.toggle('error',error); toast.hidden=false;
  toast.setAttribute('role',error?'alert':'status');
  const close=document.createElement('button'); close.textContent='닫기'; close.className='toast-close';
  close.onclick=()=>{toast.hidden=true;}; toast.append(close);
  if(!error) toastTimer=setTimeout(()=>{toast.hidden=true;},5000);
}
function dirty() { return state.baseline && !sameSnapshot(state.baseline,state.draft); }
function canEdit() { return !state.busy && state.draft?.info.writable; }
function loadHistory() {
  try { const data=JSON.parse(localStorage.getItem(HISTORY_KEY)??'[]'); return Array.isArray(data)?data.filter(entry=>entry?.backup?.format==='link65-control-backup').slice(0,20):[]; }
  catch { return []; }
}
async function saveAutomatic(snapshot,reason) {
  const entry={id:crypto.randomUUID(),reason,backup:toBackup(snapshot)};
  const entries=[entry,...loadHistory()].slice(0,20);
  try {
    const serialized=JSON.stringify(entries); localStorage.setItem(HISTORY_KEY,serialized);
    if(localStorage.getItem(HISTORY_KEY)!==serialized) throw new Error('Storage verification failed');
  } catch { throw new ConfigurationError('브라우저에 자동 백업을 보관할 수 없습니다. 백업을 다운로드하고 저장 공간을 확보한 뒤 다시 시도해 주세요.'); }
  renderHistory(); return entry;
}
function download(doc,reason='backup') {
  const url=URL.createObjectURL(new Blob([JSON.stringify(doc,null,2)+'\n'],{type:'application/json'}));
  const link=document.createElement('a'); link.href=url;
  link.download=`link65-${new Date().toISOString().replace(/[:.]/g,'-')}-${reason}.json`;
  document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function acceptSnapshot(snapshot,keepDraft=false) {
  if(!keepDraft) {
    state.baseline=cloneSnapshot(snapshot); state.draft=cloneSnapshot(snapshot); state.macroTexts.clear();
  }
  registry=new KeyRegistry(tables,snapshot.info.protocol,snapshot.info.layers,snapshot.info.macroCount,snapshot.info.keycodesVersion);
  state.layer=Math.min(state.layer,snapshot.info.layers-1);
  state.macro=Math.min(state.macro,Math.max(0,snapshot.info.macroCount-1));
  renderLayers();renderMacroList();renderMacro();renderAll();
}
function renderLayers() {
  $('layers').replaceChildren();
  for(let i=0;i<state.draft.info.layers;i++) {
    const button=document.createElement('button'); button.textContent=i;
    button.setAttribute('aria-label',`레이어 ${i}`);button.dataset.layer=i;
    button.onclick=()=>{state.layer=i;renderLayers();renderBoard();renderSelection();};
    button.classList.toggle('active',state.layer===i);button.setAttribute('aria-pressed',String(state.layer===i));
    $('layers').append(button);
  }
  $('current-layer').textContent=state.layer;
}
function buildBoard(id,map,test=false) {
  for(const key of layout) {
    const index=key.row*COLS+key.col,button=document.createElement('button');
    button.type='button';button.className='keycap';button.dataset.index=index;
    button.style.setProperty('--x',`${key.x/16*100}%`);button.style.setProperty('--y',`${key.y/5*100}%`);
    button.style.setProperty('--w',`${key.w/16*100}%`);button.style.setProperty('--h',`${key.h/5*100}%`);
    if(test) { button.tabIndex=-1;button.onclick=()=>focusTester(); }
    else button.onclick=()=>{state.selected=index;renderBoard();renderSelection();renderCatalog();};
    $(id).append(button);map.set(index,button);
  }
}
function renderBoard() {
  for(const [index,button] of state.boardButtons) {
    const code=state.draft.keymap[state.layer][index];
    button.textContent=registry.caption(code);
    button.title=`${registry.label(code)} · ${registry.name(code)} · ${hex(code)}`;
    button.setAttribute('aria-label',`레이어 ${state.layer}, ${registry.label(code)}, ${registry.name(code)}`);
    button.setAttribute('aria-pressed',String(state.selected===index));
    button.classList.toggle('selected',state.selected===index);
    button.classList.toggle('changed',code!==state.baseline.keymap[state.layer][index]);
    button.classList.toggle('modifier',code>=0xe0 && code<=0xe7 || [0x2b,0x39,0x28,0x2a].includes(code) || registry.name(code).startsWith('MO('));
    button.disabled=state.busy;
  }
  $('current-layer').textContent=state.layer;
}
function renderSelection() {
  const selected=state.selected!==null;
  const code=selected?state.draft.keymap[state.layer][state.selected]:0;
  $('selected-key-preview').textContent=selected?registry.caption(code):'↖';
  $('selected-key-title').textContent=selected?registry.label(code):'키를 선택하세요';
  $('selected-key-detail').textContent=selected?`Layer ${state.layer} · ${registry.name(code)} · ${hex(code)}`:'위 키보드에서 원하는 위치를 누르세요.';
  $('keycode-input').value=selected?registry.name(code):'';
  for(const id of ['keycode-input','stage-key-button','undo-key-button']) $(id).disabled=!selected || !canEdit();
}
function renderCatalog() {
  const query=$('key-search').value.trim().toLocaleLowerCase();
  const options=registry.options(state.category).filter(([name,code])=>`${name} ${registry.label(code)}`.toLocaleLowerCase().includes(query));
  const fragment=document.createDocumentFragment();
  for(const [name,code] of options) {
    const button=document.createElement('button');button.className='option-key';button.dataset.code=code;
    const label=document.createElement('span');label.textContent=registry.label(code);
    const detail=document.createElement('small');detail.textContent=name;
    button.append(label,detail);button.title=`${name} · ${hex(code)}`;
    button.classList.toggle('current',state.selected!==null && state.draft.keymap[state.layer][state.selected]===code);
    button.disabled=state.busy || !state.draft.info.writable;
    button.onclick=()=>{
      if(state.selected===null) {notify('먼저 위 키보드에서 변경할 키를 선택해 주세요.');return;}
      stageKey(code);
    };
    fragment.append(button);
  }
  $('key-catalog').replaceChildren(fragment);$('catalog-empty').hidden=options.length>0;
}
function stageKey(code) {
  if(!canEdit() || state.selected===null) return;
  state.draft.keymap[state.layer][state.selected]=code;
  renderBoard();renderSelection();renderCatalog();renderControls();
}
function renderControls() {
  if(!state.draft) return;
  const connected=Boolean(state.client && state.connected),changed=dirty(),editable=canEdit();
  const count=state.draft.keymap.reduce((n,layer,l)=>n+layer.filter((code,i)=>code!==state.baseline.keymap[l][i]).length,0);
  const macros=!equalBytes(state.baseline.macros,state.draft.macros),options=state.draft.layoutOptions!==null && state.draft.layoutOptions!==state.baseline.layoutOptions;
  $('connect-button').disabled=state.busy || !('hid' in navigator) || !isSecureContext;
  $('connect-button').querySelector('span').textContent=connected?'다시 연결':'키보드 연결';
  $('disconnect-button').hidden=!connected;$('disconnect-button').disabled=state.busy;
  $('connection-pill').querySelector('span').textContent=connected?'Link65 연결됨':'연결되지 않음';
  $('connection-pill').querySelector('i').classList.toggle('connected',connected);
  $('sidebar-status').replaceChildren();const dot=document.createElement('i');dot.className=`status-dot${connected?' connected':''}`;
  $('sidebar-status').append(dot,document.createTextNode(connected?'USB로 연결됨':'연결 대기 중'));
  $('connection-notice').hidden=connected;
  $('board-mode').textContent=connected?(state.draft.info.writable?'현재 기기 설정':'읽기 전용'):'기본 배열 미리보기';
  const parts=[];if(count)parts.push(`키 ${count}개`);if(macros)parts.push('매크로');if(options)parts.push('레이아웃');
  $('change-count').textContent=changed?`${parts.join(' · ')} 변경 준비`:'변경한 설정이 없습니다.';
  $('change-dot').classList.toggle('dirty',changed);
  $('save-detail').textContent=!connected?'미리보기 편집입니다. 기기를 연결하면 실제 설정을 불러옵니다.':
    !state.draft.info.writable?'현재 펌웨어는 백업과 읽기만 지원합니다.':changed?'적용하면 자동 백업 후 기기에 저장합니다.':'현재 설정을 기기에서 읽어 왔습니다.';
  $('apply-button').disabled=!connected || !editable || !changed;
  $('discard-button').disabled=state.busy || !changed;
  $('reset-button').disabled=!connected || !editable;
  $('reload-button').disabled=!connected || state.busy || changed;
  $('export-backup').disabled=state.busy;$('import-backup').disabled=!editable;
  $('stage-macro').disabled=!editable || !state.macroEditable || !state.draft.info.macroCount;
  $('macro-input').disabled=!editable || !state.macroEditable;
  if(state.macroTexts.size){$('discard-button').disabled=state.busy;$('save-detail').textContent='매크로 입력 내용을 「변경 준비」로 먼저 반영해 주세요.';}
  $('test-pause').disabled=!connected || state.busy || state.testUnavailable;
  $('test-pause').textContent=state.testWanted?'일시 정지':'테스트 시작';
  renderInfo();
}
function renderAll() {renderBoard();renderSelection();renderCatalog();renderControls();renderHistory();renderTest();}
function renderInfo() {
  const info=state.draft.info,rows=[['모델','Owlab Link65 Hotswap'],['연결',state.client&&state.connected?'USB · WebHID':'연결 대기 중']];
  if(state.client&&state.connected) {
    rows.push(['펌웨어',`VIA ${info.protocol}${info.writable?'':' · 읽기 전용'}`],['저장 공간',`${info.layers}개 레이어 · 매크로 ${info.macroCount}개`]);
    if(info.keycodesVersion)rows.push(['키코드 버전',`QMK ${info.keycodesVersion}`]);
    if(info.capabilities)rows.push(['펌웨어 종류','Link65 Studio']);
  }
  const fragment=document.createDocumentFragment();
  for(const [label,value] of rows){const row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;row.append(dt,dd);fragment.append(row);}
  $('device-info').replaceChildren(fragment);
}
function renderMacroList() {
  $('macro-list').replaceChildren();const codec=new MacroCodec(registry);
  let parts=[];try{parts=codec.split(state.draft.macros,state.draft.info.macroCount);}catch{}
  for(let i=0;i<state.draft.info.macroCount;i++) {
    const button=document.createElement('button');button.className='macro-item';button.classList.toggle('active',state.macro===i);
    const title=document.createElement('span'),detail=document.createElement('small');title.textContent=`매크로 ${i}`;detail.textContent=parts[i]?.length?`${parts[i].length} B`:'비어 있음';
    button.append(title,detail);button.setAttribute('aria-pressed',String(state.macro===i));
    button.onclick=()=>{state.macro=i;renderMacroList();renderMacro();renderControls();};$('macro-list').append(button);
  }
  $('macro-total').textContent=`${state.draft.info.macroCount}개의 작은 자동화`;
}
function renderMacro() {
  const codec=new MacroCodec(registry),info=state.draft.info;state.macroEditable=true;
  $('macro-title').textContent=`매크로 ${state.macro}`;$('macro-message').textContent='';
  try {
    if(![11,12,13].includes(info.protocol) || !info.writable || !info.macroCount) throw new ConfigurationError('이 펌웨어의 매크로는 원본 백업과 복원으로 관리할 수 있습니다.');
    const parts=codec.split(state.draft.macros,info.macroCount),used=parts.reduce((n,part)=>n+part.length+1,0);
    $('macro-input').value=state.macroTexts.get(state.macro)??codec.decode(parts[state.macro]);
    $('macro-capacity').textContent=`${used} / ${info.macroSize-1} bytes`;
  } catch(error) {state.macroEditable=false;$('macro-input').value='';$('macro-message').textContent=error.message;$('macro-capacity').textContent='원본 유지';}
}
function stageMacro() {
  if(!canEdit() || !state.macroEditable) return;
  try {
    const codec=new MacroCodec(registry),parts=codec.split(state.draft.macros,state.draft.info.macroCount);
    parts[state.macro]=codec.encode($('macro-input').value);
    state.draft.macros=codec.compose(parts,state.draft.info.macroSize);state.macroTexts.delete(state.macro);
    renderMacroList();renderMacro();renderControls();notify('매크로 변경을 준비했습니다. 「키보드에 적용」을 누르면 저장됩니다.');
  } catch(error) {$('macro-message').textContent=error.message;}
}
function renderHistory() {
  const entries=loadHistory();$('backup-empty').hidden=entries.length>0;$('backup-history').replaceChildren();
  const reasons={'connected':'연결 시 백업','before-apply':'설정 변경 전','before-reset':'초기화 전','preview':'미리보기 편집본'};
  for(const entry of entries) {
    const row=document.createElement('div');row.className='backup-row';const info=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('small');
    const date=new Date(entry.backup.created_at);title.textContent=Number.isNaN(date.getTime())?'저장한 설정':date.toLocaleString('ko-KR');
    detail.textContent=`${reasons[entry.reason]??'설정 백업'} · ${entry.backup.device.layers}개 레이어`;
    info.append(title,detail);const actions=document.createElement('div'),restore=document.createElement('button'),save=document.createElement('button');
    restore.className=save.className='button ghost';restore.textContent='불러오기';save.textContent='다운로드';
    restore.disabled=state.busy || !state.draft?.info.writable;
    restore.onclick=()=>loadBackup(entry.backup);save.onclick=()=>download(entry.backup,entry.reason);actions.append(restore,save);row.append(info,actions);$('backup-history').append(row);
  }
}
function loadBackup(doc) {
  try {const migrated=doc?.device?.protocol!==state.draft.info.protocol;state.draft=migrateBackup(doc,state.draft.info,tables);state.macroTexts.clear();renderMacroList();renderMacro();renderAll();notify(migrated?'백업을 새 펌웨어 형식으로 변환했습니다. 편집 화면을 확인한 뒤 적용해 주세요.':'백업을 편집 화면에 불러왔습니다. 적용하면 기기에 복원됩니다.');}
  catch(error){notify(error.message,true);}
}
async function perform(description,operation) {
  if(state.busy)return;
  state.busy=true;$('operation-status').hidden=false;$('operation-status').lastElementChild.textContent=description;
  await stopTest();renderAll();
  try {await operation();} catch(error){if(state.client?.transport.invalidated)await disconnect();notify(error.message??String(error),true);}
  finally {state.busy=false;$('operation-status').hidden=true;renderAll();refreshTester();}
}
async function connect() {
  if(state.busy || !('hid' in navigator) || !isSecureContext)return;
  // Request permission immediately in the click gesture, before any await.
  const selection=navigator.hid.requestDevice({filters:[{vendorId:VID,productId:PID,usagePage:0xff60,usage:0x61}]});
  await perform('Link65를 찾아 현재 설정을 읽고 있습니다…',async()=>{
    let devices;
    try {devices=await selection;}catch(error){if(error.name==='NotFoundError')return;throw error;}
    if(!devices.length){notify('기기 선택을 취소했습니다.');return;}
    const candidates=devices.filter(isLink65);
    if(candidates.length!==1)throw new ConfigurationError('설정할 Link65 Hotswap 한 대를 선택해 주세요.');
    if(state.client)await state.client.close();state.client=null;state.connected=false;
    const transport=await WebHIDTransport.open(candidates[0]),client=new Link65Client(transport);
    try {
      await client.identify(candidates[0].productName??'LINK Hotswap');
      const snapshot=await client.snapshot();await saveAutomatic(snapshot,'connected');
      const keep=state.deviceBaseline && dirty() && ['protocol','layers','macroCount','macroSize'].every(key=>snapshot.info[key]===state.baseline.info[key]);
      if(!state.deviceBaseline && dirty())await saveAutomatic(state.draft,'preview');
      state.client=client;state.connected=true;state.deviceBaseline=true;state.testUnavailable=false;
      acceptSnapshot(snapshot,keep);notify(keep?'연결했습니다. 적용 전 편집 내용도 유지했습니다.':'Link65에 연결했습니다. 현재 설정을 불러왔습니다.');
    } catch(error){await client.close();throw error;}
  });
}
async function disconnect(message='키보드 연결을 해제했습니다.') {
  await stopTest();const client=state.client;state.client=null;state.connected=false;
  if(client)await client.close();renderAll();if(message)notify(message);
}
function ensureAudio() {
  const Context=window.AudioContext??window.webkitAudioContext;
  if(!Context)throw new Error('이 브라우저에서 알림음을 재생할 수 없습니다.');
  if(!audio)audio=new Context();
  if(audio.state==='suspended')return audio.resume();
}
function sound() {
  try {
    if(!audio || audio.state!=='running')return;
    const now=audio.currentTime,osc=audio.createOscillator(),gain=audio.createGain();
    osc.type='sine';osc.frequency.setValueAtTime(1320,now);osc.frequency.exponentialRampToValueAtTime(1040,now+.045);
    gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.12,now+.003);gain.gain.exponentialRampToValueAtTime(.0001,now+.055);
    osc.connect(gain);gain.connect(audio.destination);osc.start(now);osc.stop(now+.06);osc.onended=()=>{osc.disconnect();gain.disconnect();};
  }catch(error){$('test-sound').checked=false;notify(`알림음을 재생하지 못했습니다. ${error.message}`,true);}
}
function focusTester(){if(state.view==='tester')$('tester-deck').focus({preventScroll:true});}
function readyTest(){return state.view==='tester' && state.connected && state.client && !state.busy && state.testWanted && !state.testUnavailable && document.visibilityState==='visible' && document.hasFocus() && !$('reset-dialog').open;}
async function stopTest() {
  state.pollGeneration++;const task=state.pollTask;state.pollTask=null;
  tester?.suspend();state.flashes.clear();if(tester)renderTest();
  if(task)await task;
}
function refreshTester() {
  if(!tester)return;
  if(readyTest() && !state.pollTask) {
    const generation=++state.pollGeneration;tester.suspend();
    state.pollTask=(async()=>{
      let previous='';
      try {
        while(generation===state.pollGeneration && readyTest()) {
          const start=performance.now(),matrix=await state.client.readMatrix();
          if(generation!==state.pollGeneration || !readyTest())break;
          const signature=[...matrix].join(',')+';';
          if(signature!==previous){
            previous=signature;const pressed=tester.update(matrix);
            if(pressed.size){for(const index of pressed)state.flashes.set(index,performance.now()+90);if($('test-sound').checked)sound();setTimeout(renderTest,100);}
            renderTest();
          }
          await delay(Math.max(4,20-(performance.now()-start)));
        }
      }catch(error){
        if(generation!==state.pollGeneration)return;
        if(error instanceof UnsupportedCommand){state.testUnavailable=true;notify('현재 펌웨어에서 물리 키 상태 조회를 지원하지 않습니다.',true);}
        else {const client=state.client;state.client=null;state.connected=false;if(client)await client.close();notify(error.message,true);}
        tester.suspend();state.flashes.clear();
      }finally{if(generation===state.pollGeneration)state.pollTask=null;renderControls();renderTest();}
    })();
  }else if(!readyTest() && state.pollTask){void stopTest();}
  renderTest();
}
function renderTest() {
  if(!tester)return;
  const active=readyTest();$('test-live-dot').classList.toggle('active',active);
  $('test-status').textContent=!state.connected?'연결하면 테스트를 시작합니다.':state.testUnavailable?'이 펌웨어는 키 테스트를 지원하지 않습니다.':state.busy?'설정 작업 중입니다.':!state.testWanted?'일시 정지':active?'테스트 중 · 키를 눌러 보세요.':'이 화면으로 돌아오면 계속합니다.';
  $('test-seen').textContent=tester.seen.size;$('test-held').textContent=tester.held.size;$('test-count').textContent=tester.count;
  const now=performance.now();for(const [index,until]of state.flashes)if(until<=now)state.flashes.delete(index);
  for(const [index,button]of state.testButtons) {
    const code=factory.keymap[0][index],name=testRegistry.caption(code),held=tester.held.has(index)||state.flashes.has(index);
    button.textContent=name;button.classList.toggle('modifier',code>=0xe0&&code<=0xe7 || [0x2b,0x39,0x28,0x2a].includes(code));
    button.classList.toggle('test-held',held);button.classList.toggle('test-seen',tester.seen.has(index)&&!held);
    button.setAttribute('aria-label',`${name}${held?' 누르는 중':tester.seen.has(index)?' 검사 완료':' 미검사'}`);
    button.title=`${testRegistry.label(code)} · 물리 위치 ${Math.floor(index/COLS)+1}행 ${index%COLS+1}열`;
  }
  $('test-last').textContent=tester.last.length?`최근 입력: ${tester.last.slice(0,8).map(index=>testRegistry.caption(factory.keymap[0][index])).join(' + ')}${tester.last.length>8?` 외 ${tester.last.length-8}개`:''}`:'키보드의 키를 눌러 보세요. 검사 기록은 이 화면에서만 유지됩니다.';
}
function setView(view) {
  if(!views[view])view='keymap';state.view=view;
  for(const [name]of Object.entries(views))$(`view-${name}`).hidden=name!==view;
  for(const button of document.querySelectorAll('[data-view]')){button.classList.toggle('active',button.dataset.view===view);if(button.dataset.view===view)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
  $('page-title').textContent=views[view][0];$('page-description').textContent=views[view][1];
  if(view==='tester'){try{void ensureAudio();}catch{}focusTester();}
  refreshTester();
}
async function initialize() {
  const responses=await Promise.all(['keycode-tables.json','physical-layout.json','factory-keymap.json'].map(async name=>{
    const response=await fetch(`./assets/${name}`);if(!response.ok)throw new Error('기기 정의를 불러오지 못했습니다. 페이지를 새로 고쳐 주세요.');return response.json();}));
  [tables,layout]=responses;factory={info:{name:'LINK Hotswap',protocol:12,layers:4,macroCount:16,macroSize:386,writable:true},keymap:responses[2],macros:new Uint8Array(386),layoutOptions:0};
  testRegistry=new KeyRegistry(tables);tester=new KeyTestState(layout.map(key=>key.row*COLS+key.col));
  state.baseline=cloneSnapshot(factory);state.draft=cloneSnapshot(factory);registry=new KeyRegistry(tables);
  buildBoard('keymap-board',state.boardButtons);buildBoard('tester-board',state.testButtons,true);
  acceptSnapshot(factory);
  if(!('hid'in navigator) || !isSecureContext){$('compatibility-banner').hidden=false;$('compatibility-banner').textContent=!isSecureContext?'기기 연결에는 HTTPS 또는 localhost 주소가 필요합니다. 배포 주소나 함께 제공한 로컬 실행기를 이용해 주세요.':'이 브라우저는 WebHID를 지원하지 않습니다. 데스크톱 Microsoft Edge 또는 Chrome에서 열어 주세요.';}
  if('hid'in navigator)navigator.hid.addEventListener('disconnect',event=>{if(state.client?.transport.device===event.device)void disconnect('USB 연결이 끊겼습니다. 키보드를 다시 연결해 주세요.');});
  $('connect-button').onclick=connect;
  $('disconnect-button').onclick=()=>{if(!state.busy)void disconnect();};
  for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{location.hash=button.dataset.view;};
  window.addEventListener('hashchange',()=>setView(location.hash.slice(1)));
  $('theme-button').onclick=()=>{theme=theme==='light'?'dark':'light';safePreference('link65-studio-theme',theme);setTheme();};
  $('key-search').oninput=renderCatalog;
  for(const button of document.querySelectorAll('[data-category]'))button.onclick=()=>{state.category=button.dataset.category;for(const sibling of document.querySelectorAll('[data-category]')){sibling.classList.toggle('active',sibling===button);sibling.setAttribute('aria-pressed',String(sibling===button));}renderCatalog();};
  $('keycode-form').onsubmit=event=>{event.preventDefault();try{stageKey(registry.parse($('keycode-input').value));}catch(error){notify(error.message,true);}};
  $('undo-key-button').onclick=()=>{if(state.selected!==null)stageKey(state.baseline.keymap[state.layer][state.selected]);};
  $('discard-button').onclick=()=>{state.draft=cloneSnapshot(state.baseline);state.macroTexts.clear();renderMacroList();renderMacro();renderAll();};
  $('apply-button').onclick=()=>{if(!state.client||!dirty())return;const baseline=cloneSnapshot(state.baseline),desired=cloneSnapshot(state.draft);void perform('변경 전 자동 백업을 만들고 설정을 저장합니다…',async()=>{const snapshot=await state.client.apply(baseline,desired,saveAutomatic,(done,total)=>{$('operation-status').lastElementChild.textContent=`키보드에 적용 중… ${done} / ${total}`;});acceptSnapshot(snapshot);notify('저장 완료. 기기에서 다시 읽어 적용 결과를 확인했습니다.');});};
  $('reload-button').onclick=()=>{if(state.client&&!dirty())void perform('현재 설정을 다시 읽고 있습니다…',async()=>{acceptSnapshot(await state.client.snapshot());notify('키보드에서 현재 설정을 다시 읽었습니다.');});};
  $('macro-input').oninput=()=>{state.macroTexts.set(state.macro,$('macro-input').value);$('macro-message').textContent='「변경 준비」를 누른 뒤 키보드에 적용하세요.';renderControls();};
  $('stage-macro').onclick=stageMacro;
  for(const button of document.querySelectorAll('[data-macro-insert]'))button.onclick=()=>{const input=$('macro-input');if(input.disabled)return;input.setRangeText(button.dataset.macroInsert,input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input'));input.focus();};
  $('export-backup').onclick=()=>{download(toBackup(state.draft),state.connected?'backup':'preview');notify(state.connected?'현재 편집본을 백업으로 다운로드했습니다.':'기본 배열의 미리보기 편집본을 다운로드했습니다.');};
  $('import-backup').onclick=()=>$('backup-file').click();
  $('backup-file').onchange=async()=>{const file=$('backup-file').files[0];if(!file)return;try{if(file.size>2*1024*1024)throw new ConfigurationError('백업 파일은 2MB 이하여야 합니다.');loadBackup(JSON.parse(await file.text()));}catch(error){notify(error.message,true);}finally{$('backup-file').value='';}};
  $('reset-button').onclick=()=>{if(!state.client || !canEdit())return;void stopTest();$('reset-extra').textContent=dirty()?'적용하지 않은 편집 내용도 초기화 결과로 바뀝니다.':'초기화 전 설정은 자동 백업 목록에서 다시 불러올 수 있습니다.';$('reset-dialog').showModal();$('reset-cancel').focus();};
  $('reset-cancel').onclick=()=>$('reset-dialog').close();
  $('reset-dialog').addEventListener('close',refreshTester);
  $('reset-confirm').onclick=()=>{$('reset-dialog').close();if(!state.client || !canEdit())return;void perform('현재 설정을 백업한 뒤 키보드 기본값을 복원합니다…',async()=>{acceptSnapshot(await state.client.factoryReset(state.baseline,saveAutomatic));notify('전체 키맵·매크로·레이아웃 옵션을 기본값으로 초기화했습니다.');});};
  $('sound-preview').onclick=async()=>{try{await ensureAudio();sound();focusTester();}catch(error){notify(error.message,true);}};
  $('test-sound').onchange=()=>{if($('test-sound').checked){try{void ensureAudio();}catch{}}focusTester();};
  $('test-pause').onclick=()=>{state.testWanted=!state.testWanted;try{void ensureAudio();}catch{}focusTester();renderControls();refreshTester();};
  $('test-clear').onclick=()=>{tester.clear();state.flashes.clear();renderTest();focusTester();};
  document.addEventListener('keydown',event=>{if(state.view==='tester' && state.connected && event.target.closest?.('#tester-deck'))event.preventDefault();},true);
  window.addEventListener('blur',refreshTester);window.addEventListener('focus',refreshTester);document.addEventListener('visibilitychange',refreshTester);
  window.addEventListener('beforeunload',event=>{if(state.busy||dirty()||state.macroTexts.size){event.preventDefault();event.returnValue='';}});
  setInterval(async()=>{if(!state.client||state.busy||state.pollTask)return;const client=state.client;try{await client.ping();}catch(error){if(client===state.client)await disconnect(error.message);}},8000);
  setView(location.hash.slice(1));
}
initialize().catch(error=>{$('compatibility-banner').hidden=false;$('compatibility-banner').textContent=error.message;notify(error.message,true);});
