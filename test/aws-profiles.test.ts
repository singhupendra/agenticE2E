import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { awsProfileRegion, listAwsProfiles } from '../src/core/aws-profiles.js';
import { fakeAwsFiles, SAMPLE_CONFIG, SAMPLE_CREDENTIALS } from './helpers/aws-files.js';

describe('AWS profile discovery (SPEC-003)', () => {
  it('AC-4: lists profiles from config and credentials, ignoring non-profile sections', () => {
    const env = fakeAwsFiles(SAMPLE_CONFIG, SAMPLE_CREDENTIALS);
    expect(listAwsProfiles(env)).toEqual(['ci', 'default', 'dev', 'weird-region']);
  });

  it('AC-5: missing files -> []; env vars choose the file paths', () => {
    expect(listAwsProfiles(fakeAwsFiles())).toEqual([]);
    expect(listAwsProfiles({ AWS_CONFIG_FILE: path.join('/nonexistent', 'x'), AWS_SHARED_CREDENTIALS_FILE: path.join('/nonexistent', 'y') })).toEqual([]);
    expect(listAwsProfiles(fakeAwsFiles('[profile only-config]\n'))).toEqual(['only-config']);
    expect(listAwsProfiles(fakeAwsFiles(undefined, '[only-creds]\n'))).toEqual(['only-creds']);
  });

  it('AC-6: never returns secrets', () => {
    const out = JSON.stringify(listAwsProfiles(fakeAwsFiles(SAMPLE_CONFIG, SAMPLE_CREDENTIALS)));
    expect(out).not.toMatch(/SUPERSECRET|ANOTHERSECRET|AKIA/);
  });

  it('reads a profile region from the config file (region-shaped only)', () => {
    const env = fakeAwsFiles(SAMPLE_CONFIG, SAMPLE_CREDENTIALS);
    expect(awsProfileRegion('dev', env)).toBe('eu-west-1');
    expect(awsProfileRegion('default', env)).toBe('us-east-1');
    expect(awsProfileRegion('weird-region', env)).toBeUndefined();
    expect(awsProfileRegion('ci', env)).toBeUndefined();
    expect(awsProfileRegion('ghost', env)).toBeUndefined();
  });
});
