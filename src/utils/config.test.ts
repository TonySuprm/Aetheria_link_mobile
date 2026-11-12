import { Config } from '../types';
import { getConfigWithEnvFallback, getDefaultConfig } from './config';

describe('getDefaultConfig', () => {
  test('has English enabled', () => {
    expect(getDefaultConfig().en).toBe('on');
  });
});

describe('getConfigWithEnvFallback', () => {
  test('normalizes a scheme-less mediaFlowProxyUrl to https', () => {
    const config = getConfigWithEnvFallback({ mediaFlowProxyUrl: 'mediaflow-proxy-light-cloud.onrender.com' } as Config);
    expect(config.mediaFlowProxyUrl).toBe('https://mediaflow-proxy-light-cloud.onrender.com');
  });

  test('normalizes a scheme-less loopback mediaFlowProxyUrl to http', () => {
    const config = getConfigWithEnvFallback({ mediaFlowProxyUrl: '127.0.0.1:8890' } as Config);
    expect(config.mediaFlowProxyUrl).toBe('http://127.0.0.1:8890');
  });
});
