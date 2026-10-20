# Link65 Studio Setting

Owlab Link65 Hotswap용 **Edge/Chrome WebHID 설정 페이지 v1.1.0**입니다. 펌웨어는 [link65_firmware](https://github.com/gapfixnid/link65_firmware)에서 별도로 관리합니다. 이 프로젝트의 실행·단위 테스트에는 펌웨어 폴더나 Python이 필요하지 않습니다.

## 실행

Node.js 20 이상에서 저장소 루트에서 실행합니다. 외부 npm 패키지는 사용하지 않습니다.

```powershell
npm run dev
```

Edge에서 `http://127.0.0.1:8765`를 열고 **키보드 연결**을 선택합니다. HTTPS 호스팅에서는 `dist/`를 정적 파일로 배포하면 됩니다. 실행 파일은 `dist/`에 직접 관리하며 별도의 번들 빌드 단계는 없습니다.

## 기능과 호환성

- 키 매핑, 레이어, 매크로 편집.
- 적용 전 백업, 변경 충돌 검사, 적용 후 다시 읽기.
- 백업 가져오기·내보내기와 공장 초기화.
- 눌린 위치 표시 및 알림음이 있는 키 테스트.
- Link65 정의 JSON 내장.

기존 VIA 7~12를 지원하며 Link65 순정 VIA 12와 호환됩니다. VIA 13에서는 QMK 키코드 버전 0.0.9를 협상한 경우에만 쓰기를 허용하고 알 수 없는 버전은 읽기 전용으로 연결합니다. Link65 Studio v1.0.1 및 v1.0.2-rc1과 호환됩니다. Studio 펌웨어의 명령 DFU 진입은 지원되지 않습니다.

키 테스트는 펌웨어의 현재 디바운스 매트릭스를 조회합니다. 화면 표시·알림음과 실제 USB 키 입력 전송은 서로 다른 경로입니다. 사용자 매핑과 백업은 브라우저에서 처리하며 Git에 저장하지 않습니다. Firefox에서는 직접 WebHID 연결을 지원하지 않습니다.

## 테스트

```powershell
npm test
```

키코드, 매크로, 백업, 초기화, HID 요청 직렬화·오류 격리와 키 테스트 상태를 검사합니다.

두 프로젝트 사이의 컴파일된 펌웨어 통합 검증은 선택 사항입니다. 펌웨어 프로젝트에서 Python 검증 의존성을 설치한 뒤 실행합니다.

```powershell
node tools/verify-firmware.mjs --firmware-dir <펌웨어 저장소 경로>
```

이 명령은 명시한 저장소의 에뮬레이터를 실행합니다. 실제 USB 장치를 열거나 설정을 기록하지 않습니다. 결과는 `.test-results/`에 생성됩니다.

## 소스와 배포

UI는 `dist/app.js`, `dist/styles.css`, `dist/index.html`, 기기 통신은 `dist/protocol.mjs`, 설정 모델은 `dist/model.mjs`에서 관리합니다. `dist/assets/`에는 공장 키맵·기하 정보·키코드 표와 Pretendard 폰트를 포함합니다.

현재 호스팅은 기존 주소를 유지합니다. Git에 커밋하거나 push하는 것만으로 해당 호스팅이 자동 배포되지는 않습니다.

## 라이선스

GPL v3. [LICENSE.txt](LICENSE.txt), [THIRD_PARTY_NOTICES.txt](dist/THIRD_PARTY_NOTICES.txt), Pretendard의 SIL Open Font License를 유지합니다.
