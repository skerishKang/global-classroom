# Global Classroom — AI 모델·라우팅 기준 (canonical)

> **기준 시점:** 2026-10-08 · GitHub `main` `299c8e7830f6e4aa0c5202ca5591f240487c5c38` 소스에서 독립 확인.
> **제품 저장소:** `skerishKang/global-classroom`. 이 문서가 모델 설명의 기준이며 **실제 실행 사실은 최신 코드와 Production 응답으로 재확인**한다.
> **중요:** *현재 구현(AS-IS)*과 *개선 목표(TO-BE)*를 섞어 쓰지 않는다. 문서를 고쳤다는 이유로 Production 모델이 변경되었다고 보고하지 않는다.

## 1. 최종 텍스트 번역과 추천 답변: 승인된 7개 모델

두 엔드포인트의 **현재 실제 폴백 순서**는 다음과 같다.

| 순서 | 공급자 | 정확한 모델 ID | 용도 |
| ---: | --- | --- | --- |
| 1 | Groq | `openai/gpt-oss-20b` | 우선 모델 |
| 2 | Groq | `openai/gpt-oss-120b` | 1차 대체 |
| 3 | Groq | `qwen/qwen3.8-27b` | 2차 대체 |
| 4 | Google | `gemma-4-26b-a4b-it` | Google 계열 첫 대체 |
| 5 | Google | `gemma-4-31b-it` | 이후 대체 |
| 6 | Google | `gemini-3.5-flash-lite` | 이후 대체 |
| 7 | Google | `gemini-3.1-flash-lite` | 최종 대체 |

- **소스 권한:** `netlify/functions/translate.ts`, `netlify/functions/interview-answer.ts`.
- **서로 다른 호출:** `/api/translate`는 확정 번역과 답변 번역을 담당하며, `/api/interview-answer`는 추천 답변/맥락별 의견을 생성한다. 두 경로는 모델 목록이 같지만 별도 API 요청이고 할당량·지연도 개별적으로 발생할 수 있다.
- **답변 언어:** 확정 전사의 원문/source 언어로 2문장 안팎의 짧은 구어체 답변을 생성하고, 선택한 번역 대상 언어로 **자동 번역**한다. 답변은 기본 접힘이며 직접 입력·음성·이미지 입력이 동일한 답변 경로를 사용한다.
- 7개 등록은 **7개 모두 실시간으로 호출 가능한 상태라는 보증이 아니다**. 할당량, 404, 429, 지연은 각 시점의 제공자 응답과 실제 Production 계측으로 판단한다.

## 2. 실시간 음성/이미지/히스토리: 기능별 별도 모델

| 기능 | 소스/실제 우선 모델 | 비고 |
| --- | --- | --- |
| Interview authoritative 음성 전사 | `gemini-3.5-transcribe-live` | `hooks/useInterviewLive.ts`; fallback Browser SpeechRecognition / Groq Whisper |
| Interview 실시간 번역 미리보기 | `gemini-3.5-live-translate-preview` | `hooks/useInterviewLive.ts`; **최종 번역과 다른 경로** |
| 이미지/화면/카메라 읽기 | `gemini-3.5-flash-lite` → `gemma-4-31b-it` → `gemma-4-26b-a4b-it` | `netlify/functions/vision.ts`; Google 실패 시 기존 Groq `qwen/qwen3.8-27b` 최후 대체 |
| 저장된 대화 자동 제목·요약 | `gemma-4-31b-it` → `gemma-4-26b-a4b-it` → `gemini-2.5-flash-lite` | `netlify/functions/session-metadata.ts`; 마지막에 Groq `openai/gpt-oss-20b` → `openai/gpt-oss-120b` 대체 |
| 기존 수동 대화 요약 | `gemma-4-31b-it` → `gemma-4-26b-a4b-it` → `gemini-2.5-flash-lite` | `netlify/functions/summarize.ts`; 이후 기존 Groq 대체 |
| Classroom TTS | `gemini-2.5-flash-preview-tts` | `netlify/functions/tts.ts`; 이 기능의 모델을 새 번역 모델과 혼동하지 않는다 |
| Classroom 기타 기본 모델 상수 | `constants.ts`에 일부 `gemini-2.5-*` 설정이 존재 | **번역·답변의 7개 런타임 폴백을 의미하지 않음** |

각 경로의 모델/정책은 동일하지 않다. **위 7개 모델은 최종 텍스트 번역·답변의 라우트**이며, Live, Vision, TTS, 히스토리의 모델까지 그 7개로 일괄 교체하는 지시가 아니다.

## 3. 언어 자동 감지: 구형 모델이 남아 있는 별도 결함

현재 `netlify/functions/detect-language.ts`는 아래 **레거시 구현(AS-IS)**을 사용한다. **이 4개를 제품의 최신 모델 목록으로 설명하면 안 된다.**

```text
현재 /api/detect-language (아직 변경되지 않음):
  Gemini 2.5 Flash-Lite
  → Gemini 2.0 Flash
  → Groq Llama 3.3 70B Versatile
  → Groq Llama 3.1 8B Instant
```

- Production에서 `llama-3.3-70b-versatile`에 **404 model_not_found**, `/api/detect-language`에 **HTTP 500**이 확인되었다.
- 코드상 **429를 제외한 모델 오류에서 다음 후보로 진행하지 않는 `break`**가 있다. 따라서 다음 Llama 8B가 등록돼도 실제로 도달하지 못할 수 있다.
- Live 전사의 언어 메타데이터와, Browser SpeechRecognition/Groq Whisper fallback의 `/api/detect-language` 호출은 구별한다.
- **TO-BE / 구현 전:** [#85](https://github.com/skerishKang/global-classroom/issues/85)에서 더 이상 접근 불가능한/구형 감지 전용 모델을 현재 **승인된 7개 모델 카탈로그 내의 검증된 저지연 후보**로 교체하고, 404/429/5xx/timeout/유효하지 않은 모델 응답에 안전하게 폴백한다. 감지 모델의 **정확한 최적 순서와 범위는 측정 후 #85 구현에서 결정**한다. 이 문서 변경만으로 감지 모델이 이미 교체된 것은 아니다.
- Llama 자체가 언어 감지를 못하는 것은 아니며, **현재 특정 모델/키 접근 불가와 실패 처리 코드**가 문제다. Llama를 최신 7개 번역·답변 모델에 포함된 것으로 해석하지 않는다.

## 4. 장애·우선순위 및 검증 게이트

- [#84](https://github.com/skerishKang/global-classroom/issues/84): 최종 번역/답변에서 **30.64초 HTTP 504**, 다른 기술 질문에서 **20.43초 GPT-OSS 120B 성공**이 관측됨. 429·5xx·모델 응답 지연 중 어떤 경로가 병목인지 계측하고 **모델별/전체 요청 시간 상한, 제한된 재시도, 합리적인 fallback**을 검증해야 한다.
- [#85](https://github.com/skerishKang/global-classroom/issues/85): **언어 자동 감지 404/500 및 레거시 모델** 현대화. #84와 증상은 관련 있지만 서로 다른 엔드포인트다.
- 저장된 대화의 백그라운드 제목·요약도 동일 Google/Groq 할당량을 쓴다. 실시간 인터뷰의 지연에 영향이 있는지는 **측정 전 추정**이며, 실제 영향 검증 및 필요한 스케줄링은 #84 범위에 둔다.
- **변경 보류:** 문서·이슈를 먼저 정합화한다. 런타임 소스의 모델 교체/재정렬, 제공자 계정 변경, PR merge·Production 배포는 별도 구현·검증 없이 선언하지 않는다.
- **실행 전후 검증:** `main` fresh-read → 모델 ID/폴백 순서 소스 확인 → 성공·404·429·5xx·timeout unit → 정확한 head CI 및 desktop/mobile E2E → Netlify `commit_ref`가 merge SHA와 일치하는지 검증 → 실제 API 응답 시간/모델명 확인.
