import React, { useEffect, useMemo, useRef, useState } from 'react';
import ServiceNav from './ServiceNav';
import ServiceBrand from './ServiceBrand';
import { useTranscribeRecorder } from '../hooks/useTranscribeRecorder';

type TranscriptLine = { speaker: string; text: string; start: number | null; end: number | null };
type ApiWord = TranscriptLine;
const DAILY_LIMIT_REFERENCE = 25;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const fmt = (seconds: number | null) => {
  if (seconds === null || !Number.isFinite(seconds)) return '--:--';
  const n = Math.max(0, seconds);
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}.${Math.floor((n % 1) * 10)}`;
};

const quotaDay = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const counterKey = (account: '1' | '2') => `padiem-transcribe-attempts-${account}-${quotaDay()}`;

function groupWords(words: ApiWord[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const word of words) {
    const speaker = word.speaker || '미확인';
    const previous = lines[lines.length - 1];
    const adjacent = previous && previous.speaker === speaker
      && previous.end !== null && word.start !== null
      && word.start - previous.end < 1.7 && previous.text.length < 115;
    if (adjacent) {
      previous.text += ` ${word.text}`;
      previous.end = word.end;
    } else {
      lines.push({ speaker, text: word.text, start: word.start, end: word.end });
    }
  }
  return lines;
}

function download(name: string, content: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function TranscribePage() {
  const [account, setAccount] = useState<'1' | '2'>('1');
  const [accountAvailability, setAccountAvailability] = useState({ '1': true, '2': false });
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountStatusError, setAccountStatusError] = useState('');
  const live = useTranscribeRecorder(account);
  const [tab, setTab] = useState<'live' | 'file'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [fullText, setFullText] = useState('');
  const [rawWords, setRawWords] = useState<ApiWord[]>([]);
  const [attempts, setAttempts] = useState(() => Number(localStorage.getItem(counterKey('1')) || 0));
  const audioRef = useRef<HTMLAudioElement | null>(null);

  async function refreshAccounts() {
    setAccountsLoading(true);
    setAccountStatusError('');
    try {
      const response = await fetch('/api/transcribe-accounts', { cache: 'no-store' });
      if (!response.ok) throw new Error('계정 상태를 확인할 수 없습니다.');
      const result = await response.json();
      const available = { '1': result.accounts?.['1'] === true, '2': result.accounts?.['2'] === true };
      setAccountAvailability(available);
      setAccount((previous) => available[previous] ? previous : '1');
    } catch {
      // Fail closed for account 2 when the server cannot verify its configuration.
      setAccountAvailability({ '1': true, '2': false });
      setAccount('1');
      setAccountStatusError('계정 설정을 확인할 수 없어 계정 2를 사용할 수 없습니다.');
    } finally {
      setAccountsLoading(false);
    }
  }

  useEffect(() => { void refreshAccounts(); }, []);
  useEffect(() => { setAttempts(Number(localStorage.getItem(counterKey(account)) || 0)); }, [account]);
  const accountChangeBlocked = live.status !== 'idle' || processing;

  useEffect(() => {
    const source = tab === 'live' ? live.recordedBlob : file;
    if (!source) { setSourceUrl(''); return; }
    const url = URL.createObjectURL(source);
    setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, live.recordedBlob, tab]);

  useEffect(() => {
    if (live.status !== 'recording' && live.status !== 'connecting') return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [live.status]);

  const displayedLines = useMemo(() => tab === 'live'
    ? live.lines.map((line) => ({ speaker: '실시간 · 화자 미분리', text: line.text, start: null, end: null }))
    : lines, [tab, live.lines, lines]);
  const remaining = Math.max(0, DAILY_LIMIT_REFERENCE - attempts);

  async function transcribeFile(audio: File | Blob) {
    if (!audio.size || audio.size > MAX_FILE_BYTES) {
      setError('현재 서버 전사는 4MB 이하만 지원합니다. 큰 녹음은 짧은 구간으로 분리해야 합니다.');
      return;
    }
    setProcessing(true);
    setError('');
    setLines([]);
    setRawWords([]);
    setFullText('');
    const form = new FormData();
    form.append('audio', audio, audio instanceof File ? audio.name : 'recording.webm');
    form.append('account', account);
    // This is a browser-local request counter, NOT Google's authoritative project quota.
    const updated = Number(localStorage.getItem(counterKey(account)) || 0) + 1;
    localStorage.setItem(counterKey(account), String(updated));
    setAttempts(updated);
    try {
      const response = await fetch('/api/transcribe-file', { method: 'POST', body: form });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `전사 요청 실패 (HTTP ${response.status})`);
      const text = String(result.text || '').trim();
      const words = Array.isArray(result.words) ? result.words as ApiWord[] : [];
      setFullText(text);
      setRawWords(words);
      setLines(words.length ? groupWords(words) : text ? [{ speaker: '미확인', text, start: null, end: null }] : []);
      setTab('file');
    } catch (e) {
      setError(e instanceof Error ? e.message : '파일 전사에 실패했습니다.');
    } finally {
      setProcessing(false);
    }
  }

  const exportLines = displayedLines;
  const exportTranscript = exportLines.map((line) => `${line.speaker}: ${line.text}`).join('\n\n');
  const exportTimed = exportLines.map((line) =>
    `[${fmt(line.start)} - ${fmt(line.end)}] ${line.speaker}: ${line.text}`).join('\n');
  const exportJson = JSON.stringify({
    source: 'padiem-transcribe',
    timestampPrecision: rawWords.length ? 'word offsets, model output (review required)' : 'not available',
    words: rawWords, editedLines: exportLines, text: fullText,
  }, null, 2);

  const primaryButtonClass = 'rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-all duration-150 hover:bg-indigo-700 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-indigo-600 disabled:hover:shadow-sm';
  const secondaryButtonClass = 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-all duration-150 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-200 disabled:hover:bg-white disabled:hover:text-slate-700';
  const exportButtonClass = 'rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-all duration-150 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-200 disabled:hover:bg-white disabled:hover:text-slate-700';
  const segmentPlayButtonClass = 'rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700 tabular-nums transition-colors duration-150 hover:bg-indigo-100 hover:text-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-slate-100 disabled:hover:text-slate-700';

  return (
    <div className="flex h-screen h-[100dvh] flex-col overflow-hidden bg-slate-50 text-slate-900">
      <header className="bg-white/80 backdrop-blur-md px-3 py-1.5 shadow-sm z-40 border-b border-gray-100 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
          <ServiceBrand title="AI 전사" subtitle="실시간 AI 음성 기록" />
          <span className="rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1.5 text-[11px] font-bold text-indigo-700">Gemini STT</span>
        </div>
        <div className="pb-2"><ServiceNav active="transcribe" /></div>
        <div className="flex flex-wrap items-center gap-2 pb-1" role="group" aria-label="전사 API 계정 선택">
          <span className="text-[10px] font-bold text-gray-500">Google API 계정</span>
          {(['1', '2'] as const).map((id) => (
            <button key={id} type="button" aria-pressed={account === id}
              onClick={() => setAccount(id)}
              disabled={!accountAvailability[id] || accountChangeBlocked}
              title={!accountAvailability[id] ? 'Netlify API 키 미등록' : accountChangeBlocked ? '작업 중에는 계정을 변경할 수 없습니다.' : '계정 선택'}
              className={account === id
                ? 'min-h-8 rounded-full border border-indigo-600 bg-indigo-600 px-3 text-[11px] font-bold text-white transition-colors hover:bg-indigo-700 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-45'
                : 'min-h-8 rounded-full border border-gray-200 bg-white px-3 text-[11px] font-bold text-gray-600 transition-colors hover:border-indigo-300 hover:bg-indigo-50 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-white'}>
              계정 {id}{!accountAvailability[id] ? ' · 미연결' : account === id ? ' · 사용 중' : ''}
            </button>
          ))}
          <button type="button" onClick={() => void refreshAccounts()} disabled={accountsLoading || accountChangeBlocked}
            className="min-h-8 rounded-full border border-gray-200 bg-white px-3 text-[11px] font-bold text-gray-600 transition-colors hover:border-indigo-300 hover:bg-indigo-50 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-45">
            {accountsLoading ? '확인 중…' : '연결 상태 확인'}
          </button>
          <span className="text-[10px] text-gray-400">
            {!accountAvailability['2'] ? '계정 2는 Netlify에 키를 등록한 후 활성화됩니다.' : '키 등록 확인됨 · 실제 사용 가능 여부는 요청 시 확인'}
          </span>
        </div>
        {accountStatusError && <p role="status" className="text-xs text-amber-700">{accountStatusError}</p>}
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mb-5">
          <h1 className="text-2xl font-bold">정밀 음성 전사</h1>
          <p className="mt-1 text-sm text-slate-500">실시간 받아쓰기 또는 MP3 파일 전사 · 전사 수정 · 결과 저장</p>
        </div>
        <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-xs font-semibold text-slate-500">실시간 세션</div>
            <div className="mt-1 text-xl font-bold tabular-nums">{fmt(live.sessionElapsed)} / 10:00</div>
            <div className="mt-1 text-xs text-slate-500">누적 녹음 {fmt(live.elapsed)} · 연결 {live.sessionCount}회 · 약 9분 20초에 자동 재연결</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-xs font-semibold text-slate-500">오늘 파일 전사 시도 · 이 브라우저 기록</div>
            <div className="mt-1 text-xl font-bold tabular-nums">{attempts} / {DAILY_LIMIT_REFERENCE}회</div>
            <div className="mt-1 text-xs text-slate-500">{remaining}회 참고 잔여 · Google 프로젝트 전체 사용량과 다를 수 있음</div>
          </div>
        </div>

        <div className="mb-4 flex gap-2" role="tablist" aria-label="전사 입력 방식">
          <button type="button" role="tab" aria-selected={tab === 'live'} onClick={() => setTab('live')}
            className={`rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 ${tab === 'live' ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-white text-slate-600 hover:bg-indigo-50 hover:text-indigo-700'}`}>실시간 전사</button>
          <button type="button" role="tab" aria-selected={tab === 'file'} onClick={() => setTab('file')}
            className={`rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 ${tab === 'file' ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-white text-slate-600 hover:bg-indigo-50 hover:text-indigo-700'}`}>파일 전사</button>
        </div>

        <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          {tab === 'live' ? (
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => live.status === 'idle' ? void live.start() : live.stop()}
                  disabled={live.status === 'connecting' || !accountAvailability[account]}
                  className={primaryButtonClass}>
                  {live.status === 'recording' || live.status === 'error' ? '녹음 종료 및 저장' : live.status === 'connecting' ? '연결 중…' : '마이크 녹음 시작'}
                </button>
                <span className="text-sm text-slate-500">{live.status === 'recording' ? '● 녹음 중' : live.status === 'error' ? '연결 오류' : '대기'}</span>
                {live.recordedBlob && <button type="button" className={secondaryButtonClass} onClick={() => { const url = URL.createObjectURL(live.recordedBlob!); const a = document.createElement('a'); a.href = url; a.download = 'transcribe-recording.webm'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>원본 녹음 다운로드</button>}
                {live.recordedBlob && <button type="button" className={secondaryButtonClass} onClick={() => void transcribeFile(live.recordedBlob!)}>녹음 정밀 분석</button>}
              </div>
              <p className="mt-3 text-xs text-slate-500">실시간 자막에는 화자 ID·정밀 타임스탬프가 없습니다. 원본 녹음을 정밀 분석하면 추가할 수 있습니다.</p>
              {live.error && <p className="mt-2 text-sm text-red-700" role="alert">{live.error}</p>}
              {live.interim && <p className="mt-3 rounded-lg bg-indigo-50 p-3 text-sm text-indigo-800">{live.interim}</p>}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <label className="block flex-1 text-sm">
                <span className="mb-2 block font-semibold">MP3·WAV·WebM 파일 선택 (최대 4MB)</span>
                <input type="file" accept=".mp3,.wav,.webm,.m4a,audio/*" onChange={(e) => { setFile(e.target.files?.[0] || null); setError(''); }}
                  className="w-full cursor-pointer rounded-lg border border-slate-200 p-2 text-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 file:cursor-pointer" />
              </label>
              <button type="button" disabled={!file || processing || !accountAvailability[account]} onClick={() => file && void transcribeFile(file)}
                className={primaryButtonClass}>
                {processing ? '전사 처리 중…' : '정밀 전사 시작'}
              </button>
            </div>
          )}
          {sourceUrl && (
            <div className="mt-4">
              <audio ref={audioRef} src={sourceUrl} controls className="w-full" />
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-sm font-medium text-red-700">{error}</p>}
        </section>

        <section className="mt-5 rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold">전사 결과 {exportLines.length ? `(${exportLines.length}구간)` : ''}</h2>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={!exportLines.length} className={exportButtonClass}
                onClick={() => download('transcript-timed.txt', exportTimed)}>시간 포함 TXT</button>
              <button type="button" disabled={!exportLines.length} className={exportButtonClass}
                onClick={() => download('transcript-draft.md', exportLines.map(l => `**${l.speaker}:** ${l.text}`).join('\n\n'), 'text/markdown')}>제출 형식 초안</button>
              <button type="button" disabled={!exportLines.length} className={exportButtonClass}
                onClick={() => download('transcript.json', exportJson, 'application/json')}>JSON</button>
            </div>
          </div>
          {!exportLines.length && <p className="rounded-lg bg-slate-50 p-5 text-sm text-slate-500">마이크로 전사를 시작하거나 파일을 업로드하면 결과가 표시됩니다.</p>}
          {tab === 'live' && exportLines.map((line, index) => (
            <div key={live.lines[index]?.id || index} className="mb-3 rounded-lg border border-slate-100 p-3">
              <span className="text-xs font-semibold text-indigo-700">{line.speaker}</span>
              <textarea className="mt-1 block min-h-16 w-full rounded-md border p-2 text-sm" aria-label={`실시간 전사 ${index + 1}`}
                value={line.text} onChange={(event) => live.setLines((prev) => prev.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} />
            </div>
          ))}
          {tab === 'file' && lines.map((line, index) => (
            <div key={index} className="mb-3 rounded-lg border border-slate-100 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button type="button" className={segmentPlayButtonClass}
                  disabled={line.start === null || !sourceUrl} onClick={() => { if (audioRef.current && line.start !== null) { audioRef.current.currentTime = line.start; void audioRef.current.play(); } }}>
                  {fmt(line.start)} – {fmt(line.end)} ▶
                </button>
                <input aria-label={`화자 ${index + 1}`} value={line.speaker}
                  onChange={(e) => setLines((prev) => prev.map((item, i) => i === index ? { ...item, speaker: e.target.value } : item))}
                  className="w-36 rounded border px-2 py-1 text-xs font-semibold" />
              </div>
              <textarea aria-label={`전사 구간 ${index + 1}`} value={line.text}
                onChange={(e) => setLines((prev) => prev.map((item, i) => i === index ? { ...item, text: e.target.value } : item))}
                className="block min-h-16 w-full rounded-md border p-2 text-sm" />
            </div>
          ))}
          <p className="mt-3 text-xs text-slate-500">웃음·박수 자동 판별은 아직 구현되지 않았습니다. 제출 형식 초안은 Clean Verbatim 최종 검수가 필요합니다. AI 시간·화자 구분도 원음 확인을 권장합니다.</p>
        </section>
      </main>
    </div>
  );
}
