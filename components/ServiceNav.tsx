import React from 'react';

export type ServicePage = 'classroom' | 'interview' | 'transcribe';

const PAGES: { id: ServicePage; label: string; href: string }[] = [
  { id: 'classroom', label: '글로벌 클래스룸', href: '/classroom' },
  { id: 'interview', label: '인터뷰', href: '/interview' },
  { id: 'transcribe', label: '전사', href: '/transcribe' },
];

export default function ServiceNav({ active }: { active: ServicePage }) {
  return (
    <nav className="flex flex-wrap gap-1.5" aria-label="서비스 메뉴">
      {PAGES.map((page) => (
        <a
          key={page.id}
          href={page.href}
          aria-current={active === page.id ? 'page' : undefined}
          className={`inline-flex min-h-9 items-center justify-center rounded-lg px-3 text-xs font-semibold transition-all duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 ${
            active === page.id ? 'bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 hover:shadow-md' : 'bg-slate-100 text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 hover:shadow-sm'
          }`}
        >
          {page.label}
        </a>
      ))}
    </nav>
  );
}
