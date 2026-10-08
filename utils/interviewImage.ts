/** All image sources must become a bounded JPEG before the existing vision API. */
export async function prepareInterviewImage(blob: Blob): Promise<Blob> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) {
    throw new Error('JPG, PNG, WEBP 이미지만 지원합니다.');
  }
  if (!blob.size || blob.size > 15 * 1024 * 1024) {
    throw new Error('이미지는 15MB 이하만 선택할 수 있습니다.');
  }
  const bitmap = await createImageBitmap(blob);
  try {
    let maxSide = 1600;
    for (const quality of [0.82, 0.66, 0.5]) {
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('이미지 변환이 불가능합니다.');
      context.fillStyle = 'white';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (jpeg && jpeg.size > 0 && jpeg.size <= 3 * 1024 * 1024) return jpeg;
      maxSide = 1280;
    }
    throw new Error('이미지 변환 크기가 제한을 초과했습니다.');
  } finally {
    bitmap.close();
  }
}
