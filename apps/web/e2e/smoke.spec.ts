import { expect, test } from '@playwright/test';

/**
 * The deployment smoke test. It checks that the app is up, that the sign-in path is wired to
 * Google, and — importantly — that the protected pages are actually protected.
 *
 * It deliberately does not sign in: driving Google OAuth from CI is brittle and buys little
 * that the server-side tests do not already cover.
 */

test('the landing page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'ChessEdu' })).toBeVisible();
  await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
});

test('the dashboard is not reachable while signed out', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL('/');
});

test('the accounts page is not reachable while signed out', async ({ page }) => {
  await page.goto('/link');
  await expect(page).toHaveURL('/');
});

test('sign-in hands off to Google', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /continue with google/i }).click();
  await page.waitForURL(/accounts\.google\.com/, { timeout: 15_000 });
});
