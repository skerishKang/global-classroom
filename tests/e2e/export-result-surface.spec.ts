import { test, expect, Page } from '@playwright/test';

/**
 * Issue #66 — the export surface reports Drive/Docs/Classroom outcomes in one
 * non-blocking result surface instead of a blocking `alert()`, and a successful
 * Drive backup no longer opens the folder tab by itself.
 *
 * Every Google endpoint is mocked, so no live Google API is called. Runs on both
 * the desktop and the Pixel 5 project, which covers the mobile layout.
 */

const SESSION_FOLDER_ID = 'e2e-session-folder';
const DRIVE_FOLDER_URL = `https://drive.google.com/drive/folders/${SESSION_FOLDER_ID}`;
const DOC_ID = 'e2eDocIdentifier';

const openExportMenu = async (page: Page) => {
    const trigger = page.locator('header').getByRole('button', { name: /내보내기/ });
    await expect(trigger).toBeVisible({ timeout: 15000 });
    await trigger.click();
};

const chooseExport = async (page: Page, label: string) => {
    await openExportMenu(page);
    await page.getByRole('button', { name: label, exact: true }).click();
};

/** Seed a Google session so the export path does not fall back to the login modal. */
const signInWithFakeGoogleSession = async (page: Page) => {
    await page.addInitScript(() => {
        window.sessionStorage.setItem('google_access_token', 'e2e-fake-access-token');
        window.sessionStorage.setItem(
            'google_user',
            JSON.stringify({
                uid: 'e2e-user',
                displayName: 'E2E User',
                email: 'e2e@example.com',
                isAnonymous: false,
                providerId: 'google.com',
            }),
        );
    });
};

const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
});

/** Folder lookups come back empty so every folder is created through the mock. */
const mockDriveBackup = async (page: Page) => {
    await page.route('**/www.googleapis.com/drive/v3/files**', async (route) => {
        const request = route.request();
        if (request.method() === 'POST') {
            return route.fulfill(json({ id: SESSION_FOLDER_ID }));
        }
        return route.fulfill(json({ files: [] }));
    });

    await page.route('**/www.googleapis.com/upload/drive/v3/files**', async (route) => {
        return route.fulfill(json({ id: 'e2e-uploaded-file', name: 'transcript.txt' }));
    });
};

const mockDocsExport = async (page: Page, options: { createFails?: boolean } = {}) => {
    await page.route('**/docs.googleapis.com/v1/documents**', async (route) => {
        if (route.request().url().includes('batchUpdate')) {
            return route.fulfill(json({ replies: [] }));
        }
        if (options.createFails) {
            return route.fulfill(json({ error: { message: 'forbidden' } }, 403));
        }
        return route.fulfill(json({ documentId: DOC_ID }));
    });
};

const mockClassroom = async (page: Page, options: { submitFails?: boolean } = {}) => {
    await page.route('**/classroom.googleapis.com/v1/courses?courseStates=ACTIVE**', async (route) => {
        return route.fulfill(json({ courses: [{ id: 'course-1', name: 'E2E 수업', section: '1부' }] }));
    });

    await page.route('**/classroom.googleapis.com/v1/courses/course-1/courseWork**', async (route) => {
        if (options.submitFails) {
            return route.fulfill(json({ error: { message: 'quotaExceeded' } }, 500));
        }
        return route.fulfill(json({ id: 'coursework-1' }));
    });
};

/**
 * Records any blocking dialog so a regression back to `alert()` fails the test
 * instead of silently blocking the run.
 */
const watchDialogs = (page: Page): string[] => {
    const dialogs: string[] = [];
    page.on('dialog', async (dialog) => {
        dialogs.push(`${dialog.type()}: ${dialog.message()}`);
        await dialog.dismiss();
    });
    return dialogs;
};

test.describe('export result surface (#66)', () => {
    test('드라이브 백업 성공은 알림 없이 결과 화면에서 폴더를 직접 연다', async ({ page, context }) => {
        const dialogs = watchDialogs(page);
        await signInWithFakeGoogleSession(page);
        await mockDriveBackup(page);
        // The destination tab is only reachable through the explicit action, so
        // it is stubbed at context level to prove the click actually navigates.
        await context.route('https://drive.google.com/**', async (route) => {
            return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub drive folder</title>' });
        });
        await page.goto('/', { waitUntil: 'domcontentloaded' });

        await chooseExport(page, 'Google Drive 백업');

        const surface = page.getByTestId('export-result-surface');
        await expect(surface).toBeVisible({ timeout: 15000 });
        await expect(surface).toContainText('Drive 백업 완료');

        const action = page.getByTestId('export-result-action');
        await expect(action).toHaveText('Drive 폴더 열기');
        await expect(action).toHaveAttribute('href', DRIVE_FOLDER_URL);
        await expect(action).toHaveAttribute('target', '_blank');
        await expect(action).toHaveAttribute('rel', 'noopener noreferrer');

        // No automatic popup, no blocking dialog.
        expect(dialogs).toEqual([]);
        expect(context.pages()).toHaveLength(1);

        const popupPromise = context.waitForEvent('page');
        await action.click();
        const popup = await popupPromise;
        await popup.waitForLoadState('domcontentloaded');
        expect(popup.url()).toBe(DRIVE_FOLDER_URL);
    });

    test('Docs 저장 성공은 생성된 문서를 여는 동작을 노출한다', async ({ page, context }) => {
        const dialogs = watchDialogs(page);
        await signInWithFakeGoogleSession(page);
        await mockDocsExport(page);
        await page.goto('/', { waitUntil: 'domcontentloaded' });

        await chooseExport(page, 'Google Docs 저장');

        const surface = page.getByTestId('export-result-surface');
        await expect(surface).toBeVisible({ timeout: 15000 });
        await expect(surface).toContainText('Google Docs 저장 완료');

        const action = page.getByTestId('export-result-action');
        await expect(action).toHaveText('문서 열기');
        await expect(action).toHaveAttribute('href', `https://docs.google.com/document/d/${DOC_ID}/edit`);
        expect(dialogs).toEqual([]);
        expect(context.pages()).toHaveLength(1);
    });

    test('Docs 저장이 실패하면 성공으로 알리지 않고 로컬 다운로드를 알린다', async ({ page }) => {
        const dialogs = watchDialogs(page);
        await signInWithFakeGoogleSession(page);
        await mockDocsExport(page, { createFails: true });

        const downloadPromise = page.waitForEvent('download');
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await chooseExport(page, 'Google Docs 저장');

        const surface = page.getByTestId('export-result-surface');
        await expect(surface).toBeVisible({ timeout: 15000 });
        await expect(surface).toContainText('텍스트 파일로만 저장됨');
        await expect(surface).toContainText('Google Docs에 저장하지 못했습니다');
        await expect(surface).toContainText('텍스트 파일로 다운로드');
        await expect(page.getByTestId('export-result-action')).toHaveCount(0);

        const download = await downloadPromise;
        expect(download.suggestedFilename()).toMatch(/^GlobalClassroom_Transcript_/);
        expect(dialogs).toEqual([]);
    });

    test('Google 로그인이 없으면 Docs 대신 로컬 파일만 다운로드했다고 알린다', async ({ page }) => {
        const dialogs = watchDialogs(page);
        await mockDocsExport(page);
        await page.addInitScript(() => { window.sessionStorage.clear(); });

        const downloadPromise = page.waitForEvent('download');
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await chooseExport(page, 'Google Docs 저장');

        const surface = page.getByTestId('export-result-surface');
        await expect(surface).toBeVisible({ timeout: 15000 });
        await expect(surface).toContainText('Google 로그인 상태가 아니어서');
        await expect(surface).toContainText('텍스트 파일로 다운로드');
        await expect(page.getByTestId('export-result-action')).toHaveCount(0);

        await downloadPromise;
        expect(dialogs).toEqual([]);
    });

    test('Classroom 제출 성공과 실패 모두 결과 화면으로 보고한다', async ({ page }) => {
        const dialogs = watchDialogs(page);
        await signInWithFakeGoogleSession(page);
        await mockClassroom(page);
        await page.goto('/', { waitUntil: 'domcontentloaded' });

        await chooseExport(page, 'Classroom 제출');
        await page.getByRole('button', { name: /E2E 수업/ }).click();

        const surface = page.getByTestId('export-result-surface');
        await expect(surface).toBeVisible({ timeout: 15000 });
        await expect(surface).toContainText('Classroom 제출 완료');
        await expect(page.getByTestId('export-result-action')).toHaveCount(0);
        expect(dialogs).toEqual([]);
    });

    test('Classroom 제출 실패는 알림 대신 오류 결과 화면을 띄운다', async ({ page }) => {
        const dialogs = watchDialogs(page);
        await signInWithFakeGoogleSession(page);
        await mockClassroom(page, { submitFails: true });
        await page.goto('/', { waitUntil: 'domcontentloaded' });

        await chooseExport(page, 'Classroom 제출');
        await page.getByRole('button', { name: /E2E 수업/ }).click();

        const surface = page.getByTestId('export-result-surface');
        await expect(surface).toBeVisible({ timeout: 15000 });
        await expect(surface).toContainText('내보내기 실패');
        await expect(surface).toContainText('Classroom 제출 실패');
        await expect(page.getByTestId('export-result-action')).toHaveCount(0);
        expect(dialogs).toEqual([]);
    });

    test('결과 화면은 닫기 버튼으로 사라지고 다시 열 수 있다', async ({ page }) => {
        const dialogs = watchDialogs(page);
        await signInWithFakeGoogleSession(page);
        await mockDocsExport(page);
        await page.goto('/', { waitUntil: 'domcontentloaded' });

        await chooseExport(page, 'Google Docs 저장');
        const surface = page.getByTestId('export-result-surface');
        await expect(surface).toBeVisible({ timeout: 15000 });

        await surface.getByRole('button', { name: '닫기' }).click();
        await expect(surface).toHaveCount(0);

        await chooseExport(page, 'Google Docs 저장');
        await expect(surface).toBeVisible();
        expect(dialogs).toEqual([]);
    });
});