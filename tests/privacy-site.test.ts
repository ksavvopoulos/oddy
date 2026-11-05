import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/storage';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = mkdtempSync(join(tmpdir(), 'oddy-policy-site-'));
const policy = readFileSync(new URL('../docs/privacy.md', import.meta.url), 'utf8');
let home: string;
let privacy: string;

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-site.mjs', '--out-dir', output], {
    cwd: root,
    stdio: 'pipe'
  });
  home = readFileSync(join(output, 'index.html'), 'utf8');
  privacy = readFileSync(join(output, 'privacy', 'index.html'), 'utf8');
});
afterAll(() => rmSync(output, { recursive: true, force: true }));

describe('published privacy site', () => {
  it('builds only the intended static pages, not the rest of the repo or store screenshots', () => {
    expect(readdirSync(output).sort()).toEqual(['.nojekyll', 'index.html', 'privacy']);
    expect(privacy).toContain('<h1>Oddy Privacy Policy</h1>');
    expect(home).toContain('Oddy — Your Dataverse Raven');
    expect(privacy).toContain('name="viewport"');
    expect(privacy).toContain('lang="en"');
  });

  it('uses project-relative navigation suitable for /oddy/privacy/', () => {
    expect(home).toContain('href="./privacy/"');
    expect(privacy).toContain('href="../"');
    expect(privacy).toContain('href="./"');
  });

  it('contains no forms, added JavaScript, analytics requests or third-party assets', () => {
    for (const page of [home, privacy]) {
      expect(page).not.toMatch(/<script\b|<iframe\b|<form\b|<img\b|\bsrc=|@import|url\(/i);
      expect(page).toContain('name="referrer" content="no-referrer"');
    }
  });

  it('discloses local handling, Azure transmission, storage risks and support/hosting exceptions', () => {
    expect(policy).toContain(
      'does not send your prompts, Dataverse records, API key, or conversation history to a backend operated by the Oddy publisher'
    );
    expect(policy).toContain('Azure OpenAI endpoint you configured');
    expect(policy).toContain('not independently encrypted by Oddy');
    expect(policy).toContain('even if conversation history is off');
    expect(policy).toContain('not a universal access-control rule');
    expect(policy).toContain('Limited Use');
    expect(policy).toContain('GitHub may process visitor IP addresses');
    expect(policy).toContain('Public issues are visible to others');
    expect(policy).not.toMatch(/never leaves your device|zero data handling|encrypted at rest/i);
  });

  it('documents the current opt-in history defaults', () => {
    expect(DEFAULT_SETTINGS.conversationHistory.enabled).toBe(false);
    expect(policy).toContain(`${DEFAULT_SETTINGS.conversationHistory.retentionDays} days`);
    expect(policy).toContain(
      `${DEFAULT_SETTINGS.conversationHistory.maxConversations} conversations`
    );
  });

  it('deploys only from main with separate build and minimal deployment permissions', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/pages.yml', import.meta.url),
      'utf8'
    );
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('path: .output/site');
    expect(workflow).toContain('needs: build');
    expect(workflow).toContain('pages: write');
    expect(workflow).toContain('id-token: write');
    expect(workflow).not.toContain('contents: write');
    for (const match of workflow.matchAll(/uses: (\S+)/g)) {
      expect(match[1]).toMatch(/^actions\/[\w-]+@[a-f0-9]{40}$/);
    }
  });
});
