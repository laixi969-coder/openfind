import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('XHS hover-panel obstruction activates its visible option and does not silently use general sort', async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'openfind-filter-test-'));
  process.env.OPENFIND_DATA_DIR = dir;
  const { applyFilters } = await import('../../server/platforms/browser');
  const { db } = await import('../../server/store');
  try {
    await page.setContent(`<button style="position:absolute;top:10px;left:10px" onmouseover="document.querySelector('#panel').style.display='block'">筛选</button>
      <div id="panel" style="display:none;position:absolute;top:90px;left:10px"><span onclick="document.body.dataset.sort='latest'">最新</span></div>
      <div style="position:absolute;top:80px;left:0;width:200px;height:60px;background:transparent"></div>`);
    let cleared = 0;
    await applyFilters(
      page,
      'xiaohongshu',
      {
        keyword: '沙发',
        platform: 'xiaohongshu',
        mode: 'demo',
        sort: 'latest',
        noteType: 'all',
        limit: 4,
        interval: 15000,
      },
      () => {
        cleared++;
      },
    );
    await expect(page.locator('body')).toHaveAttribute('data-sort', 'latest');
    expect(cleared).toBeGreaterThan(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
