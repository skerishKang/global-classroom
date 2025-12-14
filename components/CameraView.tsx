import React, { useRef, useState, useEffect } from 'react';
import { MODEL_VISION } from '../constants';
import { VisionResult, Language, TranslationMap } from '../types';

interface CameraViewProps {
  isOpen: boolean;
  onClose: () => void;
  langA: Language;
  langB: Language;
  t: TranslationMap;
}

const CameraView: React.FC<CameraViewProps> = ({ isOpen, onClose, langA, langB, t }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<VisionResult | null>(null);

  const blobToBase64Data = async (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        resolve(dataUrl.split(',')[1] || '');
      };
      reader.onerror = () => reject(reader.error || new Error('이미지 변환에 실패했습니다.'));
      reader.readAsDataURL(blob);
    });
  };

  const captureJpegBase64 = async (): Promise<string> => {
    if (!videoRef.current || !canvasRef.current) return '';

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return '';

    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    if (!srcW || !srcH) return '';

    const MAX_DIMENSION = 1280;
    const scale = Math.min(1, MAX_DIMENSION / Math.max(srcW, srcH));
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));

    canvas.width = dstW;
    canvas.height = dstH;
    context.drawImage(video, 0, 0, dstW, dstH);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.72);
    });
    if (!blob) return '';

    return blobToBase64Data(blob);
  };

  const postApi = async <T,>(path: string, payload: unknown): Promise<T> => {
    const res = await fetch(`/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((json as any)?.error || '요청에 실패했습니다.');
    }
    return json as T;
  };

  useEffect(() => {
    if (isOpen) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const startCamera = async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
    } catch (err) {
      console.error("Camera access failed", err);
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    setResult(null);
  };

  const handleCapture = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    setIsProcessing(true);
    try {
      const base64Data = await captureJpegBase64();
      if (!base64Data) {
        throw new Error('이미지 캡처에 실패했습니다.');
      }
      await analyzeImage(base64Data);
    } catch (error) {
      console.error('Capture Error:', error);
      setResult({
        originalText: t.visionError,
        translatedText: t.retry
      });
      setIsProcessing(false);
    }
  };

  const analyzeImage = async (base64Image: string) => {
    try {
      const data = await postApi<{ originalText: string; translatedText: string }>('vision', {
        base64Image,
        langA: langA.name,
        langB: langB.name,
        model: MODEL_VISION,
      });
      setResult({
        originalText: data.originalText || t.visionNoText,
        translatedText: data.translatedText || t.visionFail
      });

    } catch (error) {
      console.error("Vision Error:", error);
      setResult({
        originalText: t.visionError,
        translatedText: t.retry
      });
    } finally {
      setIsProcessing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Header */}
      <div className="absolute top-0 w-full p-4 flex justify-between items-center z-10 bg-gradient-to-b from-black/50 to-transparent">
        <button onClick={onClose} className="text-white bg-white/20 p-2 rounded-full backdrop-blur-md active:bg-white/30 transition-colors">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
        <span className="text-white font-medium text-lg drop-shadow-md">{t.visionTitle}</span>
        <div className="w-10"></div>
      </div>

      {/* Camera Preview */}
      <div className="flex-1 relative bg-black flex items-center justify-center overflow-hidden">
        <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
        <canvas ref={canvasRef} className="hidden" />
        
        {/* Overlay Result */}
        {result && (
          <div className="absolute inset-x-4 top-1/4 bg-white/95 backdrop-blur-xl rounded-2xl p-6 shadow-2xl border border-gray-100 animate-in fade-in slide-in-from-bottom-10 duration-300">
            <div className="mb-4">
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">{t.visionDetected}</h3>
              <p className="text-gray-800 text-lg leading-relaxed max-h-40 overflow-y-auto">{result.originalText}</p>
            </div>
            <div className="w-full h-px bg-gray-200 my-4"></div>
            <div>
              <h3 className="text-xs font-bold text-indigo-600 uppercase tracking-wider mb-1">{t.visionTranslated}</h3>
              <p className="text-indigo-900 text-xl font-medium leading-relaxed max-h-40 overflow-y-auto">{result.translatedText}</p>
            </div>
            <button 
              onClick={() => setResult(null)}
              className="mt-6 w-full py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-medium transition-colors"
            >
              {t.visionRetake}
            </button>
          </div>
        )}

        {/* Loading */}
        {isProcessing && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-20">
            <div className="flex flex-col items-center">
              <div className="w-12 h-12 border-4 border-white/30 border-t-white rounded-full animate-spin mb-4"></div>
              <p className="text-white font-medium text-lg">{t.visionAnalyzing}</p>
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      {!result && (
        <div className="h-40 bg-black flex items-center justify-center pb-8 pt-4">
          <button 
            onClick={handleCapture}
            disabled={isProcessing}
            className="w-20 h-20 rounded-full border-[5px] border-white flex items-center justify-center group active:scale-95 transition-transform"
          >
            <div className="w-16 h-16 bg-white rounded-full group-hover:scale-90 transition-transform shadow-inner"></div>
          </button>
        </div>
      )}
    </div>
  );
};

export default CameraView;
