import { test, expect } from '@playwright/test';

test.describe('AI Interview Interpreter', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/translate', async (route) => {
      const request = route.request();
      const body = request.postDataJSON() as { text?: string; from?: string; to?: string };
      const translated =
        body?.from === 'Korean'
          ? 'I build AI systems that help people communicate complex ideas clearly.'
          : '저는 복잡한 기술 문제를 어떻게 해결하는지 설명해 주세요.';

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ translated, provider: 'test', model: 'test' }),
      });
    });

    await page.goto('/?mode=interview', { waitUntil: 'domcontentloaded' });
  });

  test('opens as a dedicated interview interpreter without login flow', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'AI Interview Interpreter' })).toBeVisible();
    await expect(page.getByText('한국어로 답변')).toBeVisible();
    await expect(page.getByText('English answer')).toBeVisible();
    await expect(page.getByText('영어 질문 → 한국어 확인')).toBeVisible();
    await expect(page.getByRole('button', { name: '한국어 말하기' })).toBeVisible();
  });

  test('translates a Korean answer to English and supports spotlight view', async ({ page }) => {
    const answer = page.getByPlaceholder('여기에 한국어로 답하거나 마이크 버튼을 누르세요.');
    await answer.fill('저는 복잡한 AI 시스템을 실제 제품으로 만드는 일을 해왔습니다.');
    await page.getByRole('button', { name: '영어로 전달' }).click();

    await expect(
      page.getByText('I build AI systems that help people communicate complex ideas clearly.')
    ).toBeVisible();

    await page.getByRole('button', { name: '크게 보여주기' }).click();
    await expect(page.getByText('AI Interview Interpreter').last()).toBeVisible();
    await expect(
      page.getByText('I build AI systems that help people communicate complex ideas clearly.').last()
    ).toBeVisible();
  });

  test('loads the interview disclosure statement without an API call', async ({ page }) => {
    await page.getByRole('button', { name: '시작 안내문 불러오기' }).click();

    await expect(
      page.getByText(/I can communicate in English, but for complex technical topics/)
    ).toBeVisible();
    await expect(
      page.getByDisplayValue(/저는 영어로 기본적인 소통은 가능하지만/)
    ).toBeVisible();
  });

  test('translates an interviewer question from English to Korean', async ({ page }) => {
    const question = page.getByPlaceholder(
      '면접관의 영어 질문을 붙여넣거나 영어 음성 인식을 사용하세요.'
    );
    await question.fill('Tell me how you solve a difficult technical problem.');
    await page.getByRole('button', { name: '한국어로 이해' }).click();

    await expect(
      page.getByText('저는 복잡한 기술 문제를 어떻게 해결하는지 설명해 주세요.')
    ).toBeVisible();
  });
});
