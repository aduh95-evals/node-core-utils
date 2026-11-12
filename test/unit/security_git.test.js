import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import PrepareSecurityRelease from '../../lib/prepare_security.js';
import { writeSecurityReleaseDraft } from '../../lib/security-release/draft.js';

import {
  checkoutOnSecurityReleaseBranch,
  stageSecurityReleaseChanges,
  NEXT_SECURITY_RELEASE_REPOSITORY
} from '../../lib/security-release/security-release.js';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repository(t) {
  const previous = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ncu-security-git-'));
  t.after(() => {
    process.chdir(previous);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  process.chdir(directory);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(directory, 'no-hooks'));
  git('commit', '--allow-empty', '-m', 'Initial commit');
  git('remote', 'add', 'origin', 'https://github.com/nodejs-private/security-release.git');
  return directory;
}

const cli = { info() {}, ok() {}, prompt: async() => true };

describe('security release git state', { concurrency: false }, () => {
  it('creates a new release branch from the current HEAD', async(t) => {
    repository(t);
    const head = git('rev-parse', 'HEAD');
    await checkoutOnSecurityReleaseBranch(cli, NEXT_SECURITY_RELEASE_REPOSITORY);
    assert.strictEqual(git('branch', '--show-current'), 'next-security-release');
    assert.strictEqual(git('rev-parse', 'HEAD'), head);
  });

  it('checks out an existing release branch without resetting it', async(t) => {
    repository(t);
    const releaseHead = git('rev-parse', 'HEAD');
    git('branch', 'next-security-release');
    git('commit', '--allow-empty', '-m', 'Unrelated work');
    assert.notStrictEqual(git('rev-parse', 'HEAD'), releaseHead);

    await checkoutOnSecurityReleaseBranch(cli, NEXT_SECURITY_RELEASE_REPOSITORY);

    assert.strictEqual(git('branch', '--show-current'), 'next-security-release');
    assert.strictEqual(git('rev-parse', 'HEAD'), releaseHead);
  });

  it('starts from an existing remote-tracking release branch', async(t) => {
    repository(t);
    const releaseHead = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/next-security-release', releaseHead);
    git('commit', '--allow-empty', '-m', 'Unrelated work');

    await checkoutOnSecurityReleaseBranch(cli, NEXT_SECURITY_RELEASE_REPOSITORY);

    assert.strictEqual(git('rev-parse', 'HEAD'), releaseHead);
    assert.strictEqual(
      git('rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/next-security-release');
  });

  it('rejects unrelated staged work before staging the release file', async(t) => {
    repository(t);
    fs.writeFileSync('unrelated notes.txt', 'User work\n');
    git('add', 'unrelated notes.txt');
    fs.writeFileSync('vulnerabilities.json', '{}\n');
    const index = git('write-tree');
    const head = git('rev-parse', 'HEAD');
    await assert.rejects(stageSecurityReleaseChanges(
      'vulnerabilities.json', 'Prepare release',
      { cli, repository: NEXT_SECURITY_RELEASE_REPOSITORY }
    ), /Unrelated staged changes/);
    assert.strictEqual(git('write-tree'), index);
    assert.strictEqual(git('rev-parse', 'HEAD'), head);
    assert.strictEqual(fs.readFileSync('unrelated notes.txt', 'utf8'), 'User work\n');
  });

  it('stages release files with a pre-filled commit message', async(t) => {
    repository(t);
    fs.mkdirSync('security-release');
    fs.writeFileSync('security-release/vulnerabilities.json', '{}\n');
    git('add', 'security-release/vulnerabilities.json');
    fs.writeFileSync('security-release/notes.md', 'Notes\n');
    const head = git('rev-parse', 'HEAD');
    await stageSecurityReleaseChanges(
      'security-release', 'Prepare release', {
        cli: { ...cli, prompt: async() => assert.fail('Staging must not prompt') },
        repository: NEXT_SECURITY_RELEASE_REPOSITORY
      }
    );
    assert.strictEqual(git('rev-parse', 'HEAD'), head);
    assert.strictEqual(git('diff', '--cached', '--name-only'),
      'security-release/notes.md\nsecurity-release/vulnerabilities.json');
    const messagePath = git('rev-parse', '--git-path', 'MERGE_MSG');
    assert.strictEqual(fs.readFileSync(messagePath, 'utf8'), 'Prepare release\n');

    fs.writeFileSync('security-release/vulnerabilities.json', '[]\n');
    await stageSecurityReleaseChanges(
      'security-release', 'Update release', {
        cli, repository: NEXT_SECURITY_RELEASE_REPOSITORY
      }
    );
    assert.strictEqual(fs.readFileSync(messagePath, 'utf8'),
      'Prepare release\nUpdate release\n');
  });

  it('rejects an existing draft before prompting or fetching reports', async(t) => {
    const dir = repository(t);
    const file = writeSecurityReleaseDraft(dir, { releaseDate: 'TBD', reports: [] });
    const before = fs.readFileSync(file);
    const release = new PrepareSecurityRelease({
      prompt() { assert.fail('Existing releases must not start again'); }
    });
    await assert.rejects(release.start(), /draft already exists/);
    assert.strictEqual(git('branch', '--show-current'), 'main');
    assert.deepStrictEqual(fs.readFileSync(file), before);
  });

  it('preserves Git state if draft preparation fails', async(t) => {
    repository(t);
    const release = new PrepareSecurityRelease(cli);
    release.chooseReports = async() => [];
    release.getDependencyUpdates = async() => {
      throw new Error('Preparation interrupted');
    };
    await assert.rejects(
      release.startVulnerabilitiesJSONCreation('TBD', 'Release'), /Preparation interrupted/);
    assert.strictEqual(git('branch', '--show-current'), 'main');
    assert.strictEqual(git('branch', '--list', 'next-security-release'), '');
    assert.strictEqual(git('status', '--porcelain'), '');
  });

  it('preserves a draft discovered on the existing release branch', async(t) => {
    const dir = repository(t);
    git('checkout', '-b', 'next-security-release');
    const file = writeSecurityReleaseDraft(dir, { releaseDate: 'TBD', reports: [] });
    const before = fs.readFileSync(file);
    git('add', 'security-release');
    git('commit', '-m', 'Existing release');
    const head = git('rev-parse', 'HEAD');
    git('checkout', 'main');
    assert.ok(!fs.existsSync(file));

    const release = new PrepareSecurityRelease(cli);
    release.chooseReports = async() => [];
    release.getDependencyUpdates = async() => ({});
    await assert.rejects(
      release.startVulnerabilitiesJSONCreation('2026-10-06', 'Release'), /draft already exists/);

    assert.deepStrictEqual(fs.readFileSync(file), before);
    assert.strictEqual(git('rev-parse', 'HEAD'), head);
    assert.strictEqual(git('status', '--porcelain'), '');
  });

  it('stages a local draft without committing when publication is declined', async(t) => {
    const dir = repository(t);
    const head = git('rev-parse', 'HEAD');
    const release = new PrepareSecurityRelease({
      ...cli, startSpinner() {}, stopSpinner() {}
    });
    release.chooseReports = async() => [];
    release.getDependencyUpdates = async() => ({
      undici: { affectedVersions: { '24.x': 'https://github.com/nodejs/node/pull/1' } }
    });
    release.promptCreatePR = async() => false;
    release.createPullRequest = async() => assert.fail('Do not publish a local draft');

    await release.startVulnerabilitiesJSONCreation('2026/10/06', 'Release');

    const file = path.join(dir, 'security-release/next-security-release/vulnerabilities.json');
    const draft = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(draft.releaseDate, '2026-10-06');
    assert.deepStrictEqual(draft.reports, []);
    assert.strictEqual(draft.dependencies.undici.affectedVersions['24.x'],
      'https://github.com/nodejs/node/pull/1');
    assert.strictEqual(git('diff', '--cached', '--name-only'),
      'security-release/next-security-release/vulnerabilities.json');
    assert.strictEqual(
      fs.readFileSync(git('rev-parse', '--git-path', 'MERGE_MSG'), 'utf8'),
      'chore: create vulnerabilities.json for next security release\n');
    assert.strictEqual(git('rev-parse', 'HEAD'), head);
    assert.strictEqual(git('branch', '--show-current'), 'next-security-release');
  });
});
