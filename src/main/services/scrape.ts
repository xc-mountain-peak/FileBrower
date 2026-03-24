import { chromium } from 'playwright';
import type { PageSnapshot, RuleRecord } from '../../shared/types';

export async function tryScrapePage(url: string, rules: RuleRecord[]): Promise<PageSnapshot> {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const title = await page.title();
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const extracted = await Promise.all(
      rules
        .filter((rule) => rule.enabled)
        .map(async (rule) => {
          if (rule.selector === 'title') {
            return `${rule.fieldName}: ${title || rule.defaultValue}`;
          }

          const value = await page.locator(rule.selector).first().textContent().catch(() => '');
          return `${rule.fieldName}: ${value?.trim() || rule.defaultValue}`;
        }),
    );

    const mergedContent = [
      `Title: ${title}`,
      `URL: ${url}`,
      bodyText ? `Body: ${bodyText.slice(0, 4000)}` : 'Body: ',
      extracted.length > 0 ? `Rules:\n${extracted.map((line) => `  - ${line}`).join('\n')}` : 'Rules: none',
    ].join('\n');

    return {
      url,
      title,
      content: mergedContent,
    };
  } finally {
    await browser.close();
  }
}
