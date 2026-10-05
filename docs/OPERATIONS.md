# Global Classroom 운영 권한

이 문서는 `skerishKang/global-classroom`의 제품 개발·이슈·배포 운영 기준입니다.

## Source of truth

```text
PRODUCT = Global Classroom / AI Interview Interpreter
CANONICAL_SOURCE_REPOSITORY = skerishKang/global-classroom
PRODUCT_ISSUE_TRACKER = skerishKang/global-classroom/issues
PRODUCTION_HOST = Netlify
CURRENT_SOURCE_MIGRATION = NO
CURRENT_BI_NUMBER_ASSIGNMENT = NO
```

Global Classroom의 코드, UI/UX, Interview runtime, Netlify Functions, 제품별 테스트와 제품별 운영 이슈는 이 저장소가 권한을 가집니다.

`skerishKang/ai-revenue-lab`에는 Global Classroom 제품 이슈를 중복 생성하지 않습니다. Padiem 공용 플랫폼과 연결되는 작업은 해당 중앙 이슈를 cross-reference할 수 있지만, Global Classroom 제품 구현 이슈의 원본은 이 저장소에 둡니다.

## 현재 이슈 상태

```text
ACTIVE_PRODUCT_ISSUES=0
OPEN_DEFERRED_ISSUE=#20
```

- #20 — **DEFERRED / FUTURE**. 현재 Firebase Auth, Firestore live sharing, Google OAuth/Drive/Docs/Classroom 경로를 유지합니다. 실제 cross-product account/SSO 필요가 생길 때만 재검토합니다.
- #21~#24 — Interview 초기 UX/runtime tracker와 child issues 완료.
- #53 — final voice translation guarantee 완료.
- #58/#59 — normal voice resilience와 Interview empty-state visual 완료.
- #62 — technical interview answer assist + on-demand answer translation 완료.
- #63 — 새 utterance의 opposite translation 자동 선택 완료.
- #66 — 완료. Drive/Docs/Classroom export의 blocking alert를 actionable result surface로 교체하고 Drive/Docs destination link를 명확히 노출.

새 제품 작업은 stale tracker 순서가 아니라 **현재 Production 증거, 사용자 문제 또는 owner의 명시적 제품 요구**에서 focused issue를 새로 만든 뒤 진행합니다. 완료된 이슈를 진행 중인 roadmap처럼 재사용하지 않습니다.

## Padiem shared-platform boundary

Global Classroom은 저장소와 제품 authority를 유지합니다. Padiem 공용 identity/Control Plane/Google connector 연계는 기술적으로 가능한 미래 선택지이지만 **현재 migration 대상이 아닙니다**. 단순한 아키텍처 통일을 위해 작동 중인 Firebase/Google Workspace 경로를 교체하지 않습니다.

구체적인 cross-product 로그인, 반복 OAuth, entitlement 또는 유지비 문제가 실제로 발생하면 #20을 fresh-read하고 그 시점의 Padiem 공용 기능을 다시 검증한 뒤 가장 작은 연계 범위를 결정합니다.

다음은 계속 금지합니다.

```text
SECOND_PADIEM_IDENTITY_AUTHORITY=NO
SECOND_GOOGLE_CONNECTOR_AUTHORITY=NO
DIRECT_B62_COOKIE_REUSE_AS_PRODUCT_AUTHORITY=NO
RAW_GOOGLE_TOKEN_IN_BROWSER_AS_SHARED_AUTHORITY=NO
SOURCE_COPY_INTO_AI_REVENUE_LAB=NO
DUPLICATE_PRODUCT_ISSUES_IN_AI_REVENUE_LAB=NO
```

Padiem Chat/Claw의 공용 계정·connector 구현과 Global Classroom 제품 코드는 서로 다른 source authority를 유지합니다.

## Google Workspace

현재 제품의 기존 Google OAuth 및 Drive/Docs/Classroom integration은 동작 중인 제품 기능이며 그대로 유지합니다. Padiem shared Google connector로의 전환은 현재 목표나 일정이 아니라 #20에 보류된 미래 선택지입니다.

향후 실제 전환 필요가 생길 경우 원칙:

- Padiem account identity와 Google Workspace grant를 구분합니다.
- Drive/Docs/Classroom 권한은 connector capability입니다.
- shared connector가 준비되기 전까지 기존 기능을 임의 제거하지 않습니다.
- 새 Global Classroom 전용 공용-token authority를 추가하지 않습니다.
- Production cutover는 별도 이슈와 E2E 증거를 요구합니다.

## Git / PR 운영

제품 변경은 기본적으로:

```text
fresh main
 -> focused branch
 -> implementation
 -> diff check
 -> lint/type check
 -> production build
 -> focused E2E/regression
 -> PR
 -> exact-head review
 -> merge
 -> Netlify exact-commit verification
 -> production smoke
```

으로 진행합니다.

새 head에서는 이전 PASS를 자동 carry-over하지 않습니다.

## Production / Netlify

현재 Production은 Git-connected Netlify 배포를 사용합니다.

```text
main merge
 -> Netlify automatic build/deploy
 -> production deploy commit_ref must equal merged main
 -> production smoke
```

수동 deploy는 자동 배포 실패 또는 별도 승인 시에만 사용합니다.

Production 완료 보고에는 최소한 다음을 확인합니다.

- merged main SHA
- Netlify deploy state
- Netlify `commit_ref`
- production context
- 핵심 UI/API smoke

`READY`만 보고 배포 성공으로 판단하지 않고 exact commit을 확인합니다.

## Secrets / credentials

다음을 GitHub issue, PR, source, terminal report에 출력하지 않습니다.

- API secret
- OAuth client secret
- refresh/access token
- password
- service credential
- private user/company identifiers

공개 가능한 식별자와 비밀값을 구분합니다.

## Repository migration

현재 owner 결정은 **저장소 유지**입니다.

Global Classroom이 거의 완성 단계이므로 지금 `ai-revenue-lab/apps/**`로 source migration하지 않습니다.

향후 migration이 필요할 경우에만 별도 이슈에서 다음을 먼저 결정합니다.

- canonical source revision
- Git history preservation
- CI/build path
- Netlify source cutover
- auth/connector boundary
- old repository role
- rollback

그 전까지:

```text
CANONICAL_SOURCE = skerishKang/global-classroom
AI_REVENUE_LAB_INTERNAL_COPY = NO
```

## BI / Portfolio

현재 Global Classroom은 AI Revenue Lab의 numbered Business로 확정하지 않았습니다.

향후 번호를 부여하더라도 번호는 portfolio identity일 뿐 source migration을 자동 의미하지 않습니다. 별도 저장소를 canonical source로 유지한 채 번호만 부여할 수도 있습니다.

Business 번호 부여는 AI Revenue Lab의 정식 registry 절차를 따릅니다.
