import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Writes throwaway AWS config/credentials files and returns env vars pointing at them. */
export function fakeAwsFiles(config?: string, credentials?: string): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-'));
  const env: Record<string, string> = {
    AWS_CONFIG_FILE: path.join(dir, 'config'),
    AWS_SHARED_CREDENTIALS_FILE: path.join(dir, 'credentials'),
  };
  if (config !== undefined) fs.writeFileSync(env.AWS_CONFIG_FILE, config);
  if (credentials !== undefined) fs.writeFileSync(env.AWS_SHARED_CREDENTIALS_FILE, credentials);
  return env;
}

export const SAMPLE_CONFIG = `
[default]
region = us-east-1

[profile dev]
region = eu-west-1
output = json

[profile weird-region]
region = not a region

[sso-session s]
sso_start_url = https://example.awsapps.com/start

[services x]
dynamodb =
  endpoint_url = http://localhost:8000
`;

export const SAMPLE_CREDENTIALS = `
# a comment
[dev]
aws_access_key_id = AKIAFAKEFAKEFAKE
aws_secret_access_key = SUPERSECRETVALUE123

[ci]
aws_access_key_id = AKIAOTHERFAKE
aws_secret_access_key = ANOTHERSECRET456
`;
