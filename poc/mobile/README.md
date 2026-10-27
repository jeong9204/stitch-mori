# StitchMori 모바일 저장 PoC (Phase 4B-3)

로그인·Next.js·Docker·Supabase 없이 사용할 별도 정적 앱입니다. 프로젝트와 기본 파트 각 1개, 로컬 카운터, 사진 1개, 시작/종료 타이머, ZIP 백업/복원만 검증합니다. 출시 앱이 아니며 기존 웹 앱 데이터를 가져오거나 삭제하지 않습니다.

## 실행

Node.js 22.12 이상(검증: 22.22.0)을 사용합니다. 저장소 루트가 아닌 이 폴더에서 실행합니다.

```sh
cd poc/mobile
npm ci
npm run dev
# http://127.0.0.1:5188
npm run lint
npm run typecheck
npm test
npm run build
npm run preview
```

웹 preview는 정적 파일을 제공하기 위한 서버입니다. 최초 웹 로딩은 이 서버가 필요합니다. 서비스 워커/PWA 설치는 이번 범위에 없습니다. Capacitor는 `dist`를 앱 내부에 복사하며 `server.url`을 사용하지 않습니다. 앱 실행 시 외부 서버에 연결하는 코드, Supabase SDK, 환경변수 로딩, 원격 폰트가 없습니다. 개발 도구 설치·네이티브 의존성 다운로드에는 인터넷이 필요합니다.

## 공통 코드와 저장 계약

- 기존 `src/domain/counter/{engine,types}`와 `src/domain/timer/{engine,types}`를 직접 import합니다. 기존 엔진은 수정하지 않습니다.
- 기존 Next.js 인증/저장소/큐를 import하지 않습니다. 루트 TypeScript·ESLint에서는 `poc`를 제외하여 빌드 경계를 유지합니다.
- IndexedDB: **`stitchmori-storage-poc-v1`**, 단일 `workspace` object store. 프로젝트·파트·work item UUID, 카운터·이벤트, 타이머 세션·이벤트와 사진 Blob을 하나의 스냅샷으로 보관합니다. 기기 ID는 별도 키입니다.
- 카운터·타이머 command ID와 revision은 공통 도메인 규칙을 따릅니다. 행 완료의 코수/단수와 이벤트를 하나의 readwrite 트랜잭션으로 저장합니다. 실행 취소는 이벤트 추가 방식입니다.
- UI 입력은 메모리에서 직렬화하고, **IndexedDB transaction complete 이후 재조회가 끝나야** 저장 완료로 표시합니다. 실패 시 명령 ID/payload를 유지해 재시도합니다. 명확히 거절된 미적용 명령만 사용자 선택으로 취소할 수 있습니다.
- 메모리 대기열은 영속 outbox가 아닙니다. 아직 로컬 트랜잭션이 완료되지 않은 입력은 앱 강제 종료 시 잃을 수 있습니다. 대기/오류 안내와 웹 이탈 경고를 제공하지만 OS 강제 종료 경고를 보장하지 않습니다. 저장 완료된 데이터의 복원을 검증하는 PoC입니다. 기존 Phase 4A outbox에는 접근하지 않습니다.
- 여러 탭의 readwrite 트랜잭션과 revision 검사로 오래된 변경을 거절합니다. 자동 병합·충돌 재기준화는 하지 않습니다. 앱 전체의 다중 탭 동기화 UX는 후속 범위입니다.
- 타이머는 사용자 조작으로 start/end만 지원합니다. timestamp와 누적 밀리초로 복원하며, running 세션은 앱을 닫아도 다음 실행 시 계속 경과한 것으로 계산합니다. 종료 후 메인 표시만 0이며 원본 세션은 남습니다. 기기 시계 조작에 대한 신뢰할 수 있는 시간 보정은 없습니다.

## 사진과 ZIP

JPEG/PNG/WebP의 실제 시그니처와 이미지 디코딩을 확인합니다. 입력 10MiB 이하·4천만 픽셀 이하, 긴 변 1600px 이하 JPEG로 재인코딩하고 결과를 2MiB 이하로 제한합니다. 브라우저의 EXIF 방향 처리와 canvas 재인코딩을 사용하며 원본 메타데이터를 복사하지 않습니다. HEIC·카메라 촬영은 지원하지 않습니다. iPhone EXIF·색상·메모리 사용은 실기기 확인이 필요합니다.

사진은 Blob·크기·SHA-256으로 저장합니다. 최적화와 트랜잭션 성공 전 기존 사진을 교체하지 않습니다. 교체 시 같은 스냅샷 안의 기존 Blob 참조를 교체하므로 별도 원격 객체 정리가 없습니다. 저장소 용량은 기기/OS에 따라 다르며 영구 보존을 보장하지 않습니다.

백업은 JSON과 선택적 JPEG 한 개로 구성한 **암호화되지 않은 ZIP**입니다. 카운터·타이머 ID, 이벤트 순서와 undo 관계를 보존합니다. 복원 전 ZIP 경로/크기/CRC·형식, 엔진 재생 결과, 사진 해시를 검사하고 브라우저에서는 사진 디코딩도 검사합니다. 복원 확인 후 PoC 스냅샷을 단일 트랜잭션으로 교체합니다. 기존 앱 저장소는 변경하지 않습니다.

PoC 제한: ZIP 최대 24MiB, JSON 최대 16MiB, 카운터+타이머 이력 합계 최대 5,000건. 제한 초과는 전체 실패로 안내하며 일부 백업/복원하지 않습니다. 기록이 커지면 백업 전에 제한에 걸릴 수 있으므로 출시 전 분할/스트리밍 설계가 필요합니다. 실행 중 세션 백업을 나중에 복원하면 백업 이후 시간도 경과한 것으로 처리하므로 복원 확인창을 반드시 확인하세요.

웹은 파일 다운로드, iOS/Android는 Filesystem Cache에 ZIP을 생성한 뒤 Share sheet로 내보냅니다. **공유 완료는 외부 파일 저장 완료가 아닙니다.** 파일 앱/저장 위치에서 ZIP을 직접 확인해야 합니다. 공유용 캐시는 수신 앱의 비동기 읽기를 위해 즉시 지우지 않습니다. 오래된 공유 캐시 자동 정리는 후속 과제입니다. 이미지와 ZIP 입력은 시스템 HTML 파일 선택기를 사용하며, 광범위한 사진/외부 저장소 접근 권한은 추가하지 않습니다. 카메라 플러그인도 없습니다.

## 네이티브 빌드·실행

고정 식별자:

| 항목 | PoC 값 |
| --- | --- |
| 앱 ID / iOS bundle ID / Android applicationId | `com.stitchmori.storagepoc` |
| 이름 | StitchMori Storage PoC |
| iOS origin | `capacitor://localhost` |
| Android origin | `https://localhost` |
| IndexedDB | `stitchmori-storage-poc-v1` |

앱 ID·scheme·hostname·DB 이름을 바꾸면 저장 영역이 달라질 수 있습니다. 테스트 중 고정하고 출시 앱은 별도 ID를 선택해야 합니다. 웹 `127.0.0.1:5188`과 네이티브 origin은 다른 저장소입니다. 자동 이전하지 않습니다.

네이티브 프로젝트는 이미 생성되어 있으므로 `cap add`를 다시 하지 않습니다.

```sh
npm run native:sync
npm run ios:open
# Xcode에서 App target, signing team과 연결한 iPhone 또는 Simulator 선택 → Run
npm run android:open
# Android Studio에서 SDK/JDK와 기기/Emulator 선택 → Run
# Android CLI (SDK와 JAVA_HOME 설정 후)
cd android
./gradlew assembleDebug
```

Capacitor 8은 Node 22+, Xcode 26+, Android Studio 2025.2.1+ 환경을 요구합니다. Android Studio 제공 JDK를 사용하고 SDK 36을 설치합니다. 이 프로젝트의 생성 설정은 iOS 15.0+, Android minSdk 24 / target·compileSdk 36입니다. 세부 조건은 [공식 환경 설정](https://capacitorjs.com/docs/getting-started/environment-setup)을 확인하세요. iOS는 생성된 Swift Package Manager 프로젝트를 사용합니다.

Filesystem용 iOS `PrivacyInfo.xcprivacy`를 앱 리소스에 포함했습니다(FileTimestamp C617.1; [공식 안내](https://capacitorjs.com/docs/apis/filesystem)). Android는 PoC 자동 OS 백업을 끄기 위해 `allowBackup=false`입니다. 앱 내부 데이터/캐시를 외부 백업으로 간주하지 않습니다. iOS 시스템 백업에서 WKWebView 데이터가 어떻게 취급되는지는 보장하지 않습니다.

### 이 환경의 검증 결과 (2026-10-27)

- 정적 빌드·lint·타입 검사·Vitest 15개 통과.
- `cap add ios`, `cap add android`, `cap sync` 성공, 세 플러그인(App/Filesystem/Share) 연결.
- iOS plist·privacy manifest·pbxproj 문법 검사 통과.
- **네이티브 컴파일/Simulator/Emulator/실기기는 미검증**. `xcodebuild`는 전체 Xcode가 없어서 실패, Gradle assembleDebug는 Java Runtime이 없어 시작하지 못했습니다. 대규모 개발 도구 설치는 하지 않았습니다.
- Chrome: 프로젝트 생성, +1 연속 10회, 실행 취소, 행 완료 초기화/유지, 타이머 시작·시간 증가·새로고침 복원·종료, ZIP 실제 다운로드를 확인했습니다. 320px/375px 가로 넘침을 확인했습니다.
- Chrome 파일 업로드 자동 제어는 확장 프로그램의 파일 URL 접근 제한으로 차단됐습니다. **브라우저 사진 선택·재업로드·ZIP 파일 선택 복원 전체 흐름은 미검증**입니다. 파일 접근 권한을 자동으로 확대하지 않았습니다. Blob 저장·교체 실패 보존·ZIP 왕복과 변조 거부는 fake-indexeddb 기반 테스트로 검증했습니다.
- Docker/Supabase 실제 종료 테스트는 기존 사용자 서비스 보존을 위해 실행하지 않았습니다. PoC는 해당 주소/SDK/서버 모듈을 사용하지 않으며 테스트에 DB 서비스가 필요하지 않습니다. 설치형 앱 최초 오프라인 실행은 아래 실기기 절차로 확인해야 합니다.

## 반드시 수행할 실기기 PoC 절차

기존 실제 사용자 데이터가 없는 **PoC 앱**에서 수행하고 iOS/Android·OS 버전·WebView 버전·결과를 각각 기록합니다.

1. 앱 설치 후 비행기 모드, Docker/Next/Supabase가 없는 환경에서 최초 실행 → 프로젝트 생성 → 저장 완료 확인.
2. 100회 빠른 카운트와 실행 취소, 단 완료 초기화/유지/취소. 홈 이동·강제 종료·기기 재부팅 후 값/ID/이력 일치 확인.
3. 가로/세로/EXIF 회전 사진 선택, Blob 복원, 손상/과대 파일 거부. 저장 실패/용량 부족 시 이전 사진 보존. iOS 제한된 사진 접근, Android 시스템 선택기 취소도 확인.
4. 시작 후 10초 → 백그라운드 1분 → 강제 종료·재실행. timestamp 기반 시간 확인 → 종료 확정 → 메인 0, 기록 유지 → 새 시작 새 세션 확인.
5. ZIP을 앱 외부 Files/Downloads에 저장하고 사진·ID·이력 포함 여부 확인. 현재 PoC 기록을 변경한 뒤 ZIP 복원 → 값/이벤트/Blob/세션 완전 일치 확인. 손상 ZIP·트랜잭션 실패 시 기존 데이터 보존 확인.
6. 같은 앱 ID/origin/DB 이름으로 버전/빌드 번호만 올려 덮어 설치 → 데이터 유지 확인. origin 변경은 별도 앱 데이터로 취급합니다.
7. 외부 백업이 실제 존재하는 것을 확인한 후에만 PoC 앱 삭제·재설치 → 내부 저장이 사라질 수 있음을 확인 → 외부 ZIP으로 복원. **앱 삭제 후 데이터 자동 유지/복구를 약속하지 않습니다.**
8. 앱 오프로딩(iOS), 저장소/캐시 정리(Android), 저용량·백업 취소·공유 취소·앱 업데이트 중단, 320/375px 상당 작은 화면·키보드·safe-area 확인.

이 절차가 끝나기 전에는 기존 앱의 본격 이전이나 앱스토어 출시 준비 완료로 판단하지 않습니다. 다음 단계는 실기기 결과를 바탕으로 저장 계층(IDB 유지 또는 네이티브 SQLite/파일)을 결정하고, 메모리 대기 입력의 내구성 및 백업 규모 제한을 보완하는 것입니다. 클라우드 연결과 기존 데이터 이전은 별도 작업입니다.

## iPhone 실행 점검 추가 기록 (2026-10-27)

후속 점검 환경은 Xcode 27.1 / iOS SDK 27.1 / 실제 iPhone 16 Pro(iOS 27.0.1)입니다. 위 ‘이 환경의 검증 결과’는 초기 생성 시점의 기록이며, 후속 실기기 결과는 이 절을 기준으로 구분합니다. Android 네이티브 검증은 여전히 미완료입니다.

처음에는 앱이 설치돼도 홈 아이콘 실행 직후 종료됐습니다. 실제 PoC 크래시 로그의 `UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`으로 원인을 확인했습니다. 기존 CLI 8.4 템플릿에 scene 구성이 없었던 것이 원인으로, iOS 27 SDK 빌드는 UIKit scene 생명주기가 필요합니다. 설치된 Capacitor iOS 8.5.3의 `SceneDelegateProxy`를 사용해 SceneDelegate, Info.plist manifest 및 Xcode Sources 등록을 추가했습니다. 프로그램으로 단일 window/bridge를 생성하며 앱 ID·hostname·scheme·IndexedDB 이름은 바꾸지 않습니다. 패키지 버전과 공통 도메인 엔진도 변경하지 않았습니다.

참고: [Apple UIKit 전환 안내](https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle), [Capacitor 8.5 전환 안내](https://capacitorjs.com/docs/updating/8-5).

확인한 범위:

- iOS arm64 네이티브 컴파일 및 Personal Team 서명 빌드 성공.
- 연결된 실제 iPhone에 같은 앱 ID로 덮어 설치 후 실행 요청 성공. 사용자 직접 확인으로 초기 종료 문제 해소 확인.
- 사용자 실기기 확인: 연속 +1·−1·실행 취소, 단 완료 초기화 후 코수/단수 동시 복원, 저장 완료 뒤 강제 종료·홈 아이콘 재실행 시 프로젝트·값·이력 유지.
- 사용자 실기기 확인: 타이머 증가, 백그라운드·강제 종료 후 시간 복원, 종료 시 메인 숫자 초기화와 마지막 확정 시간 보존.
- 사용자 실기기 확인: 사진 선택·저장 후 강제 종료·재실행 시 사진 유지.
- 사용자 실기기 확인: iPhone 파일 앱에 ZIP 저장, 변경 후 ZIP 복원 시 원래 기록으로 복귀.
- 사용자 실기기 확인: 비행기 모드·Wi-Fi 꺼짐 상태에서 홈 아이콘 실행, +1 저장 및 강제 종료·재실행 후 보존. Mac의 기존 Docker/Supabase 서비스는 중지하거나 변경하지 않았습니다.
- PoC lint·typecheck 및 Vitest 15개 재통과. 실기기 기능 확인은 사용자 수동 테스트이며 자동 UI 테스트 통과로 표시하지 않습니다.

아직 검증 완료로 간주하지 않는 범위: 앱 삭제·재설치 후 복원, 데이터가 쌓인 상태의 버전 업데이트, 기기 재부팅, 저장소 용량 부족·쓰기 중단, 모든 EXIF/이미지 형식 조합, Android 실기기. 개발자 신뢰·키체인 접근 승인은 사용자가 직접 수행했습니다. 공유 프로젝트에는 Personal Team ID를 포함하지 않습니다. 이 Mac의 Team 설정은 로컬 미커밋 변경으로 유지하며, 다른 개발자는 Xcode에서 자신의 Team을 선택해야 합니다. Swift 패키지 버전 재현을 위해 `Package.resolved`는 버전 관리하고, 개인 Xcode 사용자 상태·서명키·빌드 산출물은 제외합니다.
