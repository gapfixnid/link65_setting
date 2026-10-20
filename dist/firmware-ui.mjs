import {Link65DFU,UpdateSession,RELEASE,FirmwareError,validateImage} from './firmware.mjs';

export class FirmwareUI {
  constructor({getClient,run,notify,download,saveAutomatic,tables,connectKnown,onRestored}){
    Object.assign(this,{getClient,run,notify,download,saveAutomatic,tables,connectKnown,onRestored});
    this.session=new UpdateSession();this.dfu=null;this.image=null;this.report=null;this.busy=false;
    this.$=id=>document.getElementById(id);
  }
  async initialize(){
    try{await this.session.load();}catch(error){this.notify(error.message,true);}
    this.$('firmware-version').textContent=`Link65 Studio ${RELEASE.version}`;
    this.$('firmware-hash').textContent=RELEASE.sha256;
    this.$('firmware-backup').onclick=()=>void this.action('현재 기기 설정을 두 번 읽어 백업합니다…',async()=>{
      if(!this.getClient())throw new FirmwareError('상단의 「키보드 연결」로 정상 모드의 기기를 먼저 연결해 주세요.');
      const backup=await this.session.prepare(this.getClient());
      await this.saveAutomatic(await this.getClient().snapshot(),'before-firmware');
      this.download(backup,'before-firmware');this.report=null;
      this.message('현재 기기 설정을 두 번 읽어 확인하고 백업했습니다. 이제 B 키를 누른 채 USB를 다시 연결해 주세요.');
    });
    this.$('firmware-session-download').onclick=()=>{
      try{this.download(this.session.export(),'firmware-recovery');}catch(error){this.notify(error.message,true);}
    };
    this.$('firmware-known-connect').onclick=()=>void this.connectKnown();
    this.$('firmware-backup-file').onchange=()=>void this.action('업데이트 복구 백업을 확인합니다…',async()=>{
      const file=this.$('firmware-backup-file').files[0];if(!file)return;
      try{if(file.size>1024*1024)throw new FirmwareError('복구 백업 파일은 1MB 이하여야 합니다.');
        if(this.dfu)throw new FirmwareError('DFU 연결을 종료한 뒤 백업을 불러와 주세요.');
        await this.session.import(JSON.parse(await file.text()));this.report=null;this.clearConsent();
        this.message('복구 백업을 브라우저에 보관했습니다. 기록하려면 이번 DFU 연결에서 읽기 검증을 다시 완료해야 합니다.');
      }finally{this.$('firmware-backup-file').value='';}
    });
    this.$('firmware-dfu-connect').onclick=()=>{
      if(this.busy||!navigator.usb)return;
      // Must run directly inside the click, before any async backup or device operations.
      let selection;try{selection=Link65DFU.request();}catch(error){this.notify(error.message,true);return;}
      void this.action('DFU 장치의 연결·읽기 호환성을 검사합니다…',async()=>{
        const device=await selection;
        if(!this.session.hasConfiguration)throw new FirmwareError('정상 모드의 현재 설정 백업을 먼저 준비해 주세요.');
        if(this.dfu)await this.dfu.close();this.dfu=null;this.report=null;this.clearConsent();
        const candidate=new Link65DFU(device);
        try{
          await candidate.open();
          const inspection=await candidate.inspect((range,round,done,total)=>{
            this.message(`${range==='application'?'펌웨어':'설정'} 영역 읽기 ${round}/2 · ${done.toLocaleString()} / ${total.toLocaleString()} B`);
          });
          await this.session.storeInspection(inspection);this.dfu=candidate;this.report=inspection.report;
          this.download(this.session.export(),'firmware-recovery');
          this.message('읽기 호환성 검증 통과. 펌웨어 36KiB와 설정 4KiB를 각각 두 번 읽어 일치를 확인했습니다. 삭제·펌웨어 기록은 하지 않았습니다.');
        }catch(error){await candidate.close();throw error;}
      });
    };
    this.$('firmware-load-release').onclick=()=>void this.action('검증된 펌웨어 파일을 확인합니다…',async()=>{
      const response=await fetch(RELEASE.file,{cache:'no-store'});if(!response.ok)throw new FirmwareError('펌웨어 파일을 불러오지 못했습니다.');
      this.image=new Uint8Array(await response.arrayBuffer());await validateImage(this.image);this.clearConsent();
      this.message(`Link65 Studio ${RELEASE.version} 파일의 SHA-256, DFU CRC와 시작 주소를 확인했습니다.`);
    });
    this.$('firmware-file').onchange=()=>void this.action('선택한 펌웨어 파일을 검증합니다…',async()=>{
      const file=this.$('firmware-file').files[0];this.image=null;this.clearConsent();if(!file)return;
      try{if(file.size!==RELEASE.bytes)throw new FirmwareError('검증된 Link65 펌웨어와 파일 크기가 다릅니다.');
        const data=new Uint8Array(await file.arrayBuffer());await validateImage(data);this.image=data;
        this.message('선택한 펌웨어의 SHA-256, DFU CRC와 시작 주소를 확인했습니다.');
      }finally{this.$('firmware-file').value='';}
    });
    this.$('firmware-consent').onchange=()=>this.render();
    this.$('firmware-write').onclick=()=>{
      if(!this.readyToWrite())return;
      this.$('firmware-write-dialog').showModal();this.$('firmware-write-cancel').focus();
    };
    this.$('firmware-write-cancel').onclick=()=>this.$('firmware-write-dialog').close();
    this.$('firmware-write-confirm').onclick=()=>{
      this.$('firmware-write-dialog').close();if(!this.readyToWrite())return;
      void this.action('백업과 현재 Flash를 재확인한 뒤 펌웨어를 기록합니다…',async()=>{
        const report=await this.dfu.flash(this.image,{confirmed:true,session:this.session,
          progress:(stage,done,total)=>this.message(`${stage==='erase'?'앱 영역 삭제':'펌웨어 기록'} · ${Math.round(done/total*100)}%`)});
        this.report=report;this.clearConsent();this.download(report,'firmware-write-result');
        this.message('기록한 펌웨어가 파일과 일치하며 설정 Flash도 보존됐습니다. 「정상 모드로 돌아가기」 후 설정을 다시 확인해 주세요.');
      });
    };
    this.$('firmware-leave').onclick=()=>void this.action('정상 모드로 돌아가는 명령을 보냅니다…',async()=>{
      await this.dfu.leave({confirmed:true,session:this.session});this.dfu=null;this.clearConsent();
      this.message('정상 모드 재연결을 기다립니다. 「허용한 키보드 다시 연결」 또는 상단의 「키보드 연결」을 누른 뒤 설정 보존을 확인해 주세요.');
    });
    this.$('firmware-check-normal').onclick=()=>void this.action('현재 펌웨어 버전과 백업 설정을 비교합니다…',async()=>{
      const result=await this.session.checkNormal(this.getClient(),this.tables);this.report=result.report;
      this.download(result.report,'firmware-settings-check');
      this.message(result.report.settingsPreserved&&result.report.versionMatches?
        '설정 보존 확인 완료. 전체 키맵·매크로·레이아웃이 백업과 일치합니다. 복원 기록은 필요하지 않았습니다.':
        '백업과 다른 항목이 있습니다. 아래 결과를 확인하고 필요한 경우 「백업 설정 복원」을 선택해 주세요.');
    });
    this.$('firmware-restore').onclick=()=>{
      this.$('firmware-restore-dialog').showModal();this.$('firmware-restore-cancel').focus();
    };
    this.$('firmware-restore-cancel').onclick=()=>this.$('firmware-restore-dialog').close();
    this.$('firmware-restore-confirm').onclick=()=>{
      this.$('firmware-restore-dialog').close();
      void this.action('현재 설정을 추가 백업한 뒤 업데이트 전 설정을 복원합니다…',async()=>{
        const result=await this.session.restore(this.getClient(),this.tables,this.saveAutomatic);this.report=result.report;
        this.onRestored?.(result.current);
        this.message('업데이트 전 백업을 복원하고 기기에서 다시 읽어 확인했습니다.');
      });
    };
    this.$('firmware-report-download').onclick=()=>{if(this.report)this.download(this.report,'webusb-result');};
    navigator.usb?.addEventListener('disconnect',event=>{
      if(this.dfu?.device===event.device){void this.dfu.close();this.dfu=null;this.clearConsent();this.render();}
    });
    this.render();
  }
  clearConsent(){this.$('firmware-consent').checked=false;}
  readyToWrite(){return !this.busy&&this.dfu?.compatible&&this.session.phase==='read-verified'&&this.session.hasFlashBackup&&
    this.image&&this.$('firmware-consent').checked;}
  message(text){this.$('firmware-status').textContent=text;}
  async action(description,operation){
    if(this.busy)return;this.busy=true;this.render();
    try{await this.run(description,async()=>{try{await operation();}catch(error){
      this.clearConsent();this.message(error.name==='NotFoundError'?'장치 선택을 취소했습니다.':error.message);
      if(error.name!=='NotFoundError')throw error;
    }});}finally{this.busy=false;this.render();}
  }
  render(){
    const $=this.$,client=this.getClient(),busy=this.busy||this.externalBusy,summary=this.session.summary;
    const usb=Boolean(navigator.usb&&isSecureContext),backup=this.session.hasConfiguration;
    $('firmware-support').textContent=usb?'WebUSB 사용 가능':'Edge 또는 Chrome에서 HTTPS 주소로 열어 주세요.';
    $('firmware-current').textContent=client?.info?.firmwareVersion?
      `${client.info.firmwareVersion>>>16}.${(client.info.firmwareVersion>>>8)&255}.${client.info.firmwareVersion&255}`:'정상 모드 연결 후 확인';
    $('firmware-backup-state').textContent=backup?`백업 보관됨 · ${new Date(summary.at).toLocaleString('ko-KR')}`:'현재 기기 설정 백업이 필요합니다.';
    $('firmware-dfu-state').textContent=this.dfu?.compatible?'연결·두 번 읽기 검증 통과':this.session.hasFlashBackup?'이전 읽기 결과 보관됨 · 기록 전 재검증 필요':'부트로더 연결 대기';
    $('firmware-image-state').textContent=this.image?'파일 무결성 검증 완료':'펌웨어 파일을 확인해 주세요.';
    $('firmware-backup').disabled=busy||!client||Boolean(this.dfu);
    $('firmware-session-download').disabled=busy||!backup;
    $('firmware-known-connect').disabled=busy||Boolean(this.dfu);
    $('firmware-dfu-connect').disabled=busy||!usb||!backup;
    $('firmware-load-release').disabled=busy;
    $('firmware-file').disabled=busy;
    $('firmware-backup-file').disabled=busy||Boolean(this.dfu);
    $('firmware-consent').disabled=busy||!this.dfu?.compatible||!this.image;
    $('firmware-write').disabled=busy||!this.readyToWrite();
    $('firmware-leave').disabled=busy||!this.dfu||!['read-verified','written-verified'].includes(this.session.phase);
    $('firmware-check-normal').disabled=busy||!client||!backup||Boolean(this.dfu);
    $('firmware-restore').disabled=busy||!client||Boolean(this.dfu)||summary?.postCheck?.settingsPreserved!==false||!summary?.postCheck?.versionMatches;
    $('firmware-report-download').disabled=busy||!this.report;
    const report=this.report??summary?.postCheck??summary?.compatibility;
    $('firmware-result').hidden=!report;
    if(report)$('firmware-result-text').textContent=JSON.stringify(report,null,2);
    if(!this.report&&report)this.report=report;
    $('firmware-backup-card').dataset.complete=String(backup);
    $('firmware-read-card').dataset.complete=String(this.dfu?.compatible??false);
  }
}
