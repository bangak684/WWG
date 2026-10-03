if (process.platform === 'win32') {
  const { buildWindowsRunner } = await import('./build-windows-runner.mjs');
  await buildWindowsRunner();
}
