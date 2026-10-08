import React, { useEffect, useRef, useState } from 'react';
import { prepareInterviewImage } from '../utils/interviewImage';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onImage: (blob: Blob) => Promise<void>;
  onCamera: () => void;
  uiLangCode: string;
}

/** Explicit user-action image capture; never records screens in the background. */
export default function InterviewImageInput({ isOpen, onClose, onImage, onCamera, uiLangCode }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const ko = uiLangCode === 'ko';

  const importBlob = async (blob: Blob) => {
    setBusy(true);
    setMessage('');
    try {
      const converted = await prepareInterviewImage(blob);
      await onImage(converted);
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const paste = (event: ClipboardEvent) => {
      if (busy) return;
      const image = [...(event.clipboardData?.items || [])]
        .find((item) => item.kind === 'file' && item.type.startsWith('image/'));
      const file = image?.getAsFile();
      if (!file) return;
      event.preventDefault();
      void importBlob(file);
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, [isOpen, onImage, busy]);

  if (!isOpen) return null;

  const captureScreen = async () => {
    const getDisplayMedia = navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices);
    if (!getDisplayMedia) {
      setMessage(ko ? '이 브라우저에서는 화면 캡처를 지원하지 않습니다.' : 'Screen capture is not supported in this browser.');
      return;
    }
    setBusy(true);
    setMessage('');
    let stream: MediaStream | undefined;
    let video: HTMLVideoElement | undefined;
    try {
      stream = await getDisplayMedia({ video: true, audio: false });
      video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      if (!video.videoWidth || !video.videoHeight) throw new Error('화면 프레임을 읽지 못했습니다.');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('화면 캡처에 실패했습니다.');
      context.drawImage(video, 0, 0);
      const frame = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
      if (!frame) throw new Error('화면 캡처에 실패했습니다.');
      const converted = await prepareInterviewImage(frame);
      await onImage(converted);
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      video?.pause();
      if (video) video.srcObject = null;
      stream?.getTracks().forEach((track) => track.stop());
      setBusy(false);
    }
  };

  return (
    <div data-testid="interview-image-dialog" role="dialog" aria-modal="true"
      aria-label={ko ? '이미지에서 질문 읽기' : 'Read question from image'}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">{ko ? '이미지에서 질문 읽기' : 'Read question from image'}</h2>
          <button type="button" aria-label={ko ? '닫기' : 'Close'} disabled={busy} onClick={onClose}
            className="rounded-full p-2 text-gray-500 hover:bg-gray-100">✕</button>
        </div>
        <p className="mt-2 text-sm text-gray-600">
          {ko ? '이미지의 글자를 읽어 면접 전사·번역·추천 답변에 추가합니다.' : 'Read image text and add it to the interview with translation and an answer.'}
        </p>
        <input ref={fileRef} type="file" data-testid="interview-image-file" accept="image/jpeg,image/png,image/webp"
          className="hidden" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importBlob(file);
          }}/>
        <div className="mt-4 grid gap-2">
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
            className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-left font-semibold text-indigo-800 hover:bg-indigo-100">
            {ko ? '이미지 파일 선택 (JPG · PNG · WEBP)' : 'Upload an image (JPG · PNG · WEBP)'}
          </button>
          <div data-testid="interview-image-paste-hint" className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
            {ko ? '클립보드 이미지 붙여넣기: Ctrl+V' : 'Paste clipboard image: Ctrl+V'}
          </div>
          <button type="button" data-testid="interview-screen-capture" disabled={busy} onClick={() => void captureScreen()}
            className="rounded-xl border border-gray-200 px-4 py-3 text-left font-semibold text-gray-800 hover:bg-gray-50">
            {ko ? '현재 화면 캡처 (화면 공유 권한)' : 'Capture screen (permission required)'}
          </button>
          <button type="button" disabled={busy} onClick={() => { onClose(); onCamera(); }}
            className="rounded-xl border border-gray-200 px-4 py-3 text-left font-semibold text-gray-800 hover:bg-gray-50">
            {ko ? '카메라로 촬영' : 'Take a camera photo'}
          </button>
        </div>
        {busy && <p role="status" className="mt-3 text-sm text-indigo-600">{ko ? '이미지를 분석하는 중…' : 'Analyzing image…'}</p>}
        {message && <p role="alert" className="mt-3 text-sm text-red-600">{message}</p>}
      </div>
    </div>
  );
}
