# Global Classroom — PADIEM 로그인·등급·com2 이전 설계

```text
DOC_ROLE=DESIGN_ONLY
STATUS=설계안 (구현·배포 없음)
DATE=2026-11-05
OWNER_DECISION=로그인 없는 무료 사용 제거 / PADIEM 계정 로그인 / 등급 Free·Plus·Pro·Max / BYOK / 서버 함수 컴2 이전
REPLACES=#119·#121의 키 정책(개인 키 > 반 키 > 공용 맛보기 30·10회)
```

이 문서는 코드를 바꾸지 않는다. 현행 구조를 근거와 함께 적고, 목표 구조·단계·위험·대표 결정 대기 항목만 정리한다.
근거는 2026-11-05 `main`(`2b5415a`) 소스와 `netlify/functions/**`, `hooks/**`, `utils/**` 직접 확인이다. 모델·라우트 기준은 [`docs/MODEL_ROUTES.md`](../MODEL_ROUTES.md), 운영 권한은 [`docs/OPERATIONS.md`](../OPERATIONS.md)를 따른다.

---

## 1. 지금 구조 (AS-IS)

### 1.1 화면이 서버 함수를 부르는 곳

배포는 Netlify Git 연동 자동 배포다(`main` 병합 → Netlify 빌드·배포). `netlify.toml`이 화면(`dist`)과 함수를 함께 맡고, `/api/*`를 `/.netlify/functions/:splat`으로 200 리다이렉트한다.

```text
netlify.toml
  build.command = npm run build
  publish       = dist
  functions     = netlify/functions
  [[redirects]] /api/* -> /.netlify/functions/:splat  (200)
```

실제 엔드포인트는 **11개**다. 대표 요약의 8개(live-token·translate·interview-answer·summarize·session-metadata·tts·vision·transcribe)에 `detect-language`(#85), `transcribe-accounts`, `transcribe-file`이 더 있다. 공용 헬퍼 5개(`_aiGuards`, `_rateLimit`, `_providerBudget`, `_translationBudget`, `_transcribeAccounts`)를 포함해 `netlify/functions` 파일은 16개다.

| 엔드포인트 | 화면 호출부 | 쓰는 키 | 지연 민감도 | 현행 버스트/분 한도 |
| --- | --- | --- | --- | --- |
| `/api/translate` | `hooks/useTranslationService.ts` `postApi`(단일 관로) | `x-user-api-key` → `GEMINI_API_KEY`/`API_KEY`, `GROQ_API_KEY` | **높음** (면접 확정 번역) | 30 / 30 |
| `/api/interview-answer` | `utils/interviewAnswer.ts` → `postApi` | 위와 같음 | **높음** (추천 답변) | 15 / 15 |
| `/api/detect-language` | `hooks/useInterviewLive.ts`, `useTranslationService` | Google 키 | 중간 | (범위 밖, IP 보조) |
| `/api/live-token` | `hooks/useInterviewLive.ts:124`, `hooks/useTranscribeRecorder.ts:45` | 계정별 `GEMINI_API_KEY_ACCOUNT_1/2`, `x-user-api-key`, 공용 키 | 중간 (세션당 1회) | 40 / 40 |
| `/api/tts` | `utils/tts.ts:87`, `hooks/useAudioPlayer.ts:127` | `x-user-api-key` → 공용 키 | 낮음 (재생) | 40 / 40 |
| `/api/vision` | `hooks/useVision.ts:63` | `x-user-api-key` → 공용 키, `GROQ_API_KEY` | 낮음 (수동 촬영) | 12 / 8 |
| `/api/summarize` | `App.tsx` 요약 경로 | 공용 키, `GROQ_API_KEY` | 낮음 | 5 / 3 |
| `/api/session-metadata` | `hooks/useSessionMetadata.ts` | 공용 키, `GROQ_API_KEY` | 낮음 (백그라운드) | 15 / 12 |
| `/api/transcribe` | `useInterviewLive.ts:445` (폴백 STT) | `GROQ_API_KEY` | 중간 | 12 / 8 |
| `/api/transcribe-accounts` | `components/TranscribePage.tsx:72` | 서버 키 존재 여부만 반환 | 낮음 | — |
| `/api/transcribe-file` | `components/TranscribePage.tsx:130` | 계정별 Google 키 | 낮음 (파일 업로드) | 12 / 8 |

`components/AdminPanelModal.tsx:39`는 위 엔드포인트를 진단용으로 직접 호출한다.

### 1.2 키·사용량·사용자 데이터의 자리

**공용 키(서버)** — Netlify 사이트 환경변수에만 있다. 함수가 `process.env`/`Netlify.env`로 읽는다.

```text
GEMINI_API_KEY / API_KEY            공용 기본 키
GEMINI_API_KEY_ACCOUNT_1            Transcribe 계정 1 (없으면 위 기본 키)
GEMINI_API_KEY_ACCOUNT_2            Transcribe 계정 2 (없으면 비활성)
GROQ_API_KEY                        translate·interview-answer·vision·summarize·transcribe 폴백
```

**사용자 키(브라우저)** — `utils/apiKey.ts` 한 곳에서만 결정한다. 우선순위는 개인 키(`settings.userApiKey`) > 반 키(`padiem.classApiKey`) > 없음(공용 맛보기). 개인·반 키는 `localStorage`에만 있고 `x-user-api-key` 머리글로만 이동하며, 서버는 원문을 저장하지 않는다(#32 계약). 키가 없는 호출만 `x-device-id`(`padiem.deviceId`)·`x-trial-session`(`padiem.trialSession`)을 붙인다.

**사용량** — 두 층이다.

- 버스트·분당: `_rateLimit.ts`의 토큰 버킷 + 고정 창. **함수 인스턴스 메모리**라 인스턴스 수만큼 한도가 늘어난다. 식별은 IP(`x-nf-client-connection-ip` 우선), 기기 번호가 있으면 기기 버킷. 식별 불가 요청은 `unknown` 하나로 묶어 fail-closed.
- 맛보기 누적: `Netlify Blobs` 스토어 `padiem-trial-usage`에 기기 번호 SHA-256 해시 키로 `{count, last}`만 저장. Blobs를 못 쓰면 메모리로 폴백(재시작 시 초기화). 기기 누적 30회·세션 10회는 `_rateLimit.ts` 상수다. `#121`이 `x-trial-remaining`·`x-trial-store`와 로그 한 줄로 관찰 수단을 붙였다.

**사용자 데이터** — Firebase 프로젝트 `global-classroom-b4322`가 인증과 실시간 공유의 저장소다. 웹 설정(apiKey 포함)은 `utils/firebase.ts`에 공개 값으로 들어 있다.

```text
Firebase Auth      익명 로그인(자동), 이메일/비밀번호 가입·로그인
Firestore          users/{uid}                       프로필
                   rooms/{roomId}/messages           라이브 공유 채팅
                   rooms/{roomId}/handRaises         손들기
                   rooms/{roomId}/webRTC/{uid}       WebRTC 신호(candidates 포함)
Google OAuth(GIS)  Drive/Docs/Classroom 스코프, 액세스 토큰은 sessionStorage
로컬               대화 히스토리 localStorage, 음성 캐시 IndexedDB
Google Drive       세션 폴더 백업(transcript/manifest/문장별 wav)
```

익명 로그인은 `hooks/useAuth.ts`가 자동으로 시도한다 — **로그인 없는 무료 사용이 지금 구조에 내장되어 있다.** `LoginModal`은 Google·이메일/비밀번호·게스트 세 갈래다.

### 1.3 음성 직접 연결

음성은 서버를 거치지 않는다. 서버는 **임시 토큰만 발급**한다.

```text
브라우저  POST /api/live-token { model }
서버      GoogleGenAI.authTokens.create({
            uses: 1, expireTime: +30분, newSessionExpireTime: +1분,
            liveConnectConstraints: { model }          // 모델 고정
          })  -> { token, expireTime }
브라우저  new GoogleGenAI({ apiKey: token }).live.connect(...)
          -> Google Live API와 직접 WebSocket (오디오는 Netlify를 지나지 않는다)
```

허용 모델은 `_aiGuards.ts`의 `ALLOWED_LIVE_MODELS` 3개로 고정되어 있다: 교실 마이크(`gemini-2.5-flash-native-audio-preview-09-2025`), 면접 전사(`gemini-3.5-transcribe-live`), 면접 번역 미리보기(`gemini-3.5-live-translate-preview`). `hooks/useInterviewLive.ts`는 발화마다 번역 세션을 새로 연결하고, 전사 세션은 주기적으로 회전한다. Live 연결이 끊기면 브라우저 SpeechRecognition/Groq Whisper 폴백으로 내려간다.

**이 구조의 핵심:** 트래픽이 가장 많은 경로(오디오)는 이미 Netlify 밖이다. 서버 이전이 음성 품질에 미치는 영향은 `live-token` 호출 한 번(세션당)뿐이다.

### 1.4 현행 설계의 한계 (설계 근거)

1. **사용량이 진짜 계정 단위가 아니다.** 기기·세션 카운터는 브라우저를 지우면 초기화되고, 버스트 한도는 인스턴스마다 따로 센다.
2. **등급 개념이 없다.** 개인/반/공용 세 갈래뿐이라 Plus·Pro·Max를 구분할 자리가 없다.
3. **개인 키가 브라우저에만 있다.** 공용 PC 교실에서 키가 남고, 서버가 사용자별로 토큰을 발급할 때 쓸 수 없다.
4. **인증이 두 개다.** Firebase(제품) + Google GIS(Drive). PADIEM 표준(padiem-auth)과 별개다.
5. **서버 함수가 Netlify에 묶여 있다.** 로그·쿼터·키 회전·등급 집행을 한 곳에서 하기 어렵다.

---

## 2. 목표 구조 (TO-BE)

### 2.0 한 장 그림

```text
                 ┌──────────────────────────────┐
                 │ auth.padiem.net (padiem-auth) │  로그인 정본 (Cloudflare)
                 │ ES256 15분 / JWKS / 1회 코드  │  컴2가 꺼져도 살아 있음
                 └──────────────┬───────────────┘
                                │ 1회 코드 교환 + 로그인 표(로컬 검증)
   브라우저 ── 로그인 ──────────┘
      │
      │  (Netlify: 화면 정적 호스팅)
      │   /api/*  ── 프록시 ──►  gc-api (컴2, Cloudflare Tunnel)
      │                              ├─ 세션 쿠키 검증 (gc_session)
      │                              ├─ 등급 읽기 (계정 등급 정본)
      │                              ├─ 사용량 계수 (com2 SQLite)
      │                              ├─ BYOK 키 조회 (AES-GCM 봉인)
      │                              └─ 공급사 호출 (Google/Groq)
      │
      └── Live 오디오 ── 직결 ──► Google Live API   (서버 경유 없음)
```

### (a) 로그인 — padiem-auth를 Chat과 같은 방식으로

`docs/standards/AUTH_STANDARD.md`(거버넌스 운영방침 22번 로그인 표준)의 5단계를 그대로 따른다. 새 인증 권위를 만들지 않는다.

```text
1. padiem-auth 허용 목록에 product 등록
   product_id      = global-classroom
   callback URI    = https://<최종 화면 origin>/auth/padiem/callback
   클라이언트 공개키(비대칭) 등록

2. 브라우저  GET /auth/padiem/start
   서버가 state·PKCE(S256) 생성 → 서버측 보관 + 쿠키 → auth.padiem.net으로 이동

3. 콜백    GET /auth/padiem/callback?code=...
   state 검증 → 서버가 code + verifier + private_key_jwt(ES256)로 교환
   (코드는 제품·정확한 callback·PKCE에 묶여 60초·1회)

4. 로그인 표 로컬 검증
   padiem-auth-verify (JS/Python 동일 계약) — issuer 고정, audience=global-classroom,
   alg 허용 목록, exp/iat, kid. 매 요청 padiem-auth에 묻지 않는다.

5. 제품 세션 발급
   canonical sub → gc_session (host-only, Secure, HttpOnly, SameSite=Lax, 15분 상당)
   refresh는 서버측 저장·회전, 브라우저·로그에 노출하지 않는다.
```

**지켜야 할 선(issue #20의 hard lock 그대로):**

```text
DIRECT_B62_COOKIE_REUSE_AS_GLOBAL_CLASSROOM_AUTHORITY=NO
SECOND_CANONICAL_IDENTITY_AUTHORITY=NO
EMAIL_ONLY_ACCOUNT_LINKING=NO
GOOGLE_WORKSPACE_SCOPE_REQUIRED_FOR_PADIEM_LOGIN=NO
```

- Chat의 `padiem_session` 쿠키를 재사용하지 않는다. **제품별 세션**이 원칙이다(Chat의 `cpython_shared_login.py`와 같은 형태로 GC 전용 클라이언트 키를 쓴다).
- Google Workspace(Drive/Docs/Classroom) 스코프는 로그인과 분리한다. Drive를 쓰는 사용자만 GIS 동의를 따로 받는다 — 지금 `hooks/useAuth.ts`의 GIS 경로를 그대로 유지.
- Firebase 인증은 **한 번에 지우지 않는다.** 로그인 화면만 PADIEM으로 바꾸고, Firebase 익명 세션은 라이브 공유(Firestore 규칙이 uid를 요구한다)의 전송 수단으로만 남긴다. 익명 uid는 계정이 아니라고 화면·문서에 명시한다. 제거는 별도 단계(§3 P16).

**화면**: `LoginModal`의 게스트·이메일/비밀번호를 없애고 PADIEM 로그인 하나로 바꾼다. 로그아웃은 gc_session 폐기 + 기존 Firebase 로그아웃을 함께 수행한다.

### (b) 등급별 사용 — 이름은 Free·Plus·Pro·Max

- **표시 이름**: Global Classroom 화면에서는 `Free / Plus / Pro / Max`. `PADIEM` 접두어를 붙이지 않는다(Chat/Claw는 `PADIEM Free` 그대로).
- **읽는 곳**: 서버(요청 입구)에서만. Chat이 쓰는 것과 같은 계정 등급 정본을 쓴다 — 서버측 회원 레코드 `{status:"approved", tier}`를 확인하고, 관리자는 서버가 증명한 경우에만 최대 등급. **클라이언트가 보낸 등급은 절대 신뢰하지 않는다.** 등급 근거가 없거나 읽을 수 없으면 Free로 내린다(fail-closed).
  - 전송 등급 라벨(Padiem Free…)은 내부 값이고, GC 화면에는 접두어 없이 표시만 바꾼다.
- **세는 곳**: **com2 SQLite**. Chat의 D1을 빌려 쓰지 않는다 — 제품 권위가 다르고, 매 요청 왕복이 한 번 더 생긴다.

```sql
gc_usage(
  user_id     TEXT NOT NULL,   -- canonical sub (계정 정본), 기기 번호 아님
  period_key  TEXT NOT NULL,   -- '2026-11-05' (일) / '2026-11' (월)
  bucket      TEXT NOT NULL,   -- translate | interview_answer | live_minute | tts | vision | transcribe
  count       INTEGER NOT NULL,
  PRIMARY KEY (user_id, period_key, bucket)
);
gc_usage_limits(tier TEXT, bucket TEXT, period TEXT, limit_value INTEGER);
```

- 계수는 **요청 입구 한 곳**(프록시를 받는 com2 API 게이트)에서 한다. 지금 `_rateLimit.ts`가 인스턴스 메모리로 세는 문제를 없애려면 계수 지점이 하나여야 한다.
- 응답에 `x-usage-remaining`을 붙여 화면이 남은 양을 보여준다(현행 `x-trial-remaining` 자리).
- `#111`의 버스트·분당 한도는 유지하되 키를 `user_id`로 바꾼다. 식별 불가 요청은 지금처럼 fail-closed 공용 버킷.
- 한도 숫자는 **대표 결정**(§4 Q2). 표만 만들고 값은 설정으로 둔다.

### (c) BYOK — 키는 서버에 봉인 보관

Chat의 BYOK 구현(`apps/padiem-chat/app/byok_credentials.py`, `migrations/053_chat_custom_provider_credentials.sql`)과 같은 형태를 쓴다. 이유는 취향이 아니라 제약이다.

1. Live 임시 토큰은 **서버가** 발급한다 → 서버가 그 사용자의 키를 알아야 한다.
2. 공용 PC 교실에서 `localStorage` 키는 다음 학생에게 남는다.
3. 사용자별 사용량·회수·키 교체를 서버가 집행해야 한다.

```sql
gc_provider_credentials(
  user_id           TEXT NOT NULL,
  provider_id       TEXT NOT NULL,      -- google | groq | ...
  key_last4         TEXT NOT NULL,
  sealed_credential TEXT NOT NULL,      -- AES-GCM 암호문
  endpoint          TEXT,               -- 사용자 지정 엔드포인트가 있을 때만
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider_id)
);
```

- 암호화: 전용 비밀(`GC_BYOK_SECRET`, 32자 이상)에서 목적 문자열로 유도한 키 + AES-GCM. **AAD에 `user_id|provider_id|endpoint`를 묶어** 행을 다른 사용자·다른 호스트로 옮겨도 복호화되지 않게 한다. 세션 쿠키 비밀과 키를 공유하지 않는다.
- API: `POST /api/byok/register`(키 1회 제출 → 봉인 저장), `POST /api/byok/detect`(카탈로그 + `last4`만). **어떤 응답·로그에도 원문 키를 싣지 않는다.** Chat의 `byok_detect`/`byok_register`와 같은 계약.
- 호출 경로: 브라우저 → (세션 쿠키) `/api/...` → 서버가 사용자·제공자로 봉인 키 조회 → 공급사 호출. 지금의 `x-user-api-key` 머리글 경로는 **로그인 사용자에게는 폐기**한다(머리글 키는 서버가 소유자와 묶을 수 없다).
- Live: `/api/live-token`이 BYOK 키(제공자 google)가 있으면 그 키로, 없으면 등급별 공용 키로 토큰을 발급한다. 사용자 키 프로젝트가 Live를 못 열면 평문 한국어로 이유를 돌려준다(#6903의 `custom_provider_reasoning_rejected` 안내와 같은 방식).
- 이전: 로그인 직후 로컬에 키가 남아 있으면 **사용자가 명시적으로 누를 때만** 계정 저장으로 옮긴다. 자동 전송 금지.
- **#32 계약 변경 고지**: "개인·반 키는 브라우저에만"은 로그인 사용자에게 더 이상 성립하지 않는다. 이 문서가 그 대체 근거다.

### (d) 서버 함수를 컴2로 — 범위와 순서

**런타임 선택:** Node 22 + 얇은 HTTP 어댑터로 **현행 핸들러를 그대로** 돌린다.

- 근거: 화면·함수가 TypeScript 30,680줄이고 `@google/genai`·`groq-sdk`가 Node SDK다. Python(Starlette)로 다시 쓰면 이전 비용이 두 배가 되고 위험이 늘어난다. Chat과 런타임이 달라도 무방하다 — 공유하는 것은 **로그인 표 검증 라이브러리와 계정 등급 정본**이지 웹 프레임워크가 아니다.
- 어댑터는 `{ statusCode, headers, body }` 계약을 유지해 기존 단위 시험(`tests/unit/**`)과 `_aiGuards`·`_rateLimit`·`_providerBudget`을 손대지 않는다.

**컴2 배치(안):**

```text
/opt/padiem/global-classroom/          릴리스 (git checkout + npm ci --omit=dev)
  현재 -> releases/<sha>               심볼릭 링크 교체로 롤백
/mnt/d/padiem/global-classroom/        gc.sqlite3, 업로드 임시, 로그
systemd  gc-api.service               127.0.0.1:8799, padiem-gc 사용자
tunnel   gc-api.padiem.net            전용 터널 (Chat 터널과 파일·자격증명 공유 금지)
health   GET /health -> {"status":"ok","release":"<sha>"}
```

**화면 호스팅과 origin:** 1단계는 **화면을 Netlify에 그대로 두고** `/api/*`만 프록시한다.

```toml
[[redirects]]
  from = "/api/*"
  to   = "https://gc-api.padiem.net/:splat"
  status = 200
  force  = true
```

- 이유: origin이 그대로라 세션이 same-origin이 되고(host-only 쿠키), CORS가 필요 없고, **롤백이 리다이렉트 한 줄 되돌리기**로 끝난다.
- **검증 선행 조건**: Netlify 프록시가 (1) 요청 본문 크기(vision 5MB·transcribe 파일)와 (2) 타임아웃, (3) `Set-Cookie` 양방향 전달을 실제로 통과시키는지 확인한다. 통과하지 못하면 `api.` 서브도메인 + CORS(credentials) 방식으로 바꾼다.
- 화면을 Cloudflare Pages로 옮기는 것은 **2단계 결정**이다. 옮기면 origin이 바뀌어 padiem-auth callback을 다시 등록해야 하므로, 등록 전에 확정한다.

**이전 순서(위험 × 빈도 기준):**

| 순서 | 함수 | 이유 |
| ---: | --- | --- |
| 1 | `summarize`, `session-metadata` | 저빈도·백그라운드. 실패해도 수업이 안 멈춘다. 경로 검증용 |
| 2 | `detect-language` | 독립적, 실패 시 기존 폴백 있음 |
| 3 | `vision` | 수동 동작·저빈도. 큰 본문 한계를 여기서 검증 |
| 4 | `tts` | 잦지만 재생 실패는 수업 중단이 아니다 |
| 5 | `transcribe-accounts`, `transcribe-file` | 업로드 경로·계정 선택 분리 |
| 6 | `translate`, `interview-answer` | **턴 임계 경로.** 지연 게이트 통과 후에만 |
| 7 | `live-token` | 호출은 드물지만 실패하면 음성이 죽는다. 마지막 |

- 1~5는 기능 플래그(엔드포인트별 `src` 선택)로, 6~7은 지연 측정 후 별도 승인으로 넘긴다.
- **Netlify에 남기는 것**: 화면 정적 자산(`dist`), `/api/*` 프록시, 그리고 전환 기간의 이전 구현(플래그 off 시 즉시 사용).
- 이전 기간에는 두 곳이 같은 키를 읽는다. 키 회전은 **양쪽 환경변수를 같은 커밋에서** 바꾼다.

### (e) 음성 live-token

- **서버 발급을 유지한다.** 오디오는 지금처럼 브라우저↔Google 직결이고, com2 이전 뒤에도 그대로다. 즉 이전이 음성 지연에 주는 영향은 세션당 토큰 1회 호출뿐이다.
- 토큰 조건은 현행 계약을 그대로 보존한다: `uses: 1`, 30분 만료, 1분 내 새 세션, `liveConnectConstraints.model`로 모델 고정, `ALLOWED_LIVE_MODELS` 3개 허용 목록.
- 키 선택: 그 사용자의 BYOK(google) > 등급별 공용 키. 계정 1/2 선택(Transcribe 페이지)은 유지하되 세션 사용자와 묶어 기록한다.
- 사용량: 토큰 발급 횟수가 아니라 **Live 연결 분**으로 세는 것을 권한다(대표 결정 Q2에 숫자와 함께).
- 실패 시: `useInterviewLive`의 기존 폴백(브라우저 STT/Groq Whisper)을 유지한다. live-token이 500이면 음성 전체가 아니라 전사 폴백으로 내려간다.

---

## 3. 단계별 작업 (작은 PR 단위)

크기: **S** ≈ 반나절·200줄 이하, **M** ≈ 1~3일·600줄 이하, **L** ≈ 3일 이상.

### 0단계 — 로그인·등급 (화면은 아직 Netlify 함수)

| # | PR | 내용 | 크기 | 위험 |
| ---: | --- | --- | --- | --- |
| P1 | padiem 로그인 서버 뼈대 | `/auth/padiem/start`·`/callback`·`/logout`, state+PKCE, 1회 코드 교환, 표 로컬 검증, `gc_session` 발급. 플래그 off | M | 낮음 (경로 미노출) |
| P2 | 세션 신원으로 계수 전환 | 계수 키를 기기에서 `sub`로. 플래그 off면 기존 유지. 기존 시험 병행 | M | 중간 (이중 계수) |
| P3 | 로그인 화면 교체 | `LoginModal` 게스트·이메일 제거, PADIEM 로그인 하나. 로그아웃 정리 | S | **높음** (사용자 진입 차단 가능) |
| P4 | 등급 읽기 + `/api/auth/me` | 서버측 회원 레코드 → Free/Plus/Pro/Max, 관리자 예외, fail-closed Free | M | 낮음 |
| P5 | 사용량 저장소 | com2 SQLite 스키마·기간 창·`x-usage-remaining`·한도표(값은 설정) | M | 중간 (이중 계수 구간) |
| P6 | BYOK 저장·조회 | 봉인 저장(AES-GCM+AAD), register/detect, 시험(키 원문 미노출) | L | 중간 (암호 계약) |
| P7 | BYOK 호출 경로 | 실행 경로를 세션 기반 키 조회로. `x-user-api-key`는 로그인 사용자에게 폐기 | M | 중간 |

### 1단계 — com2 이전

| # | PR | 내용 | 크기 | 위험 |
| ---: | --- | --- | --- | --- |
| P8 | com2 런타임 골격 | Node 22 어댑터, `/health`, systemd, 전용 터널, 릴리스 symlink | M | 낮음 (트래픽 0) |
| P9 | Netlify 프록시 + 플래그 | `/api/*` → gc-api, 엔드포인트별 `netlify|com2` 선택. 본문·타임아웃·쿠키 검증 | M | **높음** (전 경로 영향) |
| P10 | summarize·session-metadata 이전 | 첫 실트래픽. 지연·에러율 관측 | S | 낮음 |
| P11 | detect-language·vision 이전 | 큰 본문 한계 확인 | S~M | 낮음 |
| P12 | tts 이전 | 재생 실패 폴백 확인 | S | 낮음 |
| P13 | transcribe 계열 이전 | 업로드·계정 선택 | M | 중간 |
| P14 | translate·interview-answer 이전 | **지연 게이트**: p95 증가가 예산 안일 때만 | M | **높음** |
| P15 | live-token 이전 | 음성 임계. 마지막 | M | **높음** |

### 2단계 — 정리 (별도 승인)

| # | PR | 내용 | 크기 | 위험 |
| ---: | --- | --- | --- | --- |
| P16 | Firebase 인증 은퇴 | 익명·이메일/비밀번호 로그인 제거, Firestore 전송 경로 정리, 계정 이관 안내 | M | **높음** |

**총 16개 PR / 5묶음(로그인·등급·BYOK·이전·정리).** 각 PR은 이 저장소 규칙대로 `npm ci → lint → test:unit → build`를 통과해야 한다(`docs/CI.md`).

### 지연 예산(측정 항목)

이전 전후로 같은 조건에서 잰다.

| 경로 | 현행 관측 | 이전 후 허용 |
| --- | --- | --- |
| `translate` p95 | (측정 필요) | 이전 전 대비 **+150ms 이내**, 절대 2.5초 이내 |
| `interview-answer` p95 | (측정 필요) | 이전 전 대비 **+150ms 이내** |
| `live-token` p95 | (측정 필요) | 1초 이내 (세션당 1회) |
| `tts` p95 | (측정 필요) | +200ms 이내 |
| 정적 자산 TTFB | Netlify CDN | 변화 없음(화면 유지 시) |

"LA 경유"가 실제로 문제인지는 추정하지 않고, **브라우저→Cloudflare→컴2 구간의 RTT를 먼저 측정**해 표에 채운다. 측정 없이 6·7번을 넘기지 않는다.

---

## 4. 큰 위험 3개

1. **턴 임계 경로 지연 (LA 경유).** `translate`·`interview-answer`는 면접 중 사람이 기다리는 경로다. com2 왕복이 늘면 체감이 바로 무너진다. 완화: 6번을 마지막에서 두 번째로 두고, p95 게이트를 통과할 때만 넘기며, 플래그로 Netlify 구현을 즉시 되살린다.
2. **수업 중 중단.** 로그인 전환은 진행 중인 익명 세션과 로컬 맛보기 카운터를 무효화하고, Netlify 자동 배포로 즉시 전파된다. 완화: P3을 수업 시간 밖에 내보내고, PADIEM 로그인 실패 시 안내 화면(수업 도구가 멈추지 않게 로컬 히스토리는 유지), 롤백은 플래그 하나.
3. **계정·데이터 분리.** canonical sub ↔ Firebase uid ↔ Drive 폴더 소유권이 서로 다르다. 이메일로 자동 병합하면 규칙 위반이고, 잘못 옮기면 라이브 공유 방과 Drive 백업이 고아가 된다. 완화: 명시적 연결 표만 사용, 이메일 병합 금지, P16 전까지 Firebase 인증을 읽기 전용으로 유지.

준위험: com2가 새 단일 장애점이 된다(터널·서비스·디스크). 완화: health·systemd 재시작·백업(`VACUUM INTO`, Chat 런북과 같은 방식), 그리고 "com2 장애 = AI 기능만 정지, 화면과 로컬 히스토리는 동작"을 계약으로 명시.

---

## 5. 대표에게 물을 것 (한 줄씩)

1. 반 키(교사가 반 전체에 배포하는 키)를 새 구조에서 유지할지, BYOK로 통합할지.
2. Free·Plus·Pro·Max 각각의 한도 숫자(일/월 호출 수, Live 분).
3. 전환 시점 — 학기 중 금지인지, 방학·주말 창을 줄지.
4. 화면 주소를 지금 Netlify 주소로 유지할지, PADIEM 도메인으로 옮길지(로그인 콜백 등록에 영향).
5. 로그인 없는 사용을 없앨 때 기존 익명 사용자의 로컬 히스토리를 어떻게 안내할지.
6. Free 등급도 로그인 필수로 두면 "맛보기 30/10회"는 폐기인지, Free 한도로 대체인지.
7. BYOK 키로 Live 음성까지 쓸 수 있게 할지(공급사 프로젝트가 Live를 지원해야 함).
8. 한도·과금을 계정 단위로 볼지, 한 교사가 여러 학생을 가르치는 반 단위로 볼지.
9. Firebase 이메일/비밀번호 계정을 언제 은퇴시킬지, 기존 사용자 이관 공지 방식.
10. com2 이전 후 Netlify를 화면 호스팅으로 계속 쓸지(비용·한도 관점).

---

## 6. 이 문서가 대체하는 것

- #119·#121의 **개인 키 > 반 키 > 공용 맛보기(기기 30·세션 10)** 정책은 이 설계로 대체된다. 다만 ① 반 키 존치 여부와 ② Free 등급 한도가 정해지기 전에는 운영 코드를 바꾸지 않는다(대표 결정 대기).
- #32의 **"개인 키는 브라우저에만"** 계약은 로그인 사용자에게 대체된다(서버 봉인 보관). 비로그인 경로가 남아 있는 동안에만 유효하다.
- issue #20의 `PADIEM_AUTH_MIGRATION=DEFERRED`는 이 설계로 해제된다. 단 §2(a)의 hard lock은 그대로 유지한다.

## 7. 이 PR의 범위

문서 1개 추가. 코드·설정·배포·Netlify 상태 변경 없음. 머지는 CTO 판정.
