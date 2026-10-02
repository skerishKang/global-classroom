document.addEventListener('DOMContentLoaded', () => {
    const slides = document.querySelectorAll('.slide');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const currentStepText = document.getElementById('currentStep');
    const progressFill = document.getElementById('progressFill');

    let currentStep = 1;
    const totalSteps = slides.length;

    function updateTutorial() {
        // Update Slides
        slides.forEach((slide, index) => {
            slide.classList.remove('active');
            if (index === currentStep - 1) {
                slide.classList.add('active');
            }
        });

        // Update Text & Progress
        currentStepText.textContent = currentStep;
        const progressPercent = (currentStep / totalSteps) * 100;
        progressFill.style.width = `${progressPercent}%`;

        // Update Buttons
        prevBtn.disabled = currentStep === 1;

        if (currentStep === totalSteps) {
            nextBtn.textContent = '완료';
            nextBtn.classList.add('finish');
        } else {
            nextBtn.textContent = '다음';
            nextBtn.classList.remove('finish');
        }

        // Aesthetics for "Under Development" step
        if (currentStep === 8) {
            nextBtn.style.background = 'linear-gradient(135deg, #fbbf24, #f59e0b)';
        } else {
            nextBtn.style.background = '';
        }
    }

    nextBtn.addEventListener('click', () => {
        if (currentStep < totalSteps) {
            currentStep++;
            updateTutorial();
        } else {
            // Final action or celebration
            nextBtn.style.opacity = '0.5';
            nextBtn.innerHTML = '✨ 준비 완료';
            setTimeout(() => {
                const confirmMove = confirm('모바일 상세 가이드를 마쳤습니다. 메인 사이트로 이동하시겠습니까?');
                if (confirmMove) {
                    window.location.href = 'https://7-global-classroom.netlify.app/';
                }
            }, 500);
        }
    });

    prevBtn.addEventListener('click', () => {
        if (currentStep > 1) {
            currentStep--;
            updateTutorial();
        }
    });

    // Add keyboard navigation
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') nextBtn.click();
        if (e.key === 'ArrowLeft') prevBtn.click();
    });
});
