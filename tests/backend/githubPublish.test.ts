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
import { publishSnippetSnapshotToGithub } from '../../src/server/snippetService';
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

  it('auto-publish guardrails skip midnight/cutoff rollovers, defer during quiet cooldown after user edits, and publish once settled', async () => {
    const { dbPath, backupDir } = createTempPaths();
    const dbManager = new DatabaseManager(dbPath, backupDir);
    await dbManager.init('America/New_York');

    const config = loadRuntimeConfig({
      dbPath,
      backupDir,
      haOptionsPath: '/nonexistent/options.json',
      githubPublish: {
        token: 'ghp_guardrails_token',
        defaultRepo: 'myfarm/avail',
        source: 'env',
      },
    });

    // Clock-derived flags (isPast, isToday, isOrderingClosed) must NOT alter semantic hash
    const days = projectDailySupply({
      items: [eggsItem],
      entries: [],
      orders: [],
      startDate: '2026-11-23',
      endDate: '2026-11-29',
      today: '2026-11-23',
    });
    const beforeCutoff = buildPublicAvailabilityJsonPayload(
      generatePublicAvailability({
        items: [eggsItem],
        days,
        channels: [],
        today: '2026-11-23',
        weeks: 1,
        timezone: 'America/New_York',
        now: new Date('2026-11-23T19:00:00Z'), // 14:00 EST (before 16:00 cutoff)
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
      }),
      new Date('2026-11-23T19:00:00Z')
    );
    const afterCutoff = buildPublicAvailabilityJsonPayload(
      generatePublicAvailability({
        items: [eggsItem],
        days,
        channels: [],
        today: '2026-11-23',
        weeks: 1,
        timezone: 'America/New_York',
        now: new Date('2026-11-23T22:00:00Z'), // 17:00 EST (after 16:00 cutoff)
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
      }),
      new Date('2026-11-23T22:00:00Z')
    );
    expect(computeAvailabilityPayloadHash(beforeCutoff)).toBe(
      computeAvailabilityPayloadHash(afterCutoff)
    );

    let putCount = 0;
    const mockFetch = vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (input.includes('/readme') && method === 'GET') {
        return new Response(JSON.stringify({ sha: 'readme-sha' }), { status: 200 });
      }
      if (input.includes('/contents/availability.json') && method === 'GET') {
        return new Response(
          JSON.stringify(putCount > 0 ? { sha: `sha-${putCount}` } : { message: 'Not Found' }),
          { status: putCount > 0 ? 200 : 404 }
        );
      }
      if (input.includes('/contents/availability.json') && method === 'PUT') {
        putCount += 1;
        return new Response(JSON.stringify({ commit: { sha: `commit-${putCount}` } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    let currentNow = new Date('2026-11-23T15:00:00Z');
    const app = createExpressApp({
      dbManager,
      config,
      fetchFn: mockFetch,
      getNow: () => currentNow,
    });

    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      // Seed an item and configure Automatic Sync with 15-minute quiet delay
      const itemResp = await fetch(`${baseUrl}/api/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Standard Eggs',
          unitLabel: 'dozens',
          supplyMode: 'continuous',
          defaultDailyProduction: 12,
          globalSafetyBuffer: 4,
          includeInPublicSnippet: true,
        }),
      });
      expect(itemResp.status).toBe(201);
      const createdItem = (await itemResp.json()) as { id: number };

      await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubPublishRepo: 'myfarm/avail',
          githubPublishMode: 'auto',
          githubPublishInterval: '30m',
          githubPublishIdleMinutes: 15,
        }),
      });

      // 1. Manual initial publish at 15:00 UTC succeeds immediately
      const manualRes = await publishSnippetSnapshotToGithub({
        dbManager,
        config,
        force: true,
        now: currentNow,
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      expect(manualRes.published).toBe(true);
      expect(putCount).toBe(1);
      expect(manualRes.githubPublishStatus.hasUnpublishedEdits).toBe(false);
      const publishedAtBeforeMidnight = manualRes.githubPublishStatus.lastPublishedAt;

      // 2. Midnight rollover (next day 05:05 UTC / 00:05 EST) with ZERO user edits -> MUST SKIP!
      const nextDayMidnight = new Date('2026-11-24T05:05:00Z');
      const midnightRes = await publishSnippetSnapshotToGithub({
        dbManager,
        config,
        force: false,
        requireUserEdit: true,
        now: nextDayMidnight,
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      expect(midnightRes.published).toBe(false);
      expect(midnightRes.skipped).toBe(true);
      expect(midnightRes.reason).toMatch(/midnight|no user edits/i);
      expect(putCount).toBe(1); // Zero GitHub writes!
      expect(dbManager.getSettings().githubLastPublishedAt).toBe(publishedAtBeforeMidnight);

      // 3. User edits morning inventory at 14:00 UTC -> marks availabilityLastEditedAt
      currentNow = new Date('2026-11-24T14:00:00Z');
      const supplyResp = await fetch(`${baseUrl}/api/supply/${createdItem.id}/2026-11-24`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actualOnHand: 40, estProduced: 12 }),
      });
      expect(supplyResp.status).toBe(200);
      expect(dbManager.getSettings().availabilityLastEditedAt).toBe('2026-11-24T14:00:00.000Z');

      // 4. Auto-publish check 5 minutes later (still within 15-min quiet delay) -> MUST DEFER!
      const midEditRes = await publishSnippetSnapshotToGithub({
        dbManager,
        config,
        force: false,
        requireUserEdit: true,
        now: new Date('2026-11-24T14:05:00Z'),
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      expect(midEditRes.published).toBe(false);
      expect(midEditRes.skipped).toBe(true);
      expect(midEditRes.retryAfterMs).toBe(10 * 60 * 1000);
      expect(midEditRes.githubPublishStatus.hasUnpublishedEdits).toBe(true);
      expect(putCount).toBe(1);

      // 5. Auto-publish check after 16 quiet minutes -> PUBLISHES cleanly!
      const settledRes = await publishSnippetSnapshotToGithub({
        dbManager,
        config,
        force: false,
        requireUserEdit: true,
        now: new Date('2026-11-24T14:16:00Z'),
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      expect(settledRes.published).toBe(true);
      expect(settledRes.skipped).toBe(false);
      expect(putCount).toBe(2);
      expect(settledRes.githubPublishStatus.hasUnpublishedEdits).toBe(false);
      expect(settledRes.githubPublishStatus.lastPublishedAt).toBe('2026-11-24T14:16:00.000Z');

      // 6. Another midnight rollover the following night -> STILL SKIPPED!
      const nextNightRes = await publishSnippetSnapshotToGithub({
        dbManager,
        config,
        force: false,
        requireUserEdit: true,
        now: new Date('2026-11-25T05:10:00Z'),
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      expect(nextNightRes.published).toBe(false);
      expect(nextNightRes.skipped).toBe(true);
      expect(putCount).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      dbManager.close();
    }
  });

  it('never bumps "Availability accurate as of" at midnight (e.g. 12:25 AM EST) from non-availability edits, stale pending flags, or delayed auto-publishes', async () => {
    const { dbPath, backupDir } = createTempPaths();
    const dbManager = new DatabaseManager(dbPath, backupDir);
    await dbManager.init('America/New_York');

    const config = loadRuntimeConfig({
      dbPath,
      backupDir,
      haOptionsPath: '/nonexistent/options.json',
      githubPublish: {
        token: 'ghp_midnight_token',
        defaultRepo: 'myfarm/avail',
        source: 'env',
      },
    });

    const pushedPayloads: Array<{ generatedAtDisplay: string; generatedAtIso: string }> = [];
    const mockFetch = vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (input.includes('/readme') && method === 'GET') {
        return new Response(JSON.stringify({ sha: 'readme-sha' }), { status: 200 });
      }
      if (input.includes('/contents/availability.json') && method === 'GET') {
        return new Response(
          JSON.stringify(
            pushedPayloads.length > 0
              ? { sha: `sha-${pushedPayloads.length}` }
              : { message: 'Not Found' }
          ),
          { status: pushedPayloads.length > 0 ? 200 : 404 }
        );
      }
      if (input.includes('/contents/availability.json') && method === 'PUT') {
        const parsedBody = JSON.parse(String(init?.body ?? '{}')) as { content: string };
        const decoded = JSON.parse(
          Buffer.from(parsedBody.content, 'base64').toString('utf-8')
        ) as { generatedAtDisplay: string; generatedAtIso: string };
        pushedPayloads.push(decoded);
        return new Response(JSON.stringify({ commit: { sha: `commit-${pushedPayloads.length}` } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    // Nov 25, 2026 at 2:00 PM EST (19:00 UTC)
    let currentNow = new Date('2026-11-25T19:00:00Z');
    const app = createExpressApp({
      dbManager,
      config,
      fetchFn: mockFetch,
      getNow: () => currentNow,
    });

    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const itemResp = await fetch(`${baseUrl}/api/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Standard Eggs',
          unitLabel: 'dozens',
          supplyMode: 'continuous',
          defaultDailyProduction: 12,
          globalSafetyBuffer: 4,
          includeInPublicSnippet: true,
        }),
      });
      const createdItem = (await itemResp.json()) as { id: number };

      await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubPublishRepo: 'myfarm/avail',
          githubPublishMode: 'auto',
          githubPublishInterval: '30m',
          githubPublishIdleMinutes: 15,
        }),
      });

      // 1. Initial manual publish at 2:00 PM EST on Nov 25
      const initialPub = await publishSnippetSnapshotToGithub({
        dbManager,
        config,
        force: true,
        now: currentNow,
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      expect(initialPub.published).toBe(true);
      expect(pushedPayloads).toHaveLength(1);
      expect(pushedPayloads[0].generatedAtDisplay).toContain('Nov 25, 2026');
      expect(pushedPayloads[0].generatedAtDisplay).toContain('2:00 PM');

      // 2. At 6:00 PM EST, user adds an unslotted waitlist order and edits its notes
      //    (does NOT change public availability numbers)
      currentNow = new Date('2026-11-25T23:00:00Z');
      const addOrderResp = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Waitlist Wendy',
          status: 'waitlist',
          timingType: 'asap',
          notes: 'Call before pickup',
          items: [{ trackedItemId: createdItem.id, quantity: 2 }],
        }),
      });
      expect(addOrderResp.status).toBe(201);
      const addedOrder = (await addOrderResp.json()) as { id: number };

      await fetch(`${baseUrl}/api/orders/${addedOrder.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'Updated note only' }),
      });

      // Public availability didn't change -> availabilityLastEditedAt must NOT advance!
      expect(dbManager.getSettings().availabilityLastEditedAt).toBe('2026-11-25T19:00:00.000Z');

      // 3. Midnight tick at 12:25 AM EST on Nov 26 (2026-11-26T05:25:00Z) -> MUST SKIP!
      const midnightTick1 = await publishSnippetSnapshotToGithub({
        dbManager,
        config,
        force: false,
        requireUserEdit: true,
        now: new Date('2026-11-26T05:25:00Z'),
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      expect(midnightTick1.published).toBe(false);
      expect(midnightTick1.skipped).toBe(true);
      expect(pushedPayloads).toHaveLength(1);

      // 4. Simulate a pre-upgrade DB that already had a stale availabilityLastEditedAt from 8:00 PM
      //    with NO semantic change -> the 8:25 PM check skips AND clears the stale flag so
      //    12:25 AM EST still skips cleanly!
      dbManager.updateSettings({ availabilityLastEditedAt: '2026-11-26T01:00:00.000Z' });
      const sameEveningSkip = await publishSnippetSnapshotToGithub({
        dbManager,
        config,
        force: false,
        requireUserEdit: true,
        now: new Date('2026-11-26T01:25:00Z'),
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      expect(sameEveningSkip.published).toBe(false);
      expect(sameEveningSkip.skipped).toBe(true);
      expect(sameEveningSkip.githubPublishStatus.hasUnpublishedEdits).toBe(false);

      const midnightTick2 = await publishSnippetSnapshotToGithub({
        dbManager,
        config,
        force: false,
        requireUserEdit: true,
        now: new Date('2026-11-26T05:25:00Z'),
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      expect(midnightTick2.published).toBe(false);
      expect(midnightTick2.skipped).toBe(true);
      expect(pushedPayloads).toHaveLength(1);

      // 5. Real inventory edit at 11:55 PM EST on Nov 25 (2026-11-26T04:55:00Z) auto-published
      //    after quiet delay at 12:25 AM EST on Nov 26 (2026-11-26T05:25:00Z):
      //    MUST publish the real change, and "accurate as of" MUST show 11:55 PM (edit time), NOT 12:25 AM!
      currentNow = new Date('2026-11-26T04:55:00Z');
      const supplyEditResp = await fetch(`${baseUrl}/api/supply/${createdItem.id}/2026-11-27`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actualOnHand: 50, estProduced: 12 }),
      });
      expect(supplyEditResp.status).toBe(200);
      expect(dbManager.getSettings().availabilityLastEditedAt).toBe('2026-11-26T04:55:00.000Z');

      const afterRealEditPub = await publishSnippetSnapshotToGithub({
        dbManager,
        config,
        force: false,
        requireUserEdit: true,
        now: new Date('2026-11-26T05:25:00Z'),
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      expect(afterRealEditPub.published).toBe(true);
      expect(pushedPayloads).toHaveLength(2);
      expect(pushedPayloads[1].generatedAtDisplay).toContain('Nov 25, 2026');
      expect(pushedPayloads[1].generatedAtDisplay).toContain('11:55 PM');
      expect(pushedPayloads[1].generatedAtDisplay).not.toContain('12:25 AM');

      // 6. Real edit followed by reverting back to published state immediately clears pending edits
      currentNow = new Date('2026-11-26T15:00:00Z');
      await fetch(`${baseUrl}/api/supply/${createdItem.id}/2026-11-27`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actualOnHand: 99, estProduced: 12 }),
      });
      expect(dbManager.getSettings().availabilityLastEditedAt).toBe('2026-11-26T15:00:00.000Z');

      currentNow = new Date('2026-11-26T15:01:00Z');
      await fetch(`${baseUrl}/api/supply/${createdItem.id}/2026-11-27`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actualOnHand: 50, estProduced: 12 }),
      });
      expect(dbManager.getSettings().availabilityLastEditedAt).toBe(
        afterRealEditPub.githubPublishStatus.lastPublishedAt
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      dbManager.close();
    }
  });
});
