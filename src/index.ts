import { initOctokit } from './github.js';
import { runChecks } from './runner.js';

const main = async (): Promise<void> => {
  const token = process.env.GH_TOKEN;
  if (!token) {
    console.error('❌ Error: GH_TOKEN is not set');
    process.exit(1);
  }

  initOctokit(token);
  console.log('✅ GitHub authentication initialized\n');

  await runChecks();
};

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
