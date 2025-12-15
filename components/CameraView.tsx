import React, { useRef, useState, useEffect } from 'react';
import { TranslationMap } from '../types';

interface CameraViewProps {
  isOpen: boolean;
  onClose: () => void;
  onCaptured: (payload: { blob: Blob }) => void;
  t: TranslationMap;
}

const CameraView: React.FC<CameraViewProps> = ({ isOpen, onClose, onCaptured, t }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const mountedRef = useRef(false);

  const captureJpegBlob = async (onAfterDraw?: () => void): Promise<Blob | null> => {
    if (!videoRef.current || !canvasRef.current) return null;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return null;

    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    if (!srcW || !srcH) return null;

    const MAX_DIMENSION = 1280;
    const scale = Math.min(1, MAX_DIMENSION / Math.max(srcW, srcH));
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));

    canvas.width = dstW;
    canvas.height = dstH;
    context.drawImage(video, 0, 0, dstW, dstH);

    if (onAfterDraw) {
      onAfterDraw();
    }

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.72);
    });
    return blob;
  };

  const stopCamera = () => {
    const current = streamRef.current || stream || (videoRef.current?.srcObject as MediaStream | null);
    if (current) {
      current.getTracks().forEach((track) => track.stop());
    }
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (stream) {
      setStream(null);
    }
  };

  const handleClose = () => {
    stopCamera();
    onClose();
  };

  useEffect(() => {
    mountedRef.current = true;
    if (isOpen) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => {
      mountedRef.current = false;
      stopCamera();
    };
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
      streamRef.current = mediaStream;
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
    } catch (err) {
      console.error("Camera access failed", err);
    }
  };

  const handleCapture = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    setIsProcessing(true);
    try {
      const blob = await captureJpegBlob(handleClose);
      if (!blob) {
        throw new Error('이미지 캡처에 실패했습니다.');
      }
      onCaptured({ blob });
    } catch (error) {
      console.error('Capture Error:', error);
      alert(t.visionError);
    } finally {
      if (mountedRef.current) {
        setIsProcessing(false);
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Header */}
      <div className="absolute top-0 w-full p-4 flex justify-between items-center z-30 bg-gradient-to-b from-black/50 to-transparent">
        <button
          onClick={handleClose}
          aria-label="카메라 닫기"
          className="text-white bg-white/20 p-2 rounded-full backdrop-blur-md active:bg-white/30 transition-colors"
        >
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
      <div className="h-40 bg-black flex items-center justify-center pb-8 pt-4">
        <button 
          onClick={handleCapture}
          aria-label="촬영"
          disabled={isProcessing}
          className="w-20 h-20 rounded-full border-[5px] border-white flex items-center justify-center group active:scale-95 transition-transform"
        >
          <div className="w-16 h-16 bg-white rounded-full group-hover:scale-90 transition-transform shadow-inner"></div>
        </button>
      </div>
    </div>
  );
};

export default CameraView;
