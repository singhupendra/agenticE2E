import { describe, it, expect } from 'vitest';
import { buildRunnerEnv } from '../src/core/runner.js';

describe('runner env allowlist', () => {
  it('drops secrets and unknown vars, keeps PATH/HOME and sets AGENTIC_E2E_*', () => {
    const env = buildRunnerEnv(
      { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-secret', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 't', AGENTIC_E2E_MODEL: 'm', LANG: 'en_US.UTF-8', PLAYWRIGHT_BROWSERS_PATH: '/pw' },
      { AGENTIC_E2E_SCREENSHOTS: 'off' },
    );
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/h');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe('/pw');
    expect(env.AGENTIC_E2E_SCREENSHOTS).toBe('off');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AGENTIC_E2E_MODEL).toBeUndefined();
  });
});
