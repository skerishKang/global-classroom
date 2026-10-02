import React from 'react';

export const BrandLogo: React.FC<{ className?: string }> = ({ className = "w-10 h-10" }) => {
    return (
        <div className={`${className} bg-white rounded-xl shadow-lg flex items-center justify-center overflow-hidden border border-gray-100`}>
            <svg viewBox="0 0 100 100" className="w-full h-full p-1.5">
                <defs>
                    <linearGradient id="logo-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" style={{ stopColor: '#6366f1', stopOpacity: 1 }} />
                        <stop offset="100%" style={{ stopColor: '#a855f7', stopOpacity: 1 }} />
                    </linearGradient>
                </defs>
                {/* Globe Circle Background */}
                <circle cx="50" cy="50" r="45" fill="#f8fafc" />

                {/* Speech Bubble Globe Pattern - Simplified SVG Representation */}
                <path d="M50 15 C60 15, 65 20, 65 28 C65 35, 60 40, 50 40 L45 45 L45 40 C35 40, 30 35, 30 28 C30 20, 35 15, 50 15" fill="url(#logo-gradient)" transform="scale(0.8) translate(12, 5)" opacity="0.9" />
                <path d="M75 45 C82 45, 87 48, 87 53 C87 57, 82 60, 75 60 L72 63 L72 60 C65 60, 60 57, 60 53 C60 48, 65 45, 75 45" fill="#3b82f6" transform="scale(0.7) translate(10, 35)" opacity="0.8" />
                <path d="M25 55 C32 55, 37 58, 37 63 C37 67, 32 70, 25 70 L22 73 L22 70 C15 70, 10 67, 10 63 C10 58, 15 55, 25 55" fill="#2dd4bf" transform="scale(0.7) translate(5, 45)" opacity="0.8" />
                <path d="M50 65 C62 65, 70 70, 70 80 C70 88, 62 93, 50 93 L45 98 L45 93 C32 93, 25 88, 25 80 C25 70, 32 65, 50 65" fill="#818cf8" transform="scale(0.6) translate(33, 75)" opacity="0.7" />
            </svg>
        </div>
    );
};
