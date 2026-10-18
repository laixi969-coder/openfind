import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkLink, parseWorkLinks, allowedWorkNavigation } from '../shared/work-links.ts';
import {
  linkedWorkFromPayload,
  linkedWorkFromHydration,
} from '../server/platforms/linked-work-page.ts';
const xhs = 'abcdef0123456789abcdef01',
  dy = '7654321098765432109';
test('Share text supports signed notes, Douyin modal IDs, short links and exact numeric identities', () => {
  const notes = parseWorkLinks(
    `产品分享 http://www.xiaohongshu.com/discovery/item/${xhs}?xsec_token=signature%2Bvalue&xsec_source=app_share 复制到小红书`,
  );
  assert.equal(
    notes[0].url,
    `https://www.xiaohongshu.com/explore/${xhs}?xsec_token=signature%2Bvalue&xsec_source=app_share`,
  );
  assert.equal(parseWorkLink(`https://www.douyin.com/jingxuan?modal_id=${dy}`).nativeId, dy);
  assert.equal(parseWorkLink('https://xhslink.com/a/test123').short, true);
  assert.equal(parseWorkLink('https://v.douyin.com/test123/').platform, 'douyin');
  assert.equal(parseWorkLink(`https://www.iesdouyin.com/share/video/${dy}/`).nativeId, dy);
});
test('Batches deduplicate work IDs, accept five, reject six and require one platform', () => {
  assert.equal(
    parseWorkLinks(`https://www.douyin.com/video/${dy}\nhttps://www.douyin.com/?modal_id=${dy}`)
      .length,
    1,
  );
  const urls = Array.from(
    { length: 6 },
    (_, i) => `https://www.douyin.com/video/765432109876543210${i}`,
  );
  assert.equal(parseWorkLinks(urls.slice(0, 5).join('\n')).length, 5);
  assert.throws(() => parseWorkLinks(urls.join('\n')), /最多 5/);
  assert.throws(
    () =>
      parseWorkLinks(
        `https://www.xiaohongshu.com/explore/${xhs} https://www.douyin.com/video/${dy}`,
      ),
    /分开执行/,
  );
});
test('Only official work URLs are accepted and redirect navigation cannot reach other sites or local services', () => {
  for (const url of [
    'file:///etc/passwd',
    'http://127.0.0.1:8791/api/state',
    'https://www.douyin.com.evil.test/video/' + dy,
    'https://evil.test/?url=https://www.douyin.com',
    'https://name:password@www.douyin.com/video/' + dy,
    'https://www.douyin.com:8080/video/' + dy,
    'https://www.douyin.com/user/someone',
    'https://www.xiaohongshu.com/search_result?keyword=test',
    'https://live.douyin.com/123',
  ])
    assert.throws(() => parseWorkLink(url));
  assert.equal(allowedWorkNavigation('douyin', 'https://www.douyin.com/video/' + dy), true);
  assert.equal(
    allowedWorkNavigation('douyin', 'https://www.xiaohongshu.com/explore/' + xhs),
    false,
  );
  assert.equal(allowedWorkNavigation('xiaohongshu', 'http://127.0.0.1/test'), false);
});
test('Details and hydration must match the specified work, never the first recommendation', () => {
  const link = parseWorkLink('https://www.douyin.com/video/' + dy);
  const a = {
    aweme_id: dy,
    author: { sec_uid: 'controlled-author', nickname: 'test' },
    desc: '真实作品',
    create_time: 1760000000,
  };
  assert.equal(linkedWorkFromPayload(link, { aweme_detail: a })?.nativeId, dy);
  assert.equal(
    linkedWorkFromPayload(link, { aweme_detail: { ...a, aweme_id: '9999999999999999999' } }),
    undefined,
  );
  assert.equal(
    linkedWorkFromHydration(link, {
      page: { recommendations: [{ ...a, aweme_id: '1111111111111111111' }, a] },
    })?.authorId,
    'controlled-author',
  );
  const xl = parseWorkLink('https://www.xiaohongshu.com/explore/' + xhs);
  assert.equal(
    linkedWorkFromHydration(xl, {
      [xhs]: { note: { noteId: xhs, title: '沙发', user: { userId: 'test-author' } } },
    })?.nativeId,
    xhs,
  );
  assert.equal(
    linkedWorkFromHydration(xl, {
      [xhs]: { note: { noteId: 'ffffffffffffffffffffffff', title: 'wrong' } },
    }),
    undefined,
  );
});

test('Short redirects validate each hop before requesting it and stop loops or expired links', async () => {
  const { resolveWorkRedirects } = await import('../server/platforms/work-redirects.ts');
  const calls: string[] = [];
  const short = parseWorkLink('https://v.douyin.com/test/');
  const resolved = await resolveWorkRedirects(short, async (url) => {
    calls.push(url);
    return { status: 302, location: 'https://www.douyin.com/video/' + dy };
  });
  assert.equal(resolved.nativeId, dy);
  assert.equal(calls.length, 1);
  calls.length = 0;
  await assert.rejects(
    () =>
      resolveWorkRedirects(short, async (url) => {
        calls.push(url);
        return { status: 302, location: 'http://127.0.0.1/secret' };
      }),
    /非平台官方/,
  );
  assert.deepEqual(calls, [short.url]);
  await assert.rejects(
    () => resolveWorkRedirects(short, async () => ({ status: 302, location: short.url })),
    /循环/,
  );
  await assert.rejects(() => resolveWorkRedirects(short, async () => ({ status: 200 })), /过期/);
});
