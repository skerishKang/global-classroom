import React, { useState } from 'react';

interface InterviewToolsBarProps {
  uiLangCode: string;
  glossaryText: string;
  onGlossaryChange: (value: string) => void;
}

const InterviewToolsBar: React.FC<InterviewToolsBarProps> = ({
  uiLangCode,
  glossaryText,
  onGlossaryChange,
}) => {
  const [glossaryOpen, setGlossaryOpen] = useState(false);

  return (
    <div className="shrink-0 border-b border-gray-100 bg-white/90 px-3 py-2">
      <div className="mx-auto flex max-w-5xl items-center gap-2">
        <button
          type="button"
          onClick={() => setGlossaryOpen((open) => !open)}
          className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${glossaryOpen ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700'}`}
        >
          {uiLangCode === 'ko' ? '용어집' : 'Glossary'}
        </button>
        <span className="text-[10px] text-gray-400">
          {uiLangCode === 'ko'
            ? '음성은 자동 통역되고, 키보드 입력은 왼쪽 입력창에서 Enter로 번역합니다.'
            : 'Voice is interpreted automatically; keyboard text translates from the left composer with Enter.'}
        </span>
      </div>

      {glossaryOpen && (
        <div className="mx-auto mt-2 max-w-5xl">
          <textarea
            value={glossaryText}
            onChange={(event) => onGlossaryChange(event.target.value)}
            rows={4}
            placeholder={"파디엠 = Padiem\n컨트롤 플레인 = Control Plane"}
            className="min-h-24 w-full resize-y rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
          <p className="mt-1 text-[10px] text-gray-400">
            {uiLangCode === 'ko'
              ? '한 줄에 하나씩 “원문 = 원하는 번역”으로 입력하세요. 텍스트 번역/다시 번역에 적용되고, 용어는 다음 Live 전사 세션의 맞춤 어휘에도 반영됩니다.'
              : 'Use one “source = preferred translation” pair per line. It applies to text/retranslation and the next Live transcription session vocabulary.'}
          </p>
        </div>
      )}
    </div>
  );
};

export default InterviewToolsBar;
