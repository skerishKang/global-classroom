# Global Classroom — CI 게이트 운영 기준

> **기준 시점:** 2026-10-12 · 이슈 [#98](https://github.com/skerishKang/global-classroom/issues/98)
> **제품 저장소:** `skerishKang/global-classroom` · **워크플로:** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)

## 1. 언제 실행되나

| 트리거 | 대상 리비전 |
| --- | --- |
| `pull_request` → `main` | 병합될 **정확한 PR HEAD** |
| `push` → `main` | 병합된 main |

같은 ref에서 새 실행이 시작되면 이전 실행은 `concurrency` 설정으로 취소된다. 이전 head의 PASS는 새 head로 carry-over되지 않는다.

## 2. 필수 검사 (단일 job `verify`)

```text
npm ci             lockfile 기준 의존성 설치
npm run lint       tsc --noEmit
npm run test:unit  vitest run (전체 단위 테스트)
npm run build      vite build + postbuild
```

- Node 22 (`actions/setup-node`, Netlify 빌드 이미지 noble과 동일 메이저), npm 캐시 사용.
- `permissions: contents: read`만 부여하고 secret을 참조하지 않는다.
- **실 provider 호출이나 유료 모델 테스트를 넣지 않는다.** 키 없이 통과해야 하는 게이트다.
- job timeout 15분. 전체 실행 시간은 PR에 측정값으로 기록한다.

## 3. 실패했을 때 확인할 위치

1. PR의 Checks 목록 → `verify`에서 실패한 단계
2. `gh run list --limit 5` / `gh run view <run-id> --log-failed`
3. 로컬 재현: `npm ci && npm run lint && npm run test:unit && npm run build`

게이트가 실패하면 병합하지 않는다. 통과시키기 위해 기존 단언을 삭제하거나 약화하지 않는다.

## 4. 이 게이트가 지키는 회귀 계약

- #87 Live 전사 턴 확정·VAD·STT 폴백 경계
- #96 번역·추천답변 모델 순서 (Gemma 4가 제거된 5개 풀)
- #97 감지 후보(flash-lite 2개), 404/오류 폴백, 잘못된 `en` 성공 금지

## 5. E2E는 필수 게이트가 아니다 (선택 검증)

`npm run test:e2e`는 브라우저와 함수 서버가 필요하다(vite 프록시가 `localhost:8888/.netlify/functions`를 요구). 자동 게이트에 넣지 않고 필요할 때만 수동 실행한다.

```bash
npx netlify dev --port 8888 --target-port 5180 --functions netlify/functions
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5180 npx playwright test tests/e2e/<spec>.ts --project=chromium
```

알려진 기존 실패: `tests/e2e/interview.spec.ts`의 3개 테스트(4:3, 13:3, 75:3)는 **배포된 Production 코드에서도 동일하게 실패**한다. 이 게이트와 무관하며 별도 이슈 대상이다.

## 6. 병합 조건

```text
PR HEAD의 verify PASS + exact head 확인
→ 병합
→ Netlify Git-connected 자동 배포
→ deploy commit_ref == merged main
→ Production smoke
```

required check 등록 여부는 저장소 설정 상태를 따른다. **`verify`가 required로 등록되지 않았다면 원격은 검사만 실행하고 병합을 차단하지 않는다** — 그 상태를 병합 차단 성공으로 보고하지 않는다.

## 7. Netlify와의 관계

Netlify는 `main` 병합 시 자동 빌드/배포한다(`netlify.toml`: `npm run build`, publish `dist`). CI는 병합 **전** 게이트이고 Netlify는 병합 **후** 배포이므로, CI 통과는 배포 완료를 의미하지 않는다.
