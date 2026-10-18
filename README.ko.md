# VeriScope 게이트 리플레이

[中文](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/README.md) · [English](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/README.en.md) · [日本語](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/README.ja.md) · **한국어**

> 이 문서는 중국어 원문의 번역입니다. 해석이 다를 경우 중국어 원문을 우선합니다.

**AI 답변 품질을 위한 릴리스 게이트.** 이미 평가된 결과가 배포 가능한지 판정하고, 다시 확인할 수 있는 영수증을 남깁니다.

- **두 가지 경로**: VeriScope 아카이브를 원래 Python 게이트로 리플레이하거나, 기존의 행별 점수에 대해 Node만으로 임계값 판정을 수행합니다. 후자는 VeriScope·Python·pandas가 필요 없습니다
- **세 가지 상태**: PASS／FAIL／REVIEW. REVIEW가 PASS로 바뀌지 않으며, 확정된 FAIL이 부수적 이상으로 덮이지 않습니다
- **영수증**: 입력·정책·판정기·환경을 연결하며, 어느 하나라도 바뀌면 이전 결론은 무효가 됩니다
- **채점도 모델 호출도 하지 않음**: 이미 존재하는 결과만 소비합니다

[GitHub](https://github.com/4444wjt/dsh-plugin-veriscope) · [Gitee 수동 동기화 미러](https://gitee.com/kkbushishou/dsh-plugin-veriscope) · VeriScope 본체: [메인](https://github.com/4444wjt/RAG_Evaluation_Demo)／[미러](https://gitee.com/kkbushishou/rag-hallucination-evaluator). 이슈와 PR은 GitHub로.

## 지원 호스트

| 호스트 | 형태 | 연결 방법 |
|---|---|---|
| **DSH** | 플러그인(cordis bundle) | `dsh plugin --profile <이름> add dsh-plugin-veriscope` |
| **Claude Code** | MCP server | `claude mcp add --transport stdio --env VERISCOPE_STATE_DIR=<디렉터리> -- node <절대 경로>/mcp.js` |
| **Codex** | MCP server | `config.toml`에 `[mcp_servers.veriscope]` 추가 |
| **호스트 없음 / CI** | CLI | `veriscope-check --archive … --policy …` |

DSH·Claude Code·Codex 모두 실제 도구 호출 기록이 있습니다. MCP와 CLI는 `bind`／`complete` 및 네이티브 결과 카드를 제공하지 않습니다. 설정 예시는 [MCP 연결 안내](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/MCP.md)를 보십시오.

> **업그레이드(0.4.0 이후)**: 기존 영수증의 현재 유효성은 REVIEW가 되지만 과거 PASS／FAIL 판정은 다시 쓰지 않습니다. 업그레이드 전에 전체 상태 디렉터리와 원본 아카이브를 백업하고 플러그인 밖의 영구 상태 디렉터리를 사용하십시오. 패키지 안의 `.local`은 재설치 시 사라질 수 있으며 영수증 내보내기만으로는 완전한 백업이 되지 않습니다. ReceiptV1은 replay, ReceiptV2는 check를 다시 실행하십시오.

---

아래 기존 VeriScope 안내는 replay에 적용됩니다. B2 입력·판정·영수증은 위 별도 설명을 따릅니다.

원래 VeriScope 아카이브와 B2 GateArchiveV1 및 지정된 Ragas records 형식을 지원합니다. 미지원 형식은 거부하며 추측하거나 환산하지 않습니다.

## 기존 점수 직접 확인: B2(0.6.0 로컬 후보 버전)

이미 Ragas 점수가 있다면 점수 JSON을 내보내고, 확인할 지표와 임계값을 정해 게이트 판정과 영수증 저장을 실행할 수 있습니다. **VeriScope 설치나 새로운 모델 채점은 필요하지 않습니다.**

Node ≥22.19만 필요합니다. 호스트 시작 전에 쓰기 가능한 영구 디렉터리를 `VERISCOPE_STATE_DIR`로 명시하십시오. settings UI는 없고 `.env`를 읽지 않습니다. B2는 VeriScope／Python 경로를 사용하지 않습니다.

> `veriscope_gate_check`로 `D:\data\scores.json`을 확인하십시오. 정책은 `D:\data\policy.json`, 형식은 `ragas-records-v1`로 지정하고 판정 이유를 설명하십시오.

```powershell
$env:VERISCOPE_STATE_DIR = 'D:\your-data\veriscope-state'
node scripts/check.mjs --archive examples/builtin/ragas-records.json --policy examples/builtin/policy.json --format ragas-records-v1 --json
```

- `GateArchiveV1`과 Ragas `result.to_pandas().to_json(orient="records")` 형식을 지원하며 `GatePolicyV1` 또는 `GatePolicyV2`를 명시합니다. 필드나 임계값을 추측하지 않습니다.
- 제공된 모든 행의 동일 가중 평균을 사용합니다. 결측값을 0으로 채우거나 제외하지 않습니다. 완전한 평균이 미달하거나 유효한 행이 명시된 개별 임계값을 위반하면 FAIL입니다. 그 외 정보 부족은 REVIEW이며 모든 데이터와 조건을 충족해야 PASS입니다.
- `faithfulness`를 `pos_faithfulness`로 바꾸지 않습니다. B2 PASS는 원래 게이트와 같은 판정이 아니며, 점수의 진실성이나 답변의 사실 정확성을 증명하지 않습니다. 내보내기 전에 삭제된 행도 발견할 수 없습니다.
- DSH／MCP에서 check, 설치 후 CLI에서 `veriscope-check`를 제공합니다. `doctor({engine:"builtin"})`는 Python을 확인하지 않습니다. status／list는 두 영수증 버전을 처리합니다.
- B2는 ReceiptV2와 텍스트만 사용하며 bind／complete에는 사용하지 않습니다. DSH의 JSON／Markdown 내보내기는 지원하지만 B2 share는 지원하지 않습니다. 기록은 무기한 보관하며 자동 정리하지 않습니다.

**평균이 통과해도 가장 낮은 성능의 행을 확인할 수 있습니다.** 지표마다 최악의 유효 행과 평균 임계값 미달 행 수를 보여 줍니다. 진단만으로 판정은 바뀌지 않습니다. 개별 행을 제한하려면 `GatePolicyV2`의 `row_threshold`를 명시하며 같은 방향과 단위를 사용합니다. 구성 예제에서는 평균 0.81에 0.41인 행이 포함되어 평균만 검사하면 PASS, 모든 행 ≥0.5를 요구하면 FAIL입니다. V2는 원본 JSON 숫자 토큰을 정확한 십진수로 비교하며 V1 부동소수점 판정은 유지합니다.

동봉된 `docs/B2.md`, `schemas/`, `examples/builtin/`을 참조하십시오. 예제는 구성 예이며 실제 평가가 아닙니다. 0.6.0은 npm에 공개되었습니다. Windows와 Ubuntu 원격 CI(고정 업스트림 실제 리플레이 포함)를 통과했으며 Claude의 완전한 구조화 오류 전달만 미검증입니다. 0.5.0의 과거 증거는 `docs/acceptance-b2-v0.5.0.json`에 보존합니다.

## 원래 VeriScope 경로: 설정 후 시작

환경을 설정한 뒤(다음 절) DSH에서 차례로 입력합니다.

1. "`veriscope_doctor`로 이 컴퓨터 환경을 점검하고 고칠 점을 알려줘."
2. "VeriScope로 `D:\data\evaluation-result.json`을 검사하고 통과 여부와 이유를 설명해줘."
3. "`veriscope_gate_list`로 최근 게이트 영수증과 현재 유효성을 나열해줘."

다음도 사용할 수 있습니다.

> 지난 게이트 결과가 지금도 유효한지 확인해줘.

진단의 "환경 준비 완료"는 환경이 사용 가능하다는 뜻일 뿐이며, 게이트 통과에는 실제 리플레이가 필요합니다. 채팅이 도구를 자동 선택하는지는 DSH 모델 설정에 달려 있습니다. 필요하면 도구 이름을 직접 쓰십시오.

자주 쓰는 세 장면:

- **관리자에게 보내기**: "이번 실패를 공유 가능한 요약으로 만들어줘." `format: "share"`가 로컬 Markdown을 생성합니다. 먼저 검토한 뒤 직접 공유하십시오. 영수증이 아닙니다.
- **아카이브가 열리지 않음**: 확인 가능한 범위에서 이상 행·열이나 필드 위치를 알려 줍니다. 파일은 수정하지 않습니다.
- **어제는 통과, 오늘은 재확인 필요**: 확인된 임계값·버전·입력 다이제스트 변화를 나열하고, 확인할 수 없는 범위는 미확인으로 남깁니다.

작업 완료 조건에 게이트 검사를 연결하려면 이번 검사를 작업에 바인딩합니다. 연결된 영수증이 현재 유효하고 PASS일 때만 완료를 등록할 수 있습니다.

**사용 전에 VeriScope와 Python 경로를 설정하십시오. 새 평가 모델 호출은 발생하지 않습니다.**

## 설치와 설정

이 문서는 **0.6.0 로컬 후보**에 해당하며 DSH 플러그인과 독립적인 `veriscope-mcp` 진입점을 제공합니다. 사용 가능한 배포 버전은 [npm 패키지 페이지](https://www.npmjs.com/package/dsh-plugin-veriscope)에서 확인하십시오. MCP 설정과 검증 대기 범위는 아래에 안내합니다. 검증된 DSH CLI에서는 프로필을 명시합니다. 아래는 전용 `veriscope-demo`를 사용합니다.

```powershell
# 설치
dsh plugin --profile veriscope-demo add dsh-plugin-veriscope
# 설치된 버전 확인
dsh plugin --profile veriscope-demo list dsh-plugin-veriscope --depth 0
# 제거
dsh plugin --profile veriscope-demo remove dsh-plugin-veriscope
```

로컬 개발이나 사용자 정의를 위해서는 로컬 디렉터리에서 대신 설치할 수 있습니다.

```powershell
dsh plugin --profile veriscope-demo add 'D:\your-workspace\dsh-plugin-veriscope'
```

경로는 실제 소스 위치로 바꾸십시오. 디렉터리나 link 설치를 registry 설치의 증거로 삼지 마십시오. **설치 성공은 게이트 통과가 아닙니다.** 기존 replay의 첫 사용에는 `VERISCOPE_ROOT`와 `VERISCOPE_PYTHON` 설정과 진단이 필요합니다. B2만 사용하면 상태 루트만 설정합니다. npm 패키지에는 테스트가 없습니다. `docs/B2.md`, Schema 및 B2 예제는 포함되며 나머지 문서는 저장소에 있습니다. `npm test`는 소스 개발용이고, `node scripts/verify-replay.mjs`도 전체 소스 저장소와 검증 자료가 있을 때만 동작하며 설치 후 기능이 아닙니다. 자세한 문서는 저장소를 참조하십시오.

0.3.x의 과거 검증 환경: Windows, DSH NEXT 2.0.18-next, 내부 DSH／tools／skill **0.2.1-alpha.2**. Node ≥22.19. 다른 호스트 버전은 미검증입니다. 상위 및 Python／pandas 호환도 필요하며 고정 의존성은 [상위 설명](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/UPSTREAM.md)에 있습니다. 이 플러그인은 상위 전체나 업무 아카이브를 동봉하지 않습니다.

DSH 진입점은 `@deepseek-ai/dsh-tools`의 `0.2.1-alpha.2`를 요구하며 SDK 코드를 불러오기 전에 버전을, 불러온 뒤에는 `defineTool`을 확인합니다. 미설치·비호환·로드 실패는 각각 `SDK_MISSING`, `SDK_INCOMPATIBLE`, `SDK_LOAD_FAILED`로 보고하고 SDK를 자동 설치하거나 전환하지 않습니다. 이 검사는 호스트 검증을 대신하지 않습니다. MCP는 DSH SDK를 불러오지 않습니다.

### 설정 항목

**설정 UI가 없고 `.env`도 자동으로 읽지 않습니다.** 경로는 호스트 프로세스 환경 변수만 참조하며, cordis patch는 `completionMode`만 받습니다. 호스트의 환경 로딩 정책은 호스트의 몫입니다.

| 설정 | 진입점 | 기본값과 요구 사항 |
|---|---|---|
| `veriscopeRoot` | `VERISCOPE_ROOT` | Windows 기본값 `D:\RAG_Evaluation_Demo`. POSIX에서는 명시 설정 필수 |
| `pythonPath` | `VERISCOPE_PYTHON` | `.venv`／`venv`를 차례로 탐색. Windows는 `Scripts/python.exe`, POSIX는 `bin/python`. PATH로 대체하지 않음 |
| 상태 루트 | `VERISCOPE_STATE_DIR` | 기존 DSH replay 기본값 `<플러그인>/.local`. B2와 모든 MCP 도구는 영구 디렉터리 명시 필수 |
| 알림 모드 | cordis patch `completionMode` | `off`. `off` 또는 `remind`만 허용, 그 외는 오류 |

세 환경 변수의 명시 값은 비어 있지 않은 절대 경로여야 하며, 잘못된 값이 조용히 대체되지 않습니다. **DSH를 시작하는 같은 터미널**에서 설정한 뒤 시작하거나 완전히 재시작하십시오. 아래 마지막 줄은 위의 npm 설치 대신 GitHub에서 설치할 때 사용하는 명령입니다. 이미 설치했다면 실행할 필요가 없습니다.

```powershell
$env:VERISCOPE_ROOT = 'D:\your-workspace\VeriScope'
$env:VERISCOPE_PYTHON = 'D:\your-workspace\VeriScope\venv\Scripts\python.exe'
$env:VERISCOPE_STATE_DIR = 'D:\your-data\veriscope-state'
dsh plugin --profile veriscope-demo add github:4444wjt/dsh-plugin-veriscope
```

전용 프로필과 해당 호스트 CLI를 먼저 준비하십시오. 설치 명령은 완전한 호스트 설정을 만들지 않습니다. 플러그인 bundle이 기본 항목을 삽입하므로 `<DSH_HOME>/profiles/<이름>/cordis.patch.yml`에서 기존 `id`를 덮어쓰고 다시 `insert`하지 마십시오.

```yaml
- id: dsh-plugin-veriscope
  config:
    completionMode: "remind"
```

`off`는 턴 종료 알림을 끄며 모든 도구는 계속 사용할 수 있습니다. `remind`는 미완료 연결 작업만 알리며 일반 채팅의 전면 차단을 약속하지 않습니다. 경로는 이 config에 쓸 수 없습니다.

## 여러 호스트용 MCP

MCP는 계속 다섯 도구를 제공합니다. V2 정책도 기존 check／status／list를 사용합니다. 0.5.0의 과거 증거와 미검증 범위는 `docs/acceptance-b2-v0.5.0.json`을 참조하며 본 후보 검증과 구분합니다. 다음은 0.4.0의 과거 검증입니다.

0.4.0에서는 격리된 Claude Code／Codex 호스트 제어 인터페이스에서 실제 도구 호출을 검증했으며 모델 대화는 하지 않았습니다. Windows와 Ubuntu의 실제 리플레이도 통과했습니다. Claude 제어 API의 오류 경로는 텍스트만 반환하므로 완전한 구조화 오류 전달은 미검증입니다. 절대 Node 경로로 소스 `mcp.js`를 실행합니다. 설정과 격리 환경 예시는 [MCP 연결 안내](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/MCP.md)를 보십시오. DSH SDK를 불러오지 않습니다. 첫 MCP 버전은 `veriscope_doctor`, `veriscope_gate_replay`, `veriscope_gate_status`, `veriscope_gate_list` 네 도구만 제공하며 네이티브 카드는 없습니다. batch／export와 bind／complete는 DSH 전용입니다. 세션 바인딩은 이식하지 않으며 MCP 보고서의 `execution.session_id`는 `null`입니다.

현재 MCP 다섯 도구 모두 유효한 `VERISCOPE_STATE_DIR`의 명시 설정이 필수입니다. 없으면 재확인 필요를 반환하고 패키지 디렉터리로 대체하지 않습니다. doctor는 임시 프로브를 쓰고 지우며 replay는 보고서와 영수증을 쓰므로 두 도구 및 새 check는 읽기 전용이 아닙니다. status／list는 읽기 전용입니다. 업무 판정 FAIL은 도구 실행 오류와 다릅니다. 실제 호스트 도구 호출, Linux 실리플레이, 이 버전의 검증 상태는 [검증 기록](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/acceptance-mcp-v0.4.0.json)에 구분하여 남깁니다. 등록 성공이나 자체 클라이언트의 성공만으로 호스트 검증을 대체할 수 없습니다.

## 아홉 개의 도구

| 도구 | 용도 |
|---|---|
| `veriscope_gate_check({archive_path, policy_path, format?})` | 기존 행 점수에 대한 Node 독립 임계값 판정. Python 없이 ReceiptV2 생성 |
| `veriscope_doctor({engine?})` | 기본값은 기존 replay 환경 진단. `engine:"builtin"`은 Node와 명시적 상태 루트만 확인하고 수정 제안 반환 |
| `veriscope_gate_replay({result_path, baseline?, faith?, ctx?})` | 기존 아카이브로 게이트를 실제 실행하고 독립 기록을 저장하며, 조건 충족 시 ReceiptV1 생성 |
| `veriscope_gate_status({run_id, faith?, ctx?, baseline_run_id?})` | 영수증의 현재 유효성을 읽기 전용으로 확인. 리플레이·채점·새 영수증 없음 |
| `veriscope_gate_list({limit?})` | 기본 최근 50건(1–200). 항목별로 status를 재사용하고 손상 기록은 따로 표시 |
| `veriscope_gate_batch({paths?, dir?, baseline?, faith?, ctx?})` | 경로 배열 또는 디렉터리 중 하나. 순차 리플레이, 최대 200건, 취소 가능, 건별 기록 |
| `veriscope_gate_export({run_id?, run_ids?, format})` | 1–50건을 상태 루트 `exports/`에 내보냄. `share`는 허용 목록 요약, `md`는 전체 보고서, `json`은 원본 영수증. 덮어쓰지 않음 |
| `veriscope_gate_bind({task_id, run_id, faith?, ctx?, baseline_run_id?})` | 호스트가 제공하는 이 세션 안에서 관리 작업과 현재 영수증을 연결 |
| `veriscope_gate_complete({task_id, run_id})` | 세션 연결을 재확인하고 현재 유효한 PASS에서만 완료를 등록 |

### 매개변수와 규칙

- 기존 replay 임계값은 기본 0.8이며 0–1의 유한값이어야 하고, PASS를 얻기 위해 자동으로 낮추지 않습니다.
- 아카이브 상대 경로는 `VERISCOPE_ROOT` 기준입니다.
- `baseline_run_id`는 생략하면 원래 기준선 유지, `null`은 기준선 없음, UUID는 현재 상태 루트의 유효한 영수증을 참조합니다.
- `task_id`는 영문·숫자·밑줄·점·하이픈 1–80자이며, 세션 식별자는 도구 인수로 위조할 수 없습니다. 연결은 메모리에만 있고 재시작 후 다시 연결해야 하며, 디스크의 완료 기록이 권한을 복원하지 않습니다.

"유효성 확인"은 status, "게이트 재실행"은 replay입니다. ReceiptV1은 실제 replay, ReceiptV2는 실제 B2 check만 생성합니다. 입력·기준선·정책·상위·플러그인·환경이 바뀌면 기존 영수증은 재확인 필요가 되고 과거 실패는 보존됩니다. 자세한 내용은 [영수증 프로토콜](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/RECEIPTS.md).

0.4.0은 기존 감사 계약 또는 공개 커밋 `1b89bcabb83e1b123039799516596fdcfd393d42`에서 감사한 LF 계약 중 하나를 받습니다. 계약 전체가 원래 바이트와 일치해야 하며 파일별 혼합이나 실행 시 정규화는 하지 않습니다. MCP 진입점, 공유 도구 목록, 계약 선택 코드도 영수증 해시에 포함됩니다. 업그레이드 후 기존 영수증의 현재 유효성은 REVIEW가 되지만 과거 기록은 유지됩니다.

### 입력과 출력 예시

```text
veriscope_doctor({})
-> {status:"READY", ready:true, summary:"环境就绪", items:[…]}
veriscope_gate_list({limit:10})
-> {items:[{run_id:…, historical_verdict:"PASS", current_verdict:"REVIEW", …}], damaged:[…]}
veriscope_gate_batch({paths:["a.json","b.json","broken.json"]})
-> {status:"FAIL", counts:{pass:1, fail:1, review:0, error:1}, …}
veriscope_gate_export({run_id:"실제 실행 UUID", format:"md"})
-> {exported:true, path:"<상태 루트>/exports/<고유 파일명>.md", …}
veriscope_gate_export({run_id:"실제 실행 UUID", format:"share"})
-> {exported:true, share_summary:{schema_version:"GateShareSummaryV1", is_receipt:false, …}, …}
```

위는 필드 예시이며 실측 업무 결과가 아닙니다. 배치는 **FAIL이 하나라도 있으면 FAIL로 집계**하고, FAIL이 없어도 재확인 필요·오류·취소·미처리가 있으면 REVIEW입니다. 디렉터리는 바로 아래 JSON만 읽고 재귀하지 않습니다. 오류가 확정된 실패를 덮지 않으며, 실패가 다음 리플레이를 막지도 않습니다.

### 목록·배치·내보내기

목록은 최대 10,000개 디렉터리 항목을 스캔하고 초과 시 재확인 필요를 명시합니다. `limit` 범위를 벗어난 영수증은 현재 환경에서 재확인하지 않습니다. 손상 영수증의 시각을 신뢰할 수 없으면 디렉터리 수정 시각으로 정렬하고 그 사실을 표시합니다. 단일 JSON 내보내기는 원본 영수증과 바이트 단위로 같고, 여러 건은 원본 영수증 객체 배열입니다. JSON 안의 과거 PASS는 현재 유효를 뜻하지 않으며 현재 상태는 반환값의 `current`를 보십시오. Markdown은 과거와 현재 상태, 아카이브 지표, 임계값, 근거 건수, 제한을 함께 적습니다. 진단은 자체 임시 프로브만 만들고 지우며, 설정 변경이나 의존성 설치를 하지 않습니다.

`share`는 별도 Markdown을 만들며 고정 상태, 알려진 사유, 제한된 지표와 임계값, 건수, 엄격한 버전 번호만 담습니다. 경로, 원문, 로그, 모델 이름, 시각, 해시, 알 수 없는 필드는 제외하고 실행 번호는 "기록1" 같은 별칭으로 바꿉니다. 공유할 것은 **파일 본문 또는 `share_summary`** 입니다. 도구 반환값 전체에는 로컬 파일 위치가 포함됩니다. 수치와 버전도 민감할 수 있으니 먼저 검토하십시오. 요약은 status／bind／complete에 쓸 수 없고, 사실 정확성을 증명하지 않으며, 모든 비밀 탐지를 보장하지 않습니다.

### 이상 위치와 변화 설명

JSON이 거부되면 `execution.errors[].diagnostic`이 확인 가능한 발견 지점을 제공합니다. 행과 열은 1부터 시작하고 디코딩된 UTF-16 단위로 세며, CRLF는 한 번의 줄바꿈으로 봅니다. 제한된 필드 경로를 안전하게 특정할 수 없으면 `null`이며 원문을 되돌려 주지 않습니다. 위치가 유일한 변경 지점은 아니며, 자동 수정이나 추가 재시도를 하지 않습니다.

status의 `changes`는 원본 영수증과 이번에 캡처한 고정 연결 항목의 차이만 설명하고 최대 20개까지 표시하며 잘림을 밝힙니다. `COMPLETE`는 나열된 범위를 확인했다는 뜻일 뿐이며 변화가 없다고 사실 정확성을 뜻하지 않습니다. `UNVERIFIED`는 일부 또는 전부를 확인하지 못했다는 뜻이고 확인된 변화는 계속 나열됩니다. 계약 검사 실패는 원래 거부 경로를 유지하고 나머지는 미확인으로 둡니다. 검사를 우회해 비교를 조작하지 않고, 그것으로 점수 변화를 귀속시키지도 않습니다.

## 네이티브 결과 카드（기존 DSH replay）

B2 status는 같은 영역에 중국어 텍스트를 표시하며 기존 Python 필드나 새로고침 버튼을 사용하지 않습니다.

`tool.call.toolview`를 지원하는 호스트는 어두운 배경에 금색 포인트의 중국어 결과 카드를 표시합니다. 현재의 세 가지 판정 상태, 다음 단계, "다시 확인" 버튼, 접히는 근거입니다. 버튼은 상태를 읽기만 하고 리플레이하거나 완료를 등록할 수 없습니다. 카드 인터페이스가 없으면 중국어 도구 텍스트를 유지합니다.

접히는 근거에는 중국어 사유, 영수증 임계값, Node／Python／pandas 버전, 입력 경로, 바이트 수, SHA-256 앞 12자리가 들어갑니다. 빠진 값은 알 수 없음으로 남습니다. 이는 영수증이 연결한 과거 환경 서술이며 현재 유효성은 이번 확인에 따릅니다.

이 영역에는 연결 항목의 변화와 미확인 안내도 표시됩니다. 원래 리플레이에 확인 가능한 아카이브 이상 위치가 있으면 함께 보여 주고 과거 진단으로 표시합니다. 버전 정보는 게이트 실행 환경이며 원래 모델 평가 환경을 대신하지 않습니다.

카드는 열 때마다 같은 명시적 임계값／기준선 정책으로 다시 확인하고 과거 PASS를 그대로 보여 주지 않습니다. 로딩 실패, 정책 무효, 이 세션 연결 부재, 프로토콜 불완전은 모두 재확인 필요입니다. 표시는 그 확인 시점만 뜻하며 파일을 계속 감시하지 않습니다. 사용 전에 다시 확인할 수 있습니다. 네이티브 카드에는 경로 설정 패널이 없습니다.

## 기존 replay: 세 가지 상태와 판정 규칙

플러그인은 기존 평가 결과를 읽고 게이트를 실행해 통과(PASS), 실패(FAIL), 재확인 필요(REVIEW) 중 하나를 반환합니다.

| 현재 상태 | `gate_passed` | 의미 |
|---|---|---|
| PASS | `true` | Python 통과, 영수증 완전, 이번 확인 연결 항목 불변 |
| FAIL | `false` | Python이 명시적으로 차단, 영수증 완전, 현재 연결 항목 불변 |
| REVIEW | `null` | 입력·의존성·영수증·실행 불완전, 연결 항목 변화, 또는 프로토콜 충돌 |

replay가 FAIL을 확정한 뒤 영수증 쓰기에 실패해도 핵심 FAIL은 보존됩니다. 이후 status는 완전한 영수증이 없어 재확인 필요가 됩니다. 원래 report의 FAIL 기록은 읽을 수 있고 검증할 수 없는 과거 필드는 unknown으로 남습니다. Python이 1로 종료해도 traceback뿐이면 REVIEW입니다.

## 출력과 데이터 경계

기존 replay 기록은 `<상태 루트>/runs/<run_id>/`에 `report.json`, stdout, stderr, 조건을 갖춘 경우 `receipt.json`으로 저장됩니다. 완료 등록은 `completions/`에 따로 저장합니다. B2는 report, 원본 입력, 정책, 정규화 데이터와 ReceiptV2를 저장하고 stdout／stderr를 만들어 내지 않습니다. 추가 기록은 실패를 덮지 않습니다. 로그에는 아카이브 일부와 로컬 경로가 들어갈 수 있으니 공유 전에 가리십시오. 플러그인은 아카이브를 업로드하지 않고 전체 환경을 출력하지 않습니다.

모든 기록은 기본적으로 무기한 보존하며 자동 정리는 없습니다. `VERISCOPE_STATE_DIR`를 명시한 뒤 `node scripts/prune.mjs --dry-run --json`을 실행하면 파일 목록, 논리 바이트 수, 기록된 연관만 읽기 전용으로 표시합니다. 연관의 정확성을 검증하지 않으며 삭제 기능도 없습니다. 제거나 재설치에 대비해 상태는 플러그인 디렉터리 밖에 보관하십시오.

입력은 10MiB, stdout／stderr는 각 2MiB, 리플레이는 120초, 환경 진단은 매번 10초로 제한됩니다. ReceiptV1 status는 파일을 읽고 해시하며 Python을 띄워 버전과 pandas 메타데이터를 읽지만, 평가 모델이나 게이트 스크립트는 실행하지 않습니다. 해시는 의미적 정확성을 증명하지 않으며 상태 루트 전체를 다시 쓸 수 있는 사용자는 대상이 아닙니다. 확인 이후의 변화는 다시 확인해야만 발견됩니다.

과거 Trace는 글자 그대로의 출처만 대조하고 `historical_ai`로 표시합니다. 새로운 의미 검사가 아닙니다. 핵심은 새 평가 모델 호출이 0이며, 호스트 대화에는 여전히 토큰 비용이 들 수 있습니다. 알고리즘 독창성이나 엔드투엔드 비용 절감을 주장하지 않습니다.

## 검증과 유지보수

```powershell
node --test
node scripts/replay.mjs --result 'D:\your-data\evaluation.json' --json
dsh plugin --profile veriscope-demo remove dsh-plugin-veriscope
```

단위 테스트는 구성한 아카이브와 프로토콜 스텁을 쓰며 모델도 Python도 필요로 하지 않습니다. 실제 Python과 호스트 검증은 [검증 노트](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/verification.md)를 보십시오. 제거하면 등록이 사라집니다. 플러그인은 외부 상태 루트를 삭제하지 않지만 패키지 내부의 기본 상태는 제거나 재설치로 잃을 수 있으니 먼저 백업하십시오. 소스에서 배포하려면 `VERISCOPE_RELEASE=1`을 명시하고 버전／tag 가드를 통과해야 합니다. 자세한 내용은 기여 안내를 보십시오.

## 기여와 라이선스

[기여 안내](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/CONTRIBUTING.md) · [거버넌스](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/GOVERNANCE.md) · [변경 기록](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/CHANGELOG.md) · [로드맵](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/ROADMAP.md) · [보안](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/SECURITY.md) · [릴리스 점검](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/RELEASE_CHECKLIST.md). 마켓 PR이 병합되기 전에는 등재되었다고 말하지 않습니다.

MIT이며 스캐폴드 원저작자 표기를 유지합니다. 출처는 [제3자 고지](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/THIRD_PARTY_NOTICES.md)와 [출처 해시](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/provenance.json)를 보십시오. 상위는 별도 배포이며 자체 라이선스를 따릅니다.
