import React, { useState } from 'react';

interface InterviewToolsBarProps {
  uiLangCode: string;
  glossaryText: string;
  onGlossaryChange: (value: string) => void;
  onSubmitText: (text: string) => void;
}

const InterviewToolsBar: React.FC<InterviewToolsBarProps> = ({
  uiLangCode,
  glossaryText,
  onGlossaryChange,
  onSubmitText,
}) => {
  const [panel, setPanel] = useState<'text' | 'glossary' | null>(null);
  const [text, setText] = useState('');

  const submit = () => {
    if (!text.trim()) return;
    onSubmitText(text);
    setText('');
  };

  return (
    <div className="shrink-0 border-b border-gray-100 bg-white/90 px-3 py-2">
      <div className="mx-auto flex max-w-5xl items-center gap-2">
        <button
          type="button"
          onClick={() => setPanel(panel === 'text' ? null : 'text')}
          className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${panel === 'text' ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-700'}`}
        >
          {uiLangCode === 'ko' ? '텍스트 입력' : 'Text input'}
        </button>
        <button
          type="button"
          onClick={() => setPanel(panel === 'glossary' ? null : 'glossary')}
          className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${panel === 'glossary' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700'}`}
        >
          {uiLangCode === 'ko' ? '용어집' : 'Glossary'}
        </button>
        <span className="text-[10px] text-gray-400">
          {uiLangCode === 'ko' ? '원문과 번역은 언제든 수정할 수 있습니다.' : 'Source and translation stay editable.'}
        </span>
      </div>

      {panel === 'text' && (
        <div className="mx-auto mt-2 grid max-w-5xl grid-cols-[1fr_auto] gap-2">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData('text');
              if (!pasted.trim()) return;
              event.preventDefault();
              onSubmitText(pasted);
              setText('');
            }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            rows={4}
            placeholder={uiLangCode === 'ko' ? '여기에 입력하거나 붙여넣으세요. 원문은 그대로 보존됩니다.' : 'Type or paste here. The source is preserved as entered.'}
            className="min-h-24 w-full resize-y rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim()}
            className="self-stretch rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white disabled:bg-gray-300"
          >
            {uiLangCode === 'ko' ? '번역' : 'Translate'}
          </button>
        </div>
      )}

      {panel === 'glossary' && (
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
