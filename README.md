<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Global Classroom

실시간 음성 인식과 번역, 그리고 Google Workspace(Drive/Docs/Classroom) 내보내기를 결합한 **AI 기반 다국어 교실 보조 앱**입니다.

## 주요 기능

- **실시간 음성 → 텍스트 변환 + 번역**
- **TTS(음성 합성) 자동 재생 / 전체 재생**
- **카메라(칠판/노트) 텍스트 감지 후 번역**
- **Google 로그인 후**
  - Google Docs로 내보내기
  - Google Drive로 백업
  - Google Classroom에 제출
- **로컬 히스토리 저장(localStorage)**

## 로컬 실행

### 준비물

- Node.js

### 설치

```bash
npm install
```

### 환경변수 설정

프로젝트 루트에 `.env.local` 파일을 만들고 아래 값을 설정합니다.

```bash
GEMINI_API_KEY=여기에_키_입력
```

### 실행

```bash
npm run dev
```

브라우저에서 `http://localhost:3000` 으로 접속합니다.

## Google Workspace 연동 설정

앱에서 Drive/Docs/Classroom 기능을 사용하려면 OAuth 설정이 필요합니다.

- `constants.ts`의 `GOOGLE_CLIENT_ID`를 실제 OAuth 클라이언트 ID로 교체
- Google Cloud Console에서 다음 API를 활성화
  - Google Drive API
  - Google Docs API
  - Google Classroom API
- OAuth 동의 화면 및 승인된 출처/리디렉션 URI를 서비스 도메인에 맞게 등록

## 빌드

```bash
npm run build
```
