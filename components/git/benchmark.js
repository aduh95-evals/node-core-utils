import auth from '../../lib/auth.js';
import { parsePRFromURL } from '../../lib/links.js';
import CLI from '../../lib/cli.js';
import Request from '../../lib/request.js';
import { runPromise } from '../../lib/run.js';
import BenchmarkSession from '../../lib/benchmark.js';

export const command = 'benchmark <identifier>';
export const describe =
  'Trigger the benchmark GitHub Actions workflow for a pull request';

const options = {
  owner: {
    alias: 'o',
    describe: 'GitHub owner of the PR repository',
    default: 'nodejs',
    type: 'string'
  },
  repo: {
    alias: 'r',
    describe: 'GitHub repository of the PR',
    default: 'node',
    type: 'string'
  },
  'workflow-owner': {
    describe: 'GitHub owner of the repository hosting the benchmark workflow ' +
      '(defaults to the PR owner)',
    type: 'string'
  },
  'workflow-repo': {
    describe: 'GitHub repository hosting the benchmark workflow ' +
      '(defaults to the PR repository)',
    type: 'string'
  },
  workflow: {
    describe: 'The workflow file to dispatch',
    default: 'benchmark.yml',
    type: 'string'
  },
  ref: {
    describe: 'The git ref of the workflow repository to run the workflow from',
    default: 'main',
    type: 'string'
  },
  filter: {
    describe: 'A substring to restrict the benchmarks to run in a category',
    type: 'string'
  },
  runs: {
    describe: 'How many times to repeat each benchmark',
    type: 'number'
  }
};

let yargsInstance;

export function builder(yargs) {
  yargsInstance = yargs;
  return yargs
    .options(options)
    .positional('identifier', {
      type: 'string',
      describe: 'ID or URL of the pull request'
    })
    .example('git node benchmark 12344',
      'Pick benchmark categories to run on ' +
      'https://github.com/nodejs/node/pull/12344')
    .example('git node benchmark https://github.com/nodejs/node/pull/12344',
      'Pick benchmark categories to run on ' +
      'https://github.com/nodejs/node/pull/12344')
    .wrap(90);
}

export function handler(argv) {
  const prid = Number.parseInt(argv.identifier);
  if (!Number.isNaN(prid)) {
    argv.prid = prid;
  } else {
    const parsed = parsePRFromURL(argv.identifier);
    if (!parsed) {
      return yargsInstance.showHelp();
    }
    Object.assign(argv, parsed);
  }

  return runPromise(main(argv));
}

async function main(argv) {
  const cli = new CLI(process.stderr);
  const credentials = await auth({ github: true });
  const request = new Request(credentials);
  const session = new BenchmarkSession(cli, request, argv);
  return session.start();
}
