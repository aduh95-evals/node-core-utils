import { getPrURL } from './links.js';
import { IGNORE } from './run.js';

const BENCHMARK_DIR = 'benchmark';
// Entries in the benchmark folder that are not benchmark categories.
const NON_CATEGORY_DIRS = new Set(['fixtures']);

export default class BenchmarkSession {
  constructor(cli, request, argv) {
    this.cli = cli;
    this.request = request;
    this.argv = argv;
    this.workflow = argv.workflow || 'benchmark.yml';
  }

  get prUrl() {
    const { owner, repo, prid } = this.argv;
    return getPrURL({ owner, repo, prid });
  }

  async getPullRequest() {
    const { cli } = this;
    cli.startSpinner(`Fetching data for ${this.prUrl}`);
    const pr = await this.request.getPullRequest(this.prUrl);
    if (!pr || !pr.head) {
      cli.stopSpinner(
        `Could not find pull request ${this.prUrl}`,
        cli.SPINNER_STATUS.FAILED);
      throw new Error(IGNORE);
    }
    cli.stopSpinner(`Fetched data for ${this.prUrl}`);
    this.pr = pr;
    return pr;
  }

  async getCategories() {
    const { cli, pr } = this;
    const head = pr.head;
    // Prefer listing the benchmark folder on the PR head, falling back to the
    // base branch if the head repository is unavailable (e.g. deleted fork).
    const source = head.repo
      ? { fullName: head.repo.full_name, ref: head.sha }
      : { fullName: pr.base.repo.full_name, ref: pr.base.ref };
    const [owner, repo] = source.fullName.split('/');

    cli.startSpinner('Fetching available benchmark categories');
    let entries;
    try {
      entries = await this.request.listDirectory({
        owner,
        repo,
        path: BENCHMARK_DIR,
        ref: source.ref
      });
    } catch (e) {
      cli.stopSpinner(
        'Could not fetch benchmark categories',
        cli.SPINNER_STATUS.FAILED);
      throw e;
    }

    const categories = entries
      .filter((entry) => entry.type === 'dir')
      .map((entry) => entry.name)
      .filter((name) => !NON_CATEGORY_DIRS.has(name))
      .sort();

    if (categories.length === 0) {
      cli.stopSpinner(
        `No benchmark categories found in ${source.fullName}/${BENCHMARK_DIR}`,
        cli.SPINNER_STATUS.FAILED);
      throw new Error(IGNORE);
    }

    cli.stopSpinner(`Found ${categories.length} benchmark categories`);
    this.categories = categories;
    return categories;
  }

  async promptCategories() {
    const { cli, argv, categories } = this;

    if (Array.isArray(argv.category) && argv.category.length) {
      const invalid = argv.category.filter((c) => !categories.includes(c));
      if (invalid.length) {
        cli.error(`Unknown benchmark categories: ${invalid.join(', ')}`);
        throw new Error(IGNORE);
      }
      return argv.category;
    }

    const selected = await cli.promptCheckbox(
      'Select the benchmark categories to run:',
      categories.map((name) => ({ name, value: name })));

    if (!selected || selected.length === 0) {
      cli.warn('No benchmark category selected, aborting.');
      throw new Error(IGNORE);
    }
    return selected;
  }

  async start() {
    const { cli, argv } = this;

    await this.getPullRequest();
    await this.getCategories();
    const selected = await this.promptCategories();

    const workflowOwner = argv.workflowOwner || argv.owner;
    const workflowRepo = argv.workflowRepo || argv.repo;
    const category = selected.join(' ');

    const inputs = {
      pr_id: `${argv.prid}`,
      commit: this.pr.head.sha,
      category
    };
    // The benchmark workflow checks out `inputs.repo || github.repository`; only
    // set it when the workflow lives in a different repository than the PR.
    const prRepo = `${argv.owner}/${argv.repo}`;
    if (`${workflowOwner}/${workflowRepo}` !== prRepo) {
      inputs.repo = prRepo;
    }
    if (argv.filter) {
      inputs.filter = argv.filter;
    }
    if (argv.runs != null) {
      inputs.runs = `${argv.runs}`;
    }

    cli.separator('Benchmark');
    cli.table('PR:', this.prUrl);
    cli.table('Commit:', this.pr.head.sha);
    cli.table('Categories:', category);
    if (inputs.filter) cli.table('Filter:', inputs.filter);
    if (inputs.runs) cli.table('Runs:', inputs.runs);
    cli.table('Workflow:',
      `${workflowOwner}/${workflowRepo} (${this.workflow}@${argv.ref})`);

    const confirmed = await cli.prompt(
      'Trigger the benchmark workflow with these settings?',
      { defaultAnswer: true });
    if (!confirmed) {
      cli.warn('Aborted, no workflow was triggered.');
      throw new Error(IGNORE);
    }

    cli.startSpinner('Dispatching benchmark workflow');
    await this.request.dispatchWorkflow(this.workflow, {
      owner: workflowOwner,
      repo: workflowRepo,
      ref: argv.ref,
      inputs
    });
    cli.stopSpinner('Benchmark workflow dispatched');
    cli.info('Follow the run at ' +
      `https://github.com/${workflowOwner}/${workflowRepo}/actions/` +
      `workflows/${this.workflow}`);
  }
}
