import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import * as sinon from 'sinon';

import BenchmarkSession from '../../lib/benchmark.js';

function makeCli() {
  return {
    SPINNER_STATUS: { SUCCESS: 'success', FAILED: 'failed' },
    startSpinner: sinon.stub(),
    stopSpinner: sinon.stub(),
    updateSpinner: sinon.stub(),
    separator: sinon.stub(),
    table: sinon.stub(),
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
    log: sinon.stub(),
    prompt: sinon.stub().resolves(true),
    promptCheckbox: sinon.stub()
  };
}

const pr = {
  number: 123,
  head: {
    sha: 'deadbeef',
    repo: { full_name: 'nodejs/node' }
  },
  base: {
    ref: 'main',
    repo: { full_name: 'nodejs/node' }
  }
};

const contents = [
  { type: 'dir', name: 'buffers' },
  { type: 'dir', name: 'url' },
  { type: 'dir', name: 'fixtures' },
  { type: 'file', name: '_http-benchmarkers.js' }
];

function makeRequest() {
  return {
    getPullRequest: sinon.stub().resolves(pr),
    listDirectory: sinon.stub().resolves(contents),
    dispatchWorkflow: sinon.stub().resolves({ ok: true })
  };
}

describe('BenchmarkSession', () => {
  let cli;
  let request;
  const baseArgv = { owner: 'nodejs', repo: 'node', prid: 123, ref: 'main' };

  beforeEach(() => {
    cli = makeCli();
    request = makeRequest();
  });

  it('lists categories excluding fixtures and non-dir entries', async() => {
    cli.promptCheckbox.resolves(['buffers']);
    const session = new BenchmarkSession(cli, request, { ...baseArgv });
    await session.start();

    const [, choices] = cli.promptCheckbox.firstCall.args;
    assert.deepStrictEqual(choices.map((c) => c.value), ['buffers', 'url']);
    assert.ok(request.listDirectory.calledOnce);
    assert.deepStrictEqual(request.listDirectory.firstCall.args[0], {
      owner: 'nodejs',
      repo: 'node',
      path: 'benchmark',
      ref: 'deadbeef'
    });
  });

  it('dispatches the workflow with the selected categories', async() => {
    cli.promptCheckbox.resolves(['buffers', 'url']);
    const session = new BenchmarkSession(cli, request, { ...baseArgv });
    await session.start();

    assert.ok(request.dispatchWorkflow.calledOnce);
    const [workflow, opts] = request.dispatchWorkflow.firstCall.args;
    assert.strictEqual(workflow, 'benchmark.yml');
    assert.strictEqual(opts.owner, 'nodejs');
    assert.strictEqual(opts.repo, 'node');
    assert.strictEqual(opts.ref, 'main');
    assert.deepStrictEqual(opts.inputs, {
      pr_id: '123',
      commit: 'deadbeef',
      category: 'buffers url'
    });
  });

  it('sets repo input when the workflow lives in another repository', async() => {
    const session = new BenchmarkSession(cli, request, {
      ...baseArgv,
      category: ['buffers'],
      workflowOwner: 'aduh95-evals',
      workflowRepo: 'node',
      filter: 'net',
      runs: 10
    });
    await session.start();

    const [, opts] = request.dispatchWorkflow.firstCall.args;
    assert.strictEqual(opts.owner, 'aduh95-evals');
    assert.deepStrictEqual(opts.inputs, {
      pr_id: '123',
      commit: 'deadbeef',
      category: 'buffers',
      repo: 'nodejs/node',
      filter: 'net',
      runs: '10'
    });
    assert.ok(cli.promptCheckbox.notCalled);
  });

  it('throws on unknown categories passed via --category', async() => {
    const session = new BenchmarkSession(cli, request, {
      ...baseArgv,
      category: ['nonexistent']
    });
    await assert.rejects(session.start(), /__ignore__/);
    assert.ok(request.dispatchWorkflow.notCalled);
  });

  it('does not dispatch when the confirmation prompt is declined', async() => {
    cli.promptCheckbox.resolves(['buffers']);
    cli.prompt.resolves(false);
    const session = new BenchmarkSession(cli, request, { ...baseArgv });
    await assert.rejects(session.start(), /__ignore__/);
    assert.ok(request.dispatchWorkflow.notCalled);
  });
});
