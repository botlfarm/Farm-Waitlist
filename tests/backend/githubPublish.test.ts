import fs from 'fs';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExpressApp } from '../../src/server/app';
import { loadRuntimeConfig } from '../../src/server/config';
import { DatabaseManager } from '../../src/server/db';
import {
  computeAvailabilityPayloadHash,
  deriveGithubPagesPublicUrl,
  publishAvailabilityToGithub,
  testGithubPublishConnection,
  validateGithubTarget,
} from '../../src/server/githubPublisher';
import {
  buildPublicAvailabilityJsonPayload,
  evaluateDateOrderingClosed,
  generateLiveEmbedHtml,
  generatePublicAvailability,
} from '../../src/shared/generators';
import { projectDailySupply } from '../../src/shared/supplyEngine';
import type { SnippetCutoffRule, TrackedItem } from '../../src/shared/types';

const tmpDirs: string[] = [];

function createTempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-waitlist-gh-test-'));
  tmpDirs.push(dir);
  return {
    dir,
    dbPath: path.join(dir, 'waitlist.db'),
    backupDir: path.join(dir, 'backups'),
  };
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const eggsItem: TrackedItem = {
  id: 1,
  name: 'Standard Eggs',
  unitLabel: 'dozens',
  isActive: true,
  supplyMode: 'continuous',
  defaultDailyProduction: 12,
  globalSafetyBuffer: 4,
  includeInPublicSnippet: true,
  keywordRules: ['eggs'],
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
};

describe('Public Snippet Flexible Cutoffs, Paused Mode & Dimmed Mobile Past Days', () => {
  it('evaluates same-day hide, N-days-before cutoffs (0/1/2 days), and weekly-day cutoffs (e.g., Friday 4pm for Sat/Sun)', () => {
    const dayBefore4pm: SnippetCutoffRule = {
      id: 'r1',
      enabled: true,
      mode: 'days_before',
      daysBefore: 1,
      cutoffWeekday: 5,
      cutoffTime: '16:00',
      pickupWeekdays: [],
    };

    // Today = Tue 2026-11-24 at 15:59 -> Tomorrow (Wed 2026-11-25) is STILL OPEN
    expect(
      evaluateDateOrderingClosed({
        pickupDate: '2026-11-25',
        today: '2026-11-24',
        currentTimeHHMM: '15:59',
        showSameDay: true,
        cutoffRules: [dayBefore4pm],
      })
    ).toBe(false);

    // Today = Tue 2026-11-24 at 16:00 -> Tomorrow (Wed 2026-11-25) is CLOSED, Thu 2026-11-26 is OPEN
    expect(
      evaluateDateOrderingClosed({
        pickupDate: '2026-11-25',
        today: '2026-11-24',
        currentTimeHHMM: '16:00',
        showSameDay: true,
        cutoffRules: [dayBefore4pm],
      })
    ).toBe(true);
    expect(
      evaluateDateOrderingClosed({
        pickupDate: '2026-11-26',
        today: '2026-11-24',
        currentTimeHHMM: '16:00',
        showSameDay: true,
        cutoffRules: [dayBefore4pm],
      })
    ).toBe(false);

    // Same-day availability turned off -> Today is CLOSED even with no cutoff rules
    expect(
      evaluateDateOrderingClosed({
        pickupDate: '2026-11-24',
        today: '2026-11-24',
        currentTimeHHMM: '08:00',
        showSameDay: false,
        cutoffRules: [],
      })
    ).toBe(true);

    // 2 days before at 16:00 -> On Tue 16:05, both Wed (1 day out) and Thu (2 days out) are CLOSED; Fri is OPEN
    const twoDaysBefore4pm: SnippetCutoffRule = {
      id: 'r2',
      enabled: true,
      mode: 'days_before',
      daysBefore: 2,
      cutoffWeekday: 5,
      cutoffTime: '16:00',
      pickupWeekdays: [],
    };
    expect(
      evaluateDateOrderingClosed({
        pickupDate: '2026-11-26',
        today: '2026-11-24',
        currentTimeHHMM: '16:05',
        showSameDay: true,
        cutoffRules: [twoDaysBefore4pm],
      })
    ).toBe(true);
    expect(
      evaluateDateOrderingClosed({
        pickupDate: '2026-11-27',
        today: '2026-11-24',
        currentTimeHHMM: '16:05',
        showSameDay: true,
        cutoffRules: [twoDaysBefore4pm],
      })
    ).toBe(false);

    // Weekly cutoff: Every Friday (ISO 5) at 16:00 closes Saturday (6) & Sunday (7) pickups
    const fridayWeekendCutoff: SnippetCutoffRule = {
      id: 'r3',
      enabled: true,
      mode: 'weekly_day',
      daysBefore: 1,
      cutoffWeekday: 5, // Friday
      cutoffTime: '16:00',
      pickupWeekdays: [6, 7], // Sat & Sun
    };

    // On Fri 2026-11-27 at 15:30 -> Sat Nov 28 & Sun Nov 29 still OPEN
    expect(
      evaluateDateOrderingClosed({
        pickupDate: '2026-11-28',
        today: '2026-11-27',
        currentTimeHHMM: '15:30',
        showSameDay: true,
        cutoffRules: [fridayWeekendCutoff],
      })
    ).toBe(false);

    // On Fri 2026-11-27 at 16:01 -> Sat Nov 28 & Sun Nov 29 CLOSED, Mon Nov 30 OPEN, next Sat Dec 5 OPEN
    expect(
      evaluateDateOrderingClosed({
        pickupDate: '2026-11-28',
        today: '2026-11-27',
        currentTimeHHMM: '16:01',
        showSameDay: true,
        cutoffRules: [fridayWeekendCutoff],
      })
    ).toBe(true);
    expect(
      evaluateDateOrderingClosed({
        pickupDate: '2026-11-29',
        today: '2026-11-27',
        currentTimeHHMM: '16:01',
        showSameDay: true,
        cutoffRules: [fridayWeekendCutoff],
      })
    ).toBe(true);
    expect(
      evaluateDateOrderingClosed({
        pickupDate: '2026-11-30',
        today: '2026-11-27',
        currentTimeHHMM: '16:01',
        showSameDay: true,
        cutoffRules: [fridayWeekendCutoff],
      })
    ).toBe(false);
    expect(
      evaluateDateOrderingClosed({
        pickupDate: '2026-12-05',
        today: '2026-11-27',
        currentTimeHHMM: '16:01',
        showSameDay: true,
        cutoffRules: [fridayWeekendCutoff],
      })
    ).toBe(false);
  });

  it('keeps past days visible (dimmed) on mobile CSS, renders Ordering Closed badges, and renders Paused mode cleanly', () => {
    // Today = Wed 2026-11-25 at 17:00 EST (22:00 UTC)
    const days = projectDailySupply({
      items: [eggsItem],
      entries: [],
      orders: [],
      startDate: '2026-11-23',
      endDate: '2026-12-06',
      today: '2026-11-25',
    });

    const active = generatePublicAvailability({
      items: [eggsItem],
      days,
      channels: [],
      today: '2026-11-25',
      weeks: 2,
      timezone: 'America/New_York',
      now: new Date('2026-11-25T22:00:00Z'), // 17:00 EST
      showSameDay: false,
      cutoffRules: [
        {
          id: 'c1',
          enabled: true,
          mode: 'days_before',
          daysBefore: 1,
          cutoffWeekday: 5,
          cutoffTime: '16:00',
          pickupWeekdays: [],
        },
      ],
    });

    // Mobile CSS must NOT hide .fw-cal-past with display:none!
    const mobileBlock = active.html.split('@media (max-width:640px)')[1] ?? '';
    expect(mobileBlock).not.toContain('.fw-cal-past{display:none}');
    expect(active.html).toContain('fw-cal-past-tag');

    // Today (Nov 25, showSameDay=false) & Tomorrow (Nov 26, past 4pm day-before cutoff) are Ordering Closed; Fri Nov 27 is open
    const wed = active.calendarDays.find((d) => d.date === '2026-11-25');
    const thu = active.calendarDays.find((d) => d.date === '2026-11-26');
    const fri = active.calendarDays.find((d) => d.date === '2026-11-27');
    expect(wed?.isOrderingClosed).toBe(true);
    expect(thu?.isOrderingClosed).toBe(true);
    expect(fri?.isOrderingClosed).toBe(false);
    expect(active.html).toContain('Ordering Closed');

    // Paused mode replaces calendar grid with safe notice (and blocks script injection)
    const paused = generatePublicAvailability({
      items: [eggsItem],
      days,
      channels: [],
      today: '2026-11-25',
      weeks: 2,
      timezone: 'America/New_York',
      now: new Date('2026-11-25T22:00:00Z'),
      enabled: false,
      pausedMessage:
        'Availability is unknown — visit <a href="https://example.com/shop">our farm</a> <script>alert(1)</script>',
    });

    expect(paused.paused).toBe(true);
    expect(paused.html).toContain('fw-cal-paused');
    expect(paused.html).toContain('https://example.com/shop');
    expect(paused.html).not.toContain('<script>alert(1)</script>');
    expect(paused.html).not.toContain('<div class="fw-cal-grid">');

    const pausedJson = buildPublicAvailabilityJsonPayload(paused, new Date('2026-11-25T22:00:00Z'));
    expect(pausedJson.paused).toBe(true);
    expect(pausedJson.calendarDays).toEqual([]);
  });

  it('generates Live Embed HTML with zero innerHTML and validates URLs strictly', () => {
    expect(generateLiveEmbedHtml('javascript:alert(1)')).toBe('');
    const embed = generateLiveEmbedHtml('https://myfarm.github.io/farm-availability/availability.json');
    expect(embed).toContain('data-fw-src="https://myfarm.github.io/farm-availability/availability.json"');
    expect(embed).toContain('document.createElement');
    expect(embed).not.toContain('innerHTML');
    expect(embed).not.toContain('outerHTML');
  });
});

describe('Open-Source GitHub Pages Publisher & API Routes', () => {
  it('validates user-configured repos/paths and derives GitHub Pages URLs with zero hardcoded repo', () => {
    expect(deriveGithubPagesPublicUrl('MyFarm/egg-calendar', 'availability.json')).toBe(
      'https://myfarm.github.io/egg-calendar/availability.json'
    );
    expect(deriveGithubPagesPublicUrl('myfarm/myfarm.github.io', 'data/availability.json')).toBe(
      'https://myfarm.github.io/data/availability.json'
    );
    expect(
      deriveGithubPagesPublicUrl('myfarm/egg-calendar', 'availability.json', 'https://availability.myfarm.com/live.json')
    ).toBe('https://availability.myfarm.com/live.json');
    expect(
      deriveGithubPagesPublicUrl('myfarm/egg-calendar', 'availability.json', 'javascript:alert(1)')
    ).toBeNull();
    expect(() => validateGithubTarget({ repo: '../bad/repo' })).toThrow(/valid GitHub repository/i);
    expect(() => validateGithubTarget({ repo: 'myfarm/avail', filePath: '../secret.json' })).toThrow(
      /Invalid file path/i
    );
  });

  it('creates new file on 404, updates existing SHA, skips unchanged semantic payloads, and reports 401/403 cleanly', async () => {
    const days = projectDailySupply({
      items: [eggsItem],
      entries: [],
      orders: [],
      startDate: '2026-11-23',
      endDate: '2026-11-29',
      today: '2026-11-23',
    });

    const snap1 = generatePublicAvailability({
      items: [eggsItem],
      days,
      channels: [],
      today: '2026-11-23',
      weeks: 1,
      timezone: 'America/New_York',
      now: new Date('2026-11-23T14:00:00Z'),
    });
    const payload1 = buildPublicAvailabilityJsonPayload(snap1, new Date('2026-11-23T14:00:00Z'));

    // Same semantic availability 30 minutes later -> hash must be IDENTICAL!
    const snap2 = generatePublicAvailability({
      items: [eggsItem],
      days,
      channels: [],
      today: '2026-11-23',
      weeks: 1,
      timezone: 'America/New_York',
      now: new Date('2026-11-23T14:30:00Z'),
    });
    const payload2 = buildPublicAvailabilityJsonPayload(snap2, new Date('2026-11-23T14:30:00Z'));

    expect(computeAvailabilityPayloadHash(payload1)).toBe(computeAvailabilityPayloadHash(payload2));

    // 1. First publish: GET returns 404 (file doesn't exist yet), PUT creates it without sha
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const createFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (method === 'GET') {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ commit: { sha: 'abc1234' } }), { status: 201 });
    }) as unknown as typeof fetch;

    const firstRes = await publishAvailabilityToGithub({
      token: 'ghp_test_token',
      repo: 'openfarm/live-avail',
      branch: 'main',
      filePath: 'availability.json',
      payload: payload1,
      force: false,
      fetchFn: createFetch,
    });

    expect(firstRes.published).toBe(true);
    expect(firstRes.skipped).toBe(false);
    expect(firstRes.commitSha).toBe('abc1234');
    expect(firstRes.readmeCreated).toBe(true);
    expect(firstRes.publicUrl).toBe('https://openfarm.github.io/live-avail/availability.json');
    expect(calls[1].url).toBe('https://api.github.com/repos/openfarm/live-avail/contents/availability.json');
    const putPayload = JSON.parse(calls[1].body!);
    expect(putPayload.sha).toBeUndefined();
    const decodedJson = JSON.parse(Buffer.from(putPayload.content, 'base64').toString('utf-8'));
    expect(decodedJson.version).toBe(1);
    expect(decodedJson.paused).toBe(false);

    // Since /readme returned 404, a friendly default README.md must have been created without overwriting
    const readmePutCall = calls.find(
      (c) => c.method === 'PUT' && c.url.endsWith('/contents/README.md')
    );
    expect(readmePutCall).toBeTruthy();
    const readmePutPayload = JSON.parse(readmePutCall!.body!);
    expect(readmePutPayload.sha).toBeUndefined();
    const decodedReadme = Buffer.from(readmePutPayload.content, 'base64').toString('utf-8');
    expect(decodedReadme).toContain('Public Availability Data');
    expect(decodedReadme).toContain('https://openfarm.github.io/live-avail/availability.json');
    expect(decodedReadme).toContain('no customer names');

    // 2. Unchanged payload with force=false -> skips HTTP calls completely!
    const skipFetch = vi.fn() as unknown as typeof fetch;
    const skippedRes = await publishAvailabilityToGithub({
      token: 'ghp_test_token',
      repo: 'openfarm/live-avail',
      payload: payload2,
      previousHash: firstRes.hash,
      force: false,
      fetchFn: skipFetch,
    });
    expect(skippedRes.published).toBe(false);
    expect(skippedRes.skipped).toBe(true);
    expect(skipFetch).not.toHaveBeenCalled();

    // 3. Updating existing file includes existing sha AND leaves existing user README untouched
    const updateCalls: Array<{ url: string; method: string; body?: string }> = [];
    const updateFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      updateCalls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (method === 'GET') {
        return new Response(JSON.stringify({ sha: 'existing-file-sha-99' }), { status: 200 });
      }
      return new Response(JSON.stringify({ commit: { sha: 'def5678' } }), { status: 200 });
    }) as unknown as typeof fetch;

    const updatedRes = await publishAvailabilityToGithub({
      token: 'ghp_test_token',
      repo: 'openfarm/live-avail',
      payload: payload2,
      previousHash: firstRes.hash,
      force: true,
      fetchFn: updateFetch,
    });
    expect(updatedRes.published).toBe(true);
    expect(updatedRes.readmeCreated).toBe(false);
    expect(JSON.parse(updateCalls[1].body!).sha).toBe('existing-file-sha-99');
    expect(
      updateCalls.some((c) => c.method === 'PUT' && c.url.endsWith('/contents/README.md'))
    ).toBe(false);

    // 4. 401 unauthorized yields clear actionable diagnostic
    const unauthFetch = vi.fn(async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })) as unknown as typeof fetch;
    const testRes = await testGithubPublishConnection({
      token: 'bad_token',
      repo: 'openfarm/live-avail',
      fetchFn: unauthFetch,
    });
    expect(testRes.ok).toBe(false);
    expect(testRes.message).toContain('401 Unauthorized');
  });

  it('exposes /api/snippet/github/test and /api/snippet/github/publish without ever leaking the GitHub token', async () => {
    const { dbPath, backupDir } = createTempPaths();
    const dbManager = new DatabaseManager(dbPath, backupDir);
    await dbManager.init('America/New_York');

    const secretToken = 'github_pat_SUPER_SECRET_NEVER_LEAK_12345';
    const config = loadRuntimeConfig({
      dbPath,
      backupDir,
      haOptionsPath: '/nonexistent/options.json',
      githubPublish: {
        token: secretToken,
        defaultRepo: '',
        source: 'ha_options',
      },
    });

    const mockFetch = vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (input.endsWith('/repos/myfarm/avail') && method === 'GET') {
        return new Response(
          JSON.stringify({ full_name: 'myfarm/avail', private: false, permissions: { push: true } }),
          { status: 200 }
        );
      }
      if (input.includes('/branches/main') && method === 'GET') {
        return new Response(JSON.stringify({ name: 'main' }), { status: 200 });
      }
      if (input.includes('/contents/availability.json') && method === 'GET') {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      if (input.includes('/contents/availability.json') && method === 'PUT') {
        return new Response(JSON.stringify({ commit: { sha: 'commit-1' } }), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const app = createExpressApp({
      dbManager,
      config,
      fetchFn: mockFetch,
      getNow: () => new Date('2026-11-23T15:00:00Z'),
    });

    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      // Save user's repo & paused state
      const putResp = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicSnippetWeeks: 4,
          publicSnippetEnabled: false,
          publicSnippetPausedMessage: 'Availability is currently unknown.',
          githubPublishRepo: 'myfarm/avail',
          githubPublishMode: 'auto',
          githubPublishInterval: '1h',
        }),
      });
      expect(putResp.status).toBe(200);
      const putBody = (await putResp.json()) as Record<string, any>;

      expect(JSON.stringify(putBody)).not.toContain(secretToken);
      expect(putBody.githubPublishStatus.tokenConfigured).toBe(true);
      expect(putBody.githubPublishStatus.tokenSource).toBe('ha_options');
      expect(putBody.githubPublishStatus.publicUrl).toBe(
        'https://myfarm.github.io/avail/availability.json'
      );

      // Test connection endpoint
      const testResp = await fetch(`${baseUrl}/api/snippet/github/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'myfarm/avail', branch: 'main' }),
      });
      expect(testResp.status).toBe(200);
      const testBody = (await testResp.json()) as { ok: boolean };
      expect(testBody.ok).toBe(true);

      // Publish Now endpoint
      const pubResp = await fetch(`${baseUrl}/api/snippet/github/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      expect(pubResp.status).toBe(200);
      const pubBody = (await pubResp.json()) as Record<string, any>;
      expect(pubBody.published).toBe(true);
      expect(pubBody.githubPublishStatus.lastPublishStatus).toBe('success');
      expect(JSON.stringify(pubBody)).not.toContain(secretToken);

      // Snippet endpoint returns paused state & live embed code without leaking token
      const snipResp = await fetch(`${baseUrl}/api/snippet`);
      expect(snipResp.status).toBe(200);
      const snipBody = (await snipResp.json()) as Record<string, any>;
      expect(snipBody.weeks).toBe(4);
      expect(snipBody.paused).toBe(true);
      expect(snipBody.liveEmbedHtml).toContain('https://myfarm.github.io/avail/availability.json');
      expect(JSON.stringify(snipBody)).not.toContain(secretToken);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      dbManager.close();
    }
  });
});
